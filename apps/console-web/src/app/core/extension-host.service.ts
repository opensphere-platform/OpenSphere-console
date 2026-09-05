import { Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { HttpService } from './http.service';
import { NotificationService, NotifyInput, OsNotification } from './notification.service';
import {
  extensionRouteBase,
  extensionRouteTarget,
  isTransientExtensionLoadError,
  TRANSIENT_EXTENSION_RETRY_DELAY_MS,
} from './extension-load-order';
import { ExtensionProjectionStore } from './extension-projection.store';
import {
  buildConsoleNavigationSnapshot,
  ConsoleNavigationSnapshot,
  CONSOLE_NAVIGATION_STORAGE_KEY,
  parseStoredConsoleNavigationSnapshot,
} from './console-navigation-snapshot';
import { OS_SHELL_STANDALONE_BOOT } from './boot-mode';
import { normalizeManifest, isKnownCapability } from '@opensphere/console-contracts';
import type { PluginPage, NavNode, SearchProvider, Manifest, ManifestAsset, NormalizedManifest, PluginModule, Capability } from '@opensphere/console-contracts';
export type { PluginPage, NavNode } from '@opensphere/console-contracts';

/**
 * Extension Host — dynamic-ui §5.2의 구현 + manifest v2 보안 계약(§15, 팀장 검토 ② blocker).
 *
 * 신뢰 사슬 (fail-closed — 한 단계라도 실패하면 그 플러그인만 제외):
 *   레지스트리(§5.3, 관리자 통제 ConfigMap = allowlist + 신뢰 루트)
 *     → ① manifest 바이트 sha256 == registry.manifestSha256  (무결성 핀)
 *     → ② manifest 분리 서명을 registry.trustedKeys로 검증   (ECDSA P-256/SHA-256, 출처)
 *     → ③ shellCompat semver 범위에 셸 버전 포함              (호환성)
 *     → ④ permissions 전부 알려진 scope여야 함                (미지 권한 거부)
 *     → ⑤ entry 바이트 sha256 == manifest.entrySha256         (번들 무결성)
 *     → ⑥ 검증된 바이트만 Blob URL로 import                   (TOCTOU 차단)
 *     → ⑦ ctx는 선언·승인된 권한에 해당하는 능력만 노출        (최소 권한)
 *
 * 제약: entry는 자기완결 단일 ESM 파일이어야 한다(Blob import 하에서 상대 import 불가).
 */

export const SHELL_VERSION = '0.3.6';

// 권한 scope 어휘(C1)·PluginPage·NavNode는 versioned Console contract package가 SSOT다.
// 닫힌 집합 검증은 isKnownCapability().

export type PluginLoadState = 'queued' | 'loading' | 'ready' | 'failed';
export type ExtensionLoadStage = 'contract' | 'manifest' | 'signature' | 'entry' | 'assets' | 'activation';
export interface PluginFailure { id: string; error: string; stage: ExtensionLoadStage; retryable: boolean; }
export interface HostChildProjection {
  id: string;
  route: string;
  element: string;
}
export const HOST_API_VERSION = '1.0.0';
const FETCH_TIMEOUT_MS = 15000;

class ExtensionStageError extends Error {
  constructor(readonly stage: ExtensionLoadStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'ExtensionStageError';
  }
}

async function atExtensionStage<T>(stage: ExtensionLoadStage, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ExtensionStageError) throw error;
    throw new ExtensionStageError(stage, error);
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

interface RegistryV3 {
  version: number;
  trustedKeys: Record<string, string>; // keyId → SPKI(base64)
  plugins: RegistryEntry[];
}

interface RegistryEntry {
  id: string;
  manifest: string;
  manifestSha256: string;
  signature: string; // 분리 서명(.sig, base64) URL
  keyId: string;
  kind?: 'subShell' | 'plugin';
  componentKind?: 'subShell' | 'plugin';
  available?: boolean;
  hostRef?: string;
  hostApiVersion?: string;
  hostCompat?: string;
  contributions?: NormalizedManifest['contributions'];
  icon?: string; // 1단 아이콘(Carbon 토큰명) — Console preference가 투영한 표시값. 서명/실행 권위와 무관.
  /** Content-addressed serving coordinate owned by DUPA. It is deliberately
   * separate from the stable API service id so a rollout can never mix old
   * registry pins with new artifact bytes. */
  artifactServiceId?: string;
  releaseRevision?: string;
  retainedArtifactServiceIds?: string[];
}

interface VerifiedAsset {
  declaration: ManifestAsset;
  text: string;
}

export interface ManualContributionDocument {
  id: string;
  title: string;
  content: string;
  route?: string;
  sourcePath?: string;
  documentType?: string;
  tags?: string[];
}

export interface ManualContribution {
  sourceId?: string;
  name?: string;
  authorityTier?: number;
  language?: 'ko' | 'en' | 'mixed';
  documents: ManualContributionDocument[];
}

export interface ManagementInventoryItem {
  id: string;
  title: string;
  navBand: string;
  /** Canonical ownership boundary. Child plugins must not be flattened into Main Shell navigation. */
  hostRef: string;
  kind?: 'subShell' | 'plugin';
  icon?: string;
  order?: number;
  desiredState?: string;
  phase?: string;
}

@Injectable({ providedIn: 'root' })
export class ExtensionHostService {
  private auth = inject(AuthService);
  private http = inject(HttpService);
  private notif = inject(NotificationService);
  private router = inject(Router);
  private projections = inject(ExtensionProjectionStore);
  private readonly cachedNavigationSnapshot = this.readStoredNavigationSnapshot();
  private activeModules = new Map<string, PluginModule>();
  private pageOwners = new Map<string, string>();
  private inFlightLoads = new Map<string, Promise<void>>();
  private registryFingerprint = '';
  private registryWatch?: number;
  private routeWatchStarted = false;
  private registryEntries: RegistryEntry[] = [];
  private trustedKeys: Record<string, string> = {};
  private artifactTextCache = new Map<string, Promise<string>>();
  private hostProjectionDeclarations = new Map<string, readonly HostChildProjection[]>();
  private assetStyles = new Map<string, Set<HTMLStyleElement>>();
  /** A live document is an immutable composition snapshot. Registry changes
   * are discovered immediately but adopted only by a new document so custom
   * elements from two releases are never mixed in one JavaScript realm. */
  readonly registryUpdatePending = signal(false);

  /**
   * PluginHost가 Registry의 비동기 초기 적재를 실제 미등록 상태와 구분할 수 있게 한다.
   * Main Shell first paint는 계속 Registry와 독립적으로 진행하되, deep link가 적재 중
   * 잠깐 나타나는 상태를 설치 실패로 오인하지 않도록 명시적인 lifecycle을 제공한다.
   */
  readonly loadState = signal<'idle' | 'loading' | 'ready'>('idle');
  /**
   * 전역 Registry 적재 상태와 별도로 각 Consumer의 실제 lifecycle을 보존한다.
   * PluginHost는 이 값을 사용해 다른 Extension의 적재를 현재 route의 상태로 오인하지 않는다.
   */
  readonly pluginLoadStates = signal<Record<string, PluginLoadState>>({});
  /**
   * Host-owned presentation metadata. A verified subShell acknowledges each
   * Registry-approved child route and compiled Custom Element name here.
   * The declaration makes navigation available without executing the child;
   * loadOne() still performs signature, digest, permission and activation
   * checks only when that child route is selected.
   */
  readonly hostChildProjections = signal<Record<string, readonly HostChildProjection[]>>({});
  readonly pages = signal<PluginPage[]>([]);
  /** Host-owned projection. Unlike pages, this inventory survives inactive or
   * degraded serving contributions and never causes guest assets to load. */
  readonly managementInventory = signal<ManagementInventoryItem[]>([]);
  /**
   * Atomic, display-only first-level navigation. A validated last-known value
   * is available before any guest executes; a live Registry + control
   * projection replaces it in one signal commit. It never grants execution.
   */
  readonly navigationSnapshot = signal<ConsoleNavigationSnapshot | null>(this.cachedNavigationSnapshot);
  readonly navigationItems = computed(() => this.navigationSnapshot()?.items ?? []);
  readonly navigationSource = signal<'empty' | 'cached' | 'live'>(this.cachedNavigationSnapshot ? 'cached' : 'empty');
  readonly failures = signal<PluginFailure[]>([]);
  /** 플러그인별 기여 내비 트리(nav:contribute) — pluginId → 재귀 NavNode[] */
  readonly navTrees = signal<Record<string, NavNode[]>>({});
  /** 플러그인별 기여 검색 provider(search:contribute) — pluginId → provider(동기/비동기) */
  readonly searchProviders = signal<Record<string, SearchProvider>>({});
  /** Plugin/subShell manual sources contributed at runtime. */
  readonly manualContributions = signal<Record<string, ManualContribution>>({});
  /** 플러그인별 1단 아이콘(Carbon 토큰명) — Registry/Catalog의 effective navigation 투영. pluginId → token */
  readonly pluginIcons = signal<Record<string, string>>(Object.fromEntries(
    this.cachedNavigationSnapshot?.items.map((item) => [item.id, item.icon]) ?? [],
  ));
  /**
   * 플러그인별 API base(manifest.apiBase, 셸이 검증 파이프라인에서 이미 아는 값) — pluginId → base.
   * PluginHost가 마운트 직전 window.__OSP_NG_API_BASE__를 여기서 재설정해 크로스 플러그인 오염을 차단한다
   * (subShell의 ui-shell.plugin.js가 공유 전역에 1회만 쓰는 구조라, 다른 플러그인을 거쳐온 뒤 돌아오면
   *  stale 값을 읽는 문제가 있었다 — 셸이 진실원(authoritative source)으로 매번 덮어써 해결).
   */
  readonly apiBaseByPlugin = signal<Record<string, string>>({});

  async load(): Promise<void> {
    if (OS_SHELL_STANDALONE_BOOT) {
      throw new Error('ExternalExtensionsDisabledInStandaloneShell');
    }
    this.startRegistryWatch();
    this.startRouteWatch();
    this.loadState.set('loading');
    try {
      // Inventory and Registry are independent projections. Starting both at
      // once removes a serial network gate while still awaiting inventory
      // before icon precedence is committed below.
      const managementLoad = this.loadManagementInventory();
      let reg: RegistryV3;
      let managementAvailable = false;
      try {
        const res = await fetchWithTimeout('/api/v1/registry', { cache: 'no-store' });
        managementAvailable = await managementLoad;
        if (!res.ok) return; // 레지스트리 없음 = 플러그인 0개로 기동
        reg = await res.json();
      } catch {
        await managementLoad;
        return;
      }
      if (reg.version !== 3) {
        console.warn('[extension-host] Registry contract v3 아님 — 전체 거부(fail-closed)');
        return;
      }
      const activePlugins = (reg.plugins ?? []).filter((entry) => entry.available === true);
			this.trustedKeys = reg.trustedKeys ?? {};
			this.registryFingerprint = this.fingerprint(activePlugins, reg.trustedKeys ?? {});
      // 1단 아이콘 맵(registry 전사값). registry에는 Enabled 플러그인만 들어오므로 그대로 사용.
      this.pluginIcons.update((current) => ({
        ...Object.fromEntries(activePlugins.map((e) => [e.id, e.icon ?? ''])),
        ...current,
      }));
      this.registryEntries = activePlugins;
      this.pluginLoadStates.update((states) => ({
        ...states,
        ...Object.fromEntries(activePlugins.map((entry) => [entry.id, 'queued' as PluginLoadState])),
      }));
      if (managementAvailable) this.publishNavigationSnapshot(activePlugins);

      // Guest code is route-scoped. Menu composition is already complete from
      // the atomic snapshot, so a page reload no longer verifies or activates
      // unrelated subShells and hosted plugins.
      await this.ensureRequestedRoute(window.location.pathname);
    } finally {
      this.loadState.set('ready');
    }
  }

  /**
   * reload — Registry 변경을 발견하되 활성 document의 조합은 바꾸지 않는다.
   * CustomElementRegistry는 unregister를 지원하지 않으므로 이미 활성화된 guest를
   * 같은 realm에서 교체하거나 document 전체를 강제 reload하면 원자적 구성과
   * 사용자 작업 보존을 모두 깨뜨린다. 현재 document는 검증된 snapshot을 계속
   * 사용하고, 다음 자연스러운 document 시작이 새 Registry snapshot을 채택한다.
   */
  async reload(): Promise<void> {
    const managementAvailable = await this.loadManagementInventory(true);
    if (managementAvailable && this.registryEntries.length) this.publishNavigationSnapshot(this.registryEntries);
    if (this.activeModules.size > 0) {
      this.registryUpdatePending.set(true);
      console.info('[extension-host] Registry update staged for the next document; current composition remains pinned');
      return;
    }
    await this.deactivateAll();
    this.pages.set([]);
    this.failures.set([]);
    this.navTrees.set({});
    this.searchProviders.set({});
    this.manualContributions.set({});
    this.pluginIcons.set({});
    this.apiBaseByPlugin.set({});
    this.pluginLoadStates.set({});
    this.hostChildProjections.set({});
    this.registryUpdatePending.set(false);
    await this.load();
  }

  private async loadManagementInventory(force = false): Promise<boolean> {
    try {
      const result = await this.projections.refresh(force);
      const registrationByName = new Map(this.projections.registrations().map((item) => [item.name, item]));
      const items: ManagementInventoryItem[] = this.projections.catalog().flatMap((item) => {
        const id = item.name;
        if (!id) return [];
        const registration = registrationByName.get(id);
        return [{
          id,
          title: item.nav?.labelOverride?.trim() || item.displayName || id,
          navBand: item.nav?.band || '운영 Operate',
          hostRef: item.hostRef || 'main',
          kind: item.kind,
          icon: item.nav?.icon || '',
          order: item.nav?.order,
          desiredState: registration?.desiredState || '',
          phase: registration?.status.phase || 'NotInstalled',
        }];
      });
      this.managementInventory.set(items);
      this.pluginIcons.update((current) => ({
        ...current,
        ...Object.fromEntries(items.map((item) => [item.id, item.icon || ''])),
      }));
      return result.catalogAvailable;
    } catch (error) {
      console.warn('[extension-host] management inventory unavailable:', error);
      return this.projections.catalogLoaded();
    }
  }

  private startRegistryWatch(): void {
    if (this.registryWatch !== undefined) return;
    this.registryWatch = window.setInterval(() => void this.refreshRegistryIfChanged(), 30000);
  }

  private startRouteWatch(): void {
    if (this.routeWatchStarted) return;
    this.routeWatchStarted = true;
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) void this.ensureRequestedRoute(event.urlAfterRedirects);
    });
  }

  private async ensureRequestedRoute(pathname: string): Promise<void> {
    const target = extensionRouteTarget(pathname);
    if (!target.hostId) return;
    const parent = this.registryEntries.find((entry) => entry.id === target.hostId && (entry.hostRef ?? 'main') === 'main');
    if (!parent) return;
    await this.loadOne(parent, this.trustedKeys, HOST_API_VERSION);
    if (!target.childId) return;
    // A host owns its public child route. The route segment is therefore not
    // required to equal the Package id (for example /pfss/psmdb is owned by
    // UIPluginPackage/percona-psmdb). Resolve the verified host declaration
    // after activating the parent, then load the exact Registry child.
    const currentPath = pathname.replace(/\/+$/, '') || '/';
    const projection = (this.hostChildProjections()[target.hostId] ?? [])
      .filter((candidate) => currentPath === candidate.route || currentPath.startsWith(`${candidate.route}/`))
      .sort((left, right) => right.route.length - left.route.length)[0];
    const childId = projection?.id || target.childId;
    const child = this.registryEntries.find((entry) => entry.id === childId && (entry.hostRef ?? 'main') === target.hostId);
    if (!child) return;
    await this.loadOne(child, this.trustedKeys, parent.hostApiVersion ?? HOST_API_VERSION);
  }

  private readStoredNavigationSnapshot(): ConsoleNavigationSnapshot | null {
    try {
      return parseStoredConsoleNavigationSnapshot(window.localStorage.getItem(CONSOLE_NAVIGATION_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  private publishNavigationSnapshot(activePlugins: readonly RegistryEntry[]): void {
    const snapshot = buildConsoleNavigationSnapshot(
      activePlugins,
      this.managementInventory(),
      this.registryFingerprint,
    );
    this.navigationSnapshot.set(snapshot);
    this.navigationSource.set('live');
    this.pluginIcons.update((current) => ({
      ...current,
      ...Object.fromEntries(snapshot.items.map((item) => [item.id, item.icon])),
    }));
    try {
      window.localStorage.setItem(CONSOLE_NAVIGATION_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn('[extension-host] navigation snapshot persistence unavailable:', error);
    }
  }

  private async refreshRegistryIfChanged(): Promise<void> {
    if (this.registryUpdatePending()) return;
    try {
      const response = await fetchWithTimeout('/api/v1/registry', { cache: 'no-store' });
      if (!response.ok) return;
      const registry = await response.json() as RegistryV3;
      if (registry.version !== 3) return;
      const active = (registry.plugins ?? []).filter((entry) => entry.available === true);
			const fingerprint = this.fingerprint(active, registry.trustedKeys ?? {});
      if (fingerprint !== this.registryFingerprint) await this.reload();
    } catch (error) {
      console.warn('[extension-host] Registry watch degraded:', error);
    }
  }

  private async loadOne(e: RegistryEntry, trustedKeys: Record<string, string>, hostApiVersion: string): Promise<void> {
    if (OS_SHELL_STANDALONE_BOOT) {
      throw new Error('ExternalExtensionsDisabledInStandaloneShell');
    }
    if (this.activeModules.has(e.id)) return;
    const current = this.inFlightLoads.get(e.id);
    if (current) return current;
    const pending = this.performLoadOne(e, trustedKeys, hostApiVersion);
    this.inFlightLoads.set(e.id, pending);
    try {
      await pending;
    } finally {
      if (this.inFlightLoads.get(e.id) === pending) this.inFlightLoads.delete(e.id);
    }
  }

  private async performLoadOne(e: RegistryEntry, trustedKeys: Record<string, string>, hostApiVersion: string): Promise<void> {
    this.setPluginLoadState(e.id, 'loading');
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let mod: PluginModule | undefined;
        try {
      const hostRef = e.hostRef ?? 'main';
      const componentKind = e.componentKind ?? e.kind;
      if (hostRef !== 'main' && !this.registryEntries.some((candidate) => candidate.id === hostRef && (candidate.componentKind ?? candidate.kind) === 'subShell')) {
        throw new Error(`hostRef '${hostRef}'가 Registry에 없거나 subShell이 아님`);
      }
      if (hostRef !== 'main' && !this.activeModules.has(hostRef)) {
        throw new Error(`hostRef '${hostRef}'가 아직 활성화되지 않음`);
      }
      if (e.hostCompat && !semverSatisfies(hostApiVersion, e.hostCompat)) {
        throw new Error(`hostCompat '${e.hostCompat}'이 Host API ${hostApiVersion}과 비호환`);
      }
      await this.deactivate(e.id);
        const spki = trustedKeys[e.keyId];
        if (e.keyId === 'opensphere-module-local-v1' && (e.id !== 'cluster-manager' || componentKind !== 'subShell' || hostRef !== 'main')) {
          throw new Error('Module signing key is restricted to the official Cluster Manager');
        }
      if (!spki) throw new Error(`신뢰 키 '${e.keyId}' 없음`);
      // Manifest and detached signature are independent immutable artifacts.
      // Fetch them together and retain the cryptographic checks below.
      const [mText, sigB64] = await Promise.all([
        atExtensionStage('manifest', () => this.fetchVerifiedArtifactText(
          e.manifest,
          e.manifestSha256,
          'manifest',
        )),
        atExtensionStage('signature', async () => (
          await this.fetchCachedArtifactText(e.signature, `signature:${e.manifestSha256}`, '서명 파일')
        ).trim()),
      ]);
      const raw = JSON.parse(mText);
      if (raw.manifestVersion !== 2 && raw.manifestVersion !== 3)
        throw new Error('manifestVersion 2/3 아님 (하위호환: v2·v3 수용)');
      const manifest: NormalizedManifest = normalizeManifest(raw as Manifest);
      if (manifest.id !== e.id) throw new Error('manifest id가 레지스트리 항목과 불일치');
      if (manifest.hostRef !== hostRef) throw new Error(`manifest hostRef '${manifest.hostRef}'가 Registry '${hostRef}'와 불일치`);
      if (componentKind && manifest.kind !== componentKind) throw new Error(`manifest kind '${manifest.kind}'가 Registry '${componentKind}'와 불일치`);
      if (e.hostCompat && manifest.hostCompat !== e.hostCompat) throw new Error('manifest hostCompat가 Registry와 불일치');
      if (e.hostApiVersion && manifest.hostApiVersion !== e.hostApiVersion) throw new Error('manifest hostApiVersion이 Registry와 불일치');
			if (JSON.stringify(canonicalValue(manifest.contributions)) !== JSON.stringify(canonicalValue(e.contributions ?? {}))) {
				throw new Error('manifest contributions가 Registry와 불일치');
			}
      const canonicalApiBase = `/api/plugins/${e.id}`;
      if (manifest.apiBase && manifest.apiBase.replace(/\/$/, '') !== canonicalApiBase) {
        throw new Error(`manifest apiBase는 canonical namespace '${canonicalApiBase}'여야 함`);
      }
      if (manifest.contributions.api.enabled) {
        if (manifest.contributions.api.basePath?.replace(/\/$/, '') !== canonicalApiBase) {
          throw new Error(`API contribution basePath는 canonical namespace '${canonicalApiBase}'여야 함`);
        }
        if (!manifest.apiBase) throw new Error('활성 API contribution에 apiBase가 없음');
      }

      const artifactServiceId = e.artifactServiceId || e.id;
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(artifactServiceId)) {
        throw new Error('Registry artifact service id가 유효하지 않음');
      }
      const artifactBase = `/api/plugins/${artifactServiceId}`;

      // ② 출처 서명 (분리 서명, manifest 바이트 전체)
      if (!(await atExtensionStage('signature', () => verifyP256(spki, sigB64, mText)))) {
        throw new ExtensionStageError('signature', new Error('manifest 서명 검증 실패'));
      }

      // ③ 셸 호환성
      if (!semverSatisfies(SHELL_VERSION, manifest.shellCompat)) {
        throw new Error(`shellCompat '${manifest.shellCompat}'이 셸 ${SHELL_VERSION}과 비호환`);
      }

      // ④ 권한 — 미지 scope 거부
      const perms = manifest.permissions as readonly Capability[];
      for (const p of perms) {
        if (!isKnownCapability(p)) throw new Error(`알 수 없는 권한 scope '${p}'`);
      }
			// session:attach is a CBSS system-only capability. Ordinary signed
			// Consumers fail before entry bytes are fetched or imported.
			if (perms.includes('session:attach')) {
				throw new Error("system capability 'session:attach'는 외부 Consumer에 부여할 수 없음");
			}
			if (manifest.contributions.page.enabled && !perms.includes('page:register')) {
				throw new Error("page contribution에 'page:register' 권한 미선언");
			}

      // ⑤+⑥ 번들 무결성 + 검증된 바이트만 실행
      const entryUrl = new URL(manifest.entry, new URL(e.manifest, location.origin));
      if (entryUrl.origin !== location.origin || !entryUrl.pathname.startsWith(`${artifactBase}/`)) {
        throw new Error('entry가 검증된 release namespace 밖에 있음');
      }
      const [code, verifiedAssets] = await Promise.all([
        atExtensionStage('entry', () => this.fetchVerifiedArtifactText(
          entryUrl.href,
          manifest.entrySha256,
          'entry',
        )),
        atExtensionStage('assets', () => this.verifyAssets(artifactBase, e.manifest, manifest.assets)),
      ]);
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try {
        mod = await atExtensionStage(
          'activation',
          () => import(/* @vite-ignore */ blobUrl) as Promise<PluginModule>,
        );
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (typeof mod.activate !== 'function') throw new Error('activate() export 없음 (§9 계약 위반)');

      const runtimeManifest: NormalizedManifest = manifest.apiBase
        ? {
            ...manifest,
            apiBase: artifactBase,
            contributions: {
              ...manifest.contributions,
              api: { ...manifest.contributions.api, basePath: artifactBase },
            },
          }
        : manifest;
      if (runtimeManifest.apiBase) {
        const base = runtimeManifest.apiBase.replace(/\/$/, '');
        this.apiBaseByPlugin.update((m) => ({ ...m, [e.id]: base }));
      }

      // ⑦ 최소 권한 ctx
      const context = this.contextFor(e.id, runtimeManifest, perms, hostApiVersion, trustedKeys, verifiedAssets);
      if (typeof mod.activate !== 'function') throw new Error('activate() export 없음 (§9 계약 위반)');
			if (manifest.manifestVersion === 3 && typeof mod.deactivate !== 'function') {
				throw new Error('deactivate() export 없음 (Production lifecycle 계약 위반)');
			}
      await atExtensionStage('activation', async () => { await mod!.activate(context); });
      this.activeModules.set(e.id, mod);
      if (hostRef !== 'main') this.refreshHostChildProjections(hostRef);
      if (manifest.kind === 'subShell') this.refreshHostChildProjections(e.id);
      this.setPluginLoadState(e.id, 'ready');
      this.clearPluginFailure(e.id);
      console.info(`[extension-host] plugin '${e.id}' 검증 통과(무결성·서명·호환·권한) 후 활성화`);
          return;
        } catch (err) {
          try { await mod?.deactivate?.(); } catch (cleanupError) { console.warn(`[extension-host] plugin '${e.id}' cleanup 실패:`, cleanupError); }
          await this.deactivate(e.id);
          const retryable = isTransientExtensionLoadError(err);
          if (attempt === 0 && retryable) {
            console.warn(`[extension-host] plugin '${e.id}' 일시 적재 오류 — 한 번 재시도:`, err);
            await new Promise<void>((resolve) => window.setTimeout(resolve, TRANSIENT_EXTENSION_RETRY_DELAY_MS));
            continue;
          }
          console.warn(`[extension-host] plugin '${e.id}' 제외:`, err);
          this.setPluginFailure(
            e.id,
            err instanceof Error ? err.message : String(err),
            err instanceof ExtensionStageError ? err.stage : 'contract',
            retryable,
          );
          this.setPluginLoadState(e.id, 'failed');
          return;
        }
    }
  }

  pluginLoadState(pluginId: string): PluginLoadState | undefined {
    return this.pluginLoadStates()[pluginId];
  }

  hostChildProjection(hostRef: string, childId: string): HostChildProjection | undefined {
    return this.hostChildProjections()[hostRef]?.find((projection) => projection.id === childId);
  }

  private refreshHostChildProjections(hostRef: string): void {
    const declarations = this.hostProjectionDeclarations.get(hostRef) ?? [];
    const approvedChildren = new Set(this.registryEntries
      .filter((entry) => (entry.hostRef ?? 'main') === hostRef)
      .map((entry) => entry.id));
    // A verified host declaration is presentation metadata, not proof that the
    // child guest has already executed. Keeping it behind activeModules made
    // menus disappear until the user opened the very route that the menu was
    // supposed to expose. Execution remains fail-closed in loadOne(); here we
    // only project Registry-approved child routes declared by the verified host.
    const approved = declarations.filter((projection) => approvedChildren.has(projection.id));
    this.hostChildProjections.update((items) => ({ ...items, [hostRef]: approved }));
  }

  private setPluginLoadState(pluginId: string, state: PluginLoadState): void {
    this.pluginLoadStates.update((states) => ({ ...states, [pluginId]: state }));
  }

  private setPluginFailure(pluginId: string, error: string, stage: ExtensionLoadStage, retryable: boolean): void {
    this.failures.update((failures) => [
      ...failures.filter((failure) => failure.id !== pluginId),
      { id: pluginId, error, stage, retryable },
    ]);
  }

  private clearPluginFailure(pluginId: string): void {
    this.failures.update((failures) => failures.filter((failure) => failure.id !== pluginId));
  }

	private fingerprint(entries: RegistryEntry[], trustedKeys: Record<string, string>): string {
		return JSON.stringify({
			trustedKeys,
			entries: entries.map((entry) => ({
				id: entry.id,
				manifest: entry.manifest,
				manifestSha256: entry.manifestSha256,
				signature: entry.signature,
				keyId: entry.keyId,
				kind: entry.kind,
				componentKind: entry.componentKind,
				hostRef: entry.hostRef,
				hostCompat: entry.hostCompat,
				hostApiVersion: entry.hostApiVersion,
				contributions: entry.contributions,
				artifactServiceId: entry.artifactServiceId,
				releaseRevision: entry.releaseRevision,
				retainedArtifactServiceIds: entry.retainedArtifactServiceIds,
			})),
		});
	}

  private async deactivate(pluginId: string): Promise<void> {
    const owningHost = this.registryEntries.find((entry) => entry.id === pluginId)?.hostRef ?? 'main';
    const mod = this.activeModules.get(pluginId);
    if (mod) {
      try { await mod.deactivate?.(); } finally { this.activeModules.delete(pluginId); }
    }
    for (const [pageId, owner] of this.pageOwners) if (owner === pluginId) this.pageOwners.delete(pageId);
    this.pages.update((items) => items.filter((item) => this.pageOwners.has(item.id)));
    this.navTrees.update((items) => { const { [pluginId]: _nav, ...rest } = items; return rest; });
    this.searchProviders.update((items) => { const { [pluginId]: _search, ...rest } = items; return rest; });
    this.manualContributions.update((items) => { const { [pluginId]: _manual, ...rest } = items; return rest; });
    this.apiBaseByPlugin.update((items) => { const { [pluginId]: _api, ...rest } = items; return rest; });
    this.hostChildProjections.update((items) => {
      const next: Record<string, readonly HostChildProjection[]> = {};
      for (const [hostRef, projections] of Object.entries(items)) {
        if (hostRef === pluginId) continue;
        next[hostRef] = projections.filter((projection) => projection.id !== pluginId);
      }
      return next;
    });
    this.hostProjectionDeclarations.delete(pluginId);
    if (owningHost !== 'main') this.refreshHostChildProjections(owningHost);
    for (const style of this.assetStyles.get(pluginId) ?? []) style.remove();
    this.assetStyles.delete(pluginId);
    this.notif.clearSource(pluginId);
  }

  private async deactivateAll(): Promise<void> {
    for (const id of [...this.activeModules.keys()]) await this.deactivate(id);
  }

  /** §9 OpenSpherePluginContext 부분집합 — 승인된 권한의 능력만 노출 */
  private contextFor(
    pluginId: string,
    manifest: NormalizedManifest,
    perms: readonly Capability[],
    hostApiVersion: string,
    trustedKeys: Record<string, string>,
    verifiedAssets: ReadonlyMap<string, VerifiedAsset>,
  ) {
    const apiFetch = (input: RequestInfo | URL, init?: RequestInit) => this.fetchForPlugin(manifest, input, init);
    const routeBase = extensionRouteBase(pluginId, manifest.hostRef);
    const currentRoute = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const navigate = (path: string, options?: { replace?: boolean }) => {
      const target = new URL(path, window.location.origin);
      const platformSupportDeliveryRoute = pluginId === 'foundation'
        && ['/manage/platform-support/argocd', '/manage/platform-support/crossplane']
          .some((base) => target.pathname === base || target.pathname.startsWith(`${base}/`));
      if (target.origin !== window.location.origin
        || (!platformSupportDeliveryRoute && target.pathname !== routeBase && !target.pathname.startsWith(`${routeBase}/`))) {
        throw new Error(`guest route must remain under ${routeBase}`);
      }
      const next = `${target.pathname}${target.search}${target.hash}`;
      void this.router.navigateByUrl(next, { replaceUrl: options?.replace === true });
    };
    const childHost = async (manifestUrl: string): Promise<void> => {
      if (manifest.kind !== 'subShell') throw new Error('plugin은 child를 host할 수 없음');
      const child = this.registryEntries.find((entry) => entry.manifest === manifestUrl && (entry.hostRef ?? 'main') === pluginId);
      if (!child) throw new Error(`승인된 child manifest가 아님: ${manifestUrl}`);
      await this.loadOne(child, trustedKeys, manifest.hostApiVersion ?? HOST_API_VERSION);
    };
    const reportChildProjections = (input: unknown): void => {
      if (manifest.kind !== 'subShell') throw new Error('plugin은 child projection을 보고할 수 없음');
      if (!Array.isArray(input)) throw new Error('child projection 보고는 배열이어야 함');
      const approvedChildren = new Map(this.registryEntries
        .filter((entry) => (entry.hostRef ?? 'main') === pluginId)
        .map((entry) => [entry.id, entry]));
      const projections: HostChildProjection[] = [];
      const seen = new Set<string>();
      for (const candidate of input) {
        if (!candidate || typeof candidate !== 'object') throw new Error('child projection 항목이 객체가 아님');
        const raw = candidate as Record<string, unknown>;
        const id = String(raw['id'] || '').trim();
        const route = String(raw['route'] || '').trim();
        const element = String(raw['element'] || '').trim();
        if (!approvedChildren.has(id)) throw new Error(`Registry가 승인한 child가 아님: '${id}'`);
        if (seen.has(id)) throw new Error(`child projection 중복: '${id}'`);
        const target = new URL(route, window.location.origin);
        if (target.origin !== window.location.origin || target.search || target.hash || !target.pathname.startsWith('/pfss/')) {
          throw new Error(`child projection route가 canonical PFSS 경로가 아님: '${route}'`);
        }
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(element)) {
          throw new Error(`child projection element 이름이 유효하지 않음: '${element}'`);
        }
        seen.add(id);
        projections.push({ id, route: target.pathname, element });
      }
      this.hostProjectionDeclarations.set(pluginId, Object.freeze(projections));
      this.refreshHostChildProjections(pluginId);
    };
    const loadedModules = new Map<string, Promise<unknown>>();
    const loadModule = (id: string): Promise<unknown> => {
      const asset = verifiedAssets.get(id);
      if (!asset || asset.declaration.type !== 'module') throw new Error(`검증된 module asset '${id}' 없음`);
      let loaded = loadedModules.get(id);
      if (!loaded) {
        loaded = (async () => {
          const url = URL.createObjectURL(new Blob([asset.text], { type: 'text/javascript' }));
          try {
            return await import(/* @vite-ignore */ url);
          } finally {
            URL.revokeObjectURL(url);
          }
        })();
        loadedModules.set(id, loaded);
      }
      return loaded;
    };
    const loadStyle = async (id: string): Promise<void> => {
      const asset = verifiedAssets.get(id);
      if (!asset || asset.declaration.type !== 'style') throw new Error(`검증된 style asset '${id}' 없음`);
      const selector = `style[data-opensphere-plugin="${CSS.escape(pluginId)}"][data-opensphere-asset="${CSS.escape(id)}"]`;
      if (document.head.querySelector(selector)) return;
      const style = document.createElement('style');
      style.dataset['openspherePlugin'] = pluginId;
      style.dataset['opensphereAsset'] = id;
      style.textContent = asset.text;
      document.head.appendChild(style);
      const owned = this.assetStyles.get(pluginId) ?? new Set<HTMLStyleElement>();
      owned.add(style);
      this.assetStyles.set(pluginId, owned);
    };
    return {
      pluginId,
      shellVersion: SHELL_VERSION,
      hostApiVersion,
      grants: perms,
      routing: {
        basePath: routeBase,
        currentPath: currentRoute,
        navigate,
        subscribe: (listener: (path: string) => void) => {
          const subscription = this.router.events.subscribe((event) => {
            if (event instanceof NavigationEnd) listener(currentRoute());
          });
          return () => subscription.unsubscribe();
        },
      },
      ...(verifiedAssets.size ? { assets: { loadModule, loadStyle } } : {}),
      ...(perms.includes('api:proxy') ? { api: { baseUrl: manifest.apiBase ?? '', fetch: apiFetch } } : {}),
			...(perms.includes('identity:read') ? { identity: {
				username: this.auth.user(),
				groups: [...this.auth.groups()],
				roles: [...this.auth.roles()],
				foundation: 'console' as const,
			} } : {}),
      // notify:publish 권한 시에만 노출 — subShell이 셸 단일 인박스에 발행(집계·표시는 셸 소유).
      // source는 여기서 pluginId로 강제 태깅(클로저 캡처 = 위조 불가). 상세: dupa-notification-contribution-contract.
      ...(perms.includes('notify:publish')
        ? {
            notify: {
              publish: (input: NotifyInput): string => {
                const id = this.notif.nextId(pluginId);
                const n: OsNotification = {
                  ...input,
                  id,
                  source: pluginId,
                  time: input.time ?? new Date().toISOString(),
                  read: false,
                };
                this.notif.push(n);
                return id;
              },
              dismiss: (id: string) => this.notif.dismissById(pluginId, id),
              clear: () => this.notif.clearSource(pluginId),
            },
          }
        : {}),
      extensions: {
				...(perms.includes('page:register') ? { registerPage: (p: PluginPage) => {
					if (p.id !== pluginId) throw new Error('page id는 Consumer canonical id와 같아야 함');
					this.pageOwners.set(p.id, pluginId);
					this.pages.update((arr) => [...arr.filter((x) => x.id !== p.id), p]);
				} } : {}),
        // nav:contribute 권한 시에만 노출 — 플러그인이 자기 메뉴 트리를 런타임 기여(재귀·동적)
        ...(perms.includes('nav:contribute')
          ? {
              nav: {
                contribute: (tree: NavNode[]) =>
                  this.navTrees.update((m) => ({ ...m, [pluginId]: tree })),
                clear: () =>
                  this.navTrees.update((m) => {
                    const { [pluginId]: _omit, ...rest } = m;
                    return rest;
                  }),
              },
            }
          : {}),
        // search:contribute 권한 시에만 노출 — 플러그인이 자기 검색 provider를 런타임 기여(클라이언트 콘텐츠).
        // 결과 출처는 SearchService가 pluginId로 강제 태깅. 비동기 provider 허용(OpenSearch 데이터층과 동일 seam).
        ...(perms.includes('search:contribute')
          ? {
              search: {
                contribute: (provider: SearchProvider) =>
                  this.searchProviders.update((m) => ({ ...m, [pluginId]: provider })),
                clear: () =>
                  this.searchProviders.update((m) => {
                    const { [pluginId]: _omit, ...rest } = m;
                    return rest;
                  }),
              },
            }
          : {}),
        ...(perms.includes('manual:contribute')
          ? {
              manual: {
                contribute: (source: ManualContribution) => {
                  const normalized = this.normalizeManualContribution(pluginId, source);
                  this.manualContributions.update((m) => ({ ...m, [pluginId]: normalized }));
                },
                clear: () =>
                  this.manualContributions.update((m) => {
                    const { [pluginId]: _omit, ...rest } = m;
                    return rest;
                  }),
              },
            }
          : {}),
      },
      ...(manifest.kind === 'subShell' ? {
        host: {
          mountChild: childHost,
          // The parent receives its approved inventory immediately and may
          // declare canonical routes without waiting for child bundles. The
          // Console exposes only declarations whose child later completes the
          // verified activate() lifecycle.
          children: () => this.registryEntries
            .filter((entry) => (entry.hostRef ?? 'main') === pluginId)
            .map((entry) => entry.id),
          reportProjections: reportChildProjections,
        },
      } : {}),
    };
  }

  private async fetchForPlugin(manifest: NormalizedManifest, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const apiBase = manifest.apiBase ?? '';
    if (!apiBase) throw new Error('api:proxy는 apiBase가 필요합니다');
    const raw = input instanceof Request ? input.url : String(input);
    const base = new URL(apiBase, location.origin);
    const allowedBases = [base.pathname, manifest.contributions.api?.basePath].filter((value): value is string => Boolean(value)).map((value) => value.replace(/\/$/, ''));
    const absolute = /^https?:\/\//i.test(raw) ? new URL(raw) : null;
    const direct = absolute || (raw.startsWith('/') ? new URL(raw, base.origin) : null);
    const target = direct && allowedBases.some((allowed) => direct.pathname === allowed || direct.pathname.startsWith(`${allowed}/`))
      ? direct
      : new URL(`${base.pathname.replace(/\/$/, '')}/${raw.replace(/^\/+/, '')}`, base.origin);
    if (target.origin !== location.origin || !allowedBases.some((allowed) => target.pathname === allowed || target.pathname.startsWith(`${allowed}/`))) {
      throw new Error('plugin API 요청이 승인된 same-origin base 밖에 있음');
    }
    // Main Shell and every extension share one command transport. This keeps
    // CSRF, correlation, idempotency, timeout and MFA continuation semantics
    // identical instead of letting each plugin invent a second control path.
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    return this.http.request(target, { ...init, headers });
  }

  private normalizeManualContribution(pluginId: string, input: ManualContribution): ManualContribution {
    const rawDocs = Array.isArray(input?.documents) ? input.documents : [];
    return {
      sourceId: String(input?.sourceId || `plugin:${pluginId}`).trim() || `plugin:${pluginId}`,
      name: String(input?.name || pluginId).trim() || pluginId,
      // 런타임 guest 문서는 로컬 UI 표시 전용이다. Canonical/RAG seed 권한은 설치 파이프라인만 갖는다.
      authorityTier: 4,
      language: input?.language || 'mixed',
      documents: rawDocs
        .filter((doc) => doc && String(doc.id || '').trim() && String(doc.content || '').trim())
        .slice(0, 32)
        .map((doc) => ({
          id: String(doc.id).trim(),
          title: String(doc.title || doc.id).trim(),
          content: String(doc.content).slice(0, 120000),
          route: String(doc.route || '').trim(),
          sourcePath: String(doc.sourcePath || '').trim(),
          documentType: String(doc.documentType || 'reference').trim(),
          tags: Array.isArray(doc.tags) ? doc.tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 16) : [],
        })),
    };
  }

  private artifactCacheKey(url: string, identity: string): string {
    return `${identity}:${new URL(url, location.origin).href}`;
  }

  private async fetchCachedArtifactText(url: string, identity: string, label: string): Promise<string> {
    const cacheKey = this.artifactCacheKey(url, identity);
    let pending = this.artifactTextCache.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const response = await fetchWithTimeout(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
        return response.text();
      })();
      this.artifactTextCache.set(cacheKey, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.artifactTextCache.get(cacheKey) === pending) this.artifactTextCache.delete(cacheKey);
      throw error;
    }
  }

  private async fetchVerifiedArtifactText(url: string, expectedSha256: string, label: string): Promise<string> {
    const identity = `sha256:${expectedSha256}`;
    const cacheKey = this.artifactCacheKey(url, identity);
    let text = await this.fetchCachedArtifactText(url, identity, label);
    if ((await sha256Hex(text)) === expectedSha256) return text;

    // A browser may still hold bytes from a legacy stable URL. One explicit
    // revalidation avoids a false failure, but the expected Registry digest
    // remains the only acceptance authority.
    this.artifactTextCache.delete(cacheKey);
    const response = await fetchWithTimeout(url, { cache: 'reload' });
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    text = await response.text();
    if ((await sha256Hex(text)) !== expectedSha256) {
      throw new Error(`${label} 무결성 불일치 — 서명된 digest와 다름`);
    }
    this.artifactTextCache.set(cacheKey, Promise.resolve(text));
    return text;
  }

  private async verifyAssets(
    artifactBase: string,
    manifestUrl: string,
    declarations: readonly ManifestAsset[],
  ): Promise<ReadonlyMap<string, VerifiedAsset>> {
    const seen = new Set<string>();
    for (const declaration of declarations) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(declaration.id) || seen.has(declaration.id)) {
        throw new Error(`asset id가 유효하지 않거나 중복됨: '${declaration.id}'`);
      }
      seen.add(declaration.id);
      if (!['module', 'style'].includes(declaration.type)) throw new Error(`asset '${declaration.id}' type이 유효하지 않음`);
      if (!/^[a-f0-9]{64}$/.test(declaration.sha256)) throw new Error(`asset '${declaration.id}' sha256이 유효하지 않음`);
    }
    const entries = await Promise.all(declarations.map(async (declaration): Promise<[string, VerifiedAsset]> => {
      const url = new URL(declaration.path, new URL(manifestUrl, location.origin));
      if (url.origin !== location.origin || !url.pathname.startsWith(`${artifactBase}/`)) {
        throw new Error(`asset '${declaration.id}'가 검증된 release namespace 밖에 있음`);
      }
      const text = await this.fetchVerifiedArtifactText(
        url.href,
        declaration.sha256,
        `asset '${declaration.id}'`,
      );
      return [declaration.id, { declaration, text }];
    }));
    return new Map(entries);
  }
}

/* ── 검증 유틸 (Web 표준 API만 사용) ───────────────────────────── */

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** ECDSA P-256/SHA-256, 서명은 ieee-p1363(r||s) — sign-and-pin.mjs와 쌍 */
async function verifyP256(spkiB64: string, sigB64: string, text: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'spki', b64ToBytes(spkiB64).buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64ToBytes(sigB64).buffer as ArrayBuffer, new TextEncoder().encode(text),
  );
}

/** 최소 semver 범위 검사 — ">=A <B" 형태(공백 구분, >=/>/<=/</= 지원) */
export function semverSatisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return false;
  return range.trim().split(/\s+/).every((cond) => {
    const m = cond.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
    if (!m) return false;
    const c = cmp(v, parseVer(m[2])!);
    switch (m[1] ?? '=') {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  });
}

function parseVer(s: string): number[] | null {
  const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
	}
	return value;
}
