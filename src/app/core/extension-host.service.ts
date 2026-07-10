import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { HttpService } from './http.service';
import { NotificationService, NotifyInput, OsNotification } from './notification.service';
import { normalizeManifest, isKnownCapability } from '@opensphere/sdk';
import type { PluginPage, NavNode, SearchProvider, Manifest, NormalizedManifest, PluginModule, Capability } from '@opensphere/sdk';
export type { PluginPage, NavNode } from '@opensphere/sdk';

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

// 권한 scope 어휘(C1)·PluginPage·NavNode는 @opensphere/sdk가 SSOT(위에서 re-export).
// 닫힌 집합 검증은 isKnownCapability().

export interface PluginFailure { id: string; error: string; }
export const HOST_API_VERSION = '1.0.0';
const FETCH_TIMEOUT_MS = 15000;

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
  icon?: string; // 1단 아이콘(Carbon 토큰명) — 관리자 오버라이드(spec.nav.icon). 서명 무관.
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

@Injectable({ providedIn: 'root' })
export class ExtensionHostService {
  private auth = inject(AuthService);
  private http = inject(HttpService);
  private notif = inject(NotificationService);
  private activeModules = new Map<string, PluginModule>();
  private pageOwners = new Map<string, string>();
  private loadingIds = new Set<string>();
  private registryFingerprint = '';
  private registryWatch?: number;
  private registryEntries: RegistryEntry[] = [];

  readonly pages = signal<PluginPage[]>([]);
  readonly failures = signal<PluginFailure[]>([]);
  /** 플러그인별 기여 내비 트리(nav:contribute) — pluginId → 재귀 NavNode[] */
  readonly navTrees = signal<Record<string, NavNode[]>>({});
  /** 플러그인별 기여 검색 provider(search:contribute) — pluginId → provider(동기/비동기) */
  readonly searchProviders = signal<Record<string, SearchProvider>>({});
  /** Plugin/subShell manual sources contributed at runtime. */
  readonly manualContributions = signal<Record<string, ManualContribution>>({});
  /** 플러그인별 1단 아이콘(Carbon 토큰명) — registry(spec.nav.icon 전사)에서. pluginId → token */
  readonly pluginIcons = signal<Record<string, string>>({});
  /**
   * 플러그인별 API base(manifest.apiBase, 셸이 검증 파이프라인에서 이미 아는 값) — pluginId → base.
   * PluginHost가 마운트 직전 window.__OSP_NG_API_BASE__를 여기서 재설정해 크로스 플러그인 오염을 차단한다
   * (subShell의 ui-shell.plugin.js가 공유 전역에 1회만 쓰는 구조라, 다른 플러그인을 거쳐온 뒤 돌아오면
   *  stale 값을 읽는 문제가 있었다 — 셸이 진실원(authoritative source)으로 매번 덮어써 해결).
   */
  readonly apiBaseByPlugin = signal<Record<string, string>>({});

  async load(): Promise<void> {
    this.startRegistryWatch();
    let reg: RegistryV3;
    try {
      const res = await fetchWithTimeout('/api/v1/registry', { cache: 'no-store' });
      if (!res.ok) return; // 레지스트리 없음 = 플러그인 0개로 기동
      reg = await res.json();
    } catch {
      return;
    }
    if (reg.version !== 3) {
      console.warn('[extension-host] Registry contract v3 아님 — 전체 거부(fail-closed)');
      return;
    }
    const activePlugins = (reg.plugins ?? []).filter((entry) => entry.available === true);
		this.registryFingerprint = this.fingerprint(activePlugins, reg.trustedKeys ?? {});
    // 1단 아이콘 맵(registry 전사값). registry에는 Enabled 플러그인만 들어오므로 그대로 사용.
    this.pluginIcons.set(Object.fromEntries(activePlugins.map((e) => [e.id, e.icon ?? ''])));
    this.registryEntries = activePlugins;
    // Main Shell은 직속 consumer만 활성화한다. subShell의 child는 subShell-scoped host를 통해
    // mountChild()로 활성화되어 위계와 capability 경계를 보존한다.
    await Promise.all(activePlugins
      .filter((e) => (e.hostRef ?? 'main') === 'main')
      .map((e) => this.loadOne(e, reg.trustedKeys ?? {}, HOST_API_VERSION)));
  }

  /**
   * reload — Admin Control이 설치/삭제한 뒤 호출(검토 §B.4). registry를 다시 읽고
   * pages를 재구성한다. 이미 로드된 플러그인도 전 검증을 다시 거친다(B.1 런타임 방어 유지).
   * 셸 이미지·파드는 불변 — registry 변화만으로 메뉴가 증감한다.
   */
  async reload(): Promise<void> {
    await this.deactivateAll();
    this.pages.set([]);
    this.failures.set([]);
    this.navTrees.set({});
    this.searchProviders.set({});
    this.manualContributions.set({});
    this.pluginIcons.set({});
    this.apiBaseByPlugin.set({});
    await this.load();
  }

  private startRegistryWatch(): void {
    if (this.registryWatch !== undefined) return;
    this.registryWatch = window.setInterval(() => void this.refreshRegistryIfChanged(), 30000);
  }

  private async refreshRegistryIfChanged(): Promise<void> {
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
    let mod: PluginModule | undefined;
    if (this.loadingIds.has(e.id)) {
      this.failures.update((f) => [...f, { id: e.id, error: 'Host Contract cycle detected' }]);
      return;
    }
    this.loadingIds.add(e.id);
    try {
      const hostRef = e.hostRef ?? 'main';
      const componentKind = e.componentKind ?? e.kind;
      if (hostRef !== 'main' && !this.registryEntries.some((candidate) => candidate.id === hostRef && (candidate.componentKind ?? candidate.kind) === 'subShell')) {
        throw new Error(`hostRef '${hostRef}'가 Registry에 없거나 subShell이 아님`);
      }
      if (e.hostCompat && !semverSatisfies(hostApiVersion, e.hostCompat)) {
        throw new Error(`hostCompat '${e.hostCompat}'이 Host API ${hostApiVersion}과 비호환`);
      }
      await this.deactivate(e.id);
      // ① manifest 무결성 (registry 핀)
      const mRes = await fetchWithTimeout(e.manifest, { cache: 'no-store' });
      if (!mRes.ok) throw new Error(`manifest HTTP ${mRes.status}`);
      const mText = await mRes.text();
      if ((await sha256Hex(mText)) !== e.manifestSha256) {
        throw new Error('manifest 무결성 불일치 — 레지스트리 핀과 다름');
      }
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

      // ② 출처 서명 (분리 서명, manifest 바이트 전체)
      const spki = trustedKeys[e.keyId];
      if (!spki) throw new Error(`신뢰 키 '${e.keyId}' 없음`);
      const sRes = await fetchWithTimeout(e.signature, { cache: 'no-store' });
      if (!sRes.ok) throw new Error(`서명 파일 HTTP ${sRes.status}`);
      const sigB64 = (await sRes.text()).trim();
      if (!(await verifyP256(spki, sigB64, mText))) throw new Error('manifest 서명 검증 실패');

      // ③ 셸 호환성
      if (!semverSatisfies(SHELL_VERSION, manifest.shellCompat)) {
        throw new Error(`shellCompat '${manifest.shellCompat}'이 셸 ${SHELL_VERSION}과 비호환`);
      }

      // ④ 권한 — 미지 scope 거부
      const perms = manifest.permissions as readonly Capability[];
      for (const p of perms) {
        if (!isKnownCapability(p)) throw new Error(`알 수 없는 권한 scope '${p}'`);
      }
			if (manifest.contributions.page.enabled && !perms.includes('page:register')) {
				throw new Error("page contribution에 'page:register' 권한 미선언");
			}

      // ⑤+⑥ 번들 무결성 + 검증된 바이트만 실행
      const entryUrl = new URL(manifest.entry, new URL(e.manifest, location.origin)).href;
      const bRes = await fetchWithTimeout(entryUrl, { cache: 'no-store' });
      if (!bRes.ok) throw new Error(`entry HTTP ${bRes.status}`);
      const code = await bRes.text();
      if ((await sha256Hex(code)) !== manifest.entrySha256) {
        throw new Error('번들 무결성 불일치 — manifest 핀과 다름');
      }
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try {
        mod = await import(/* @vite-ignore */ blobUrl) as PluginModule;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (typeof mod.activate !== 'function') throw new Error('activate() export 없음 (§9 계약 위반)');

      if (manifest.apiBase) {
        const base = manifest.apiBase.replace(/\/$/, '');
        this.apiBaseByPlugin.update((m) => ({ ...m, [e.id]: base }));
      }

      // ⑦ 최소 권한 ctx
      const context = this.contextFor(e.id, manifest, perms, hostApiVersion, trustedKeys);
      if (typeof mod.activate !== 'function') throw new Error('activate() export 없음 (§9 계약 위반)');
			if (manifest.manifestVersion === 3 && typeof mod.deactivate !== 'function') {
				throw new Error('deactivate() export 없음 (Production lifecycle 계약 위반)');
			}
      await mod.activate(context);
      this.activeModules.set(e.id, mod);
      // 기존 subShell이 명시적으로 mountChild를 호출하지 않아도 Registry의 child가 고아가 되지 않도록
      // controller가 승인한 hostRef를 기준으로 한 번 자동 수렴한다. 중복 호출은 activeModules가 막는다.
      if (manifest.kind === 'subShell') {
        await Promise.all(this.registryEntries
          .filter((child) => (child.hostRef ?? 'main') === e.id)
          .map((child) => this.loadOne(child, trustedKeys, manifest.hostApiVersion ?? HOST_API_VERSION)));
      }
      console.info(`[extension-host] plugin '${e.id}' 검증 통과(무결성·서명·호환·권한) 후 활성화`);
    } catch (err) {
      try { await mod?.deactivate?.(); } catch (cleanupError) { console.warn(`[extension-host] plugin '${e.id}' cleanup 실패:`, cleanupError); }
      console.warn(`[extension-host] plugin '${e.id}' 제외:`, err);
      this.failures.update((f) => [...f, { id: e.id, error: String(err) }]);
    } finally {
      this.loadingIds.delete(e.id);
    }
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
				hostRef: entry.hostRef,
				hostCompat: entry.hostCompat,
				hostApiVersion: entry.hostApiVersion,
				contributions: entry.contributions,
			})),
		});
	}

  private async deactivate(pluginId: string): Promise<void> {
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
    this.notif.clearSource(pluginId);
  }

  private async deactivateAll(): Promise<void> {
    for (const id of [...this.activeModules.keys()]) await this.deactivate(id);
  }

  /** §9 OpenSpherePluginContext 부분집합 — 승인된 권한의 능력만 노출 */
  private contextFor(pluginId: string, manifest: NormalizedManifest, perms: readonly Capability[], hostApiVersion: string, trustedKeys: Record<string, string>) {
    const apiFetch = (input: RequestInfo | URL, init?: RequestInit) => this.fetchForPlugin(manifest, input, init);
    const childHost = async (manifestUrl: string): Promise<void> => {
      if (manifest.kind !== 'subShell') throw new Error('plugin은 child를 host할 수 없음');
      const child = this.registryEntries.find((entry) => entry.manifest === manifestUrl && (entry.hostRef ?? 'main') === pluginId);
      if (!child) throw new Error(`승인된 child manifest가 아님: ${manifestUrl}`);
      await this.loadOne(child, trustedKeys, manifest.hostApiVersion ?? HOST_API_VERSION);
    };
    return {
      pluginId,
      shellVersion: SHELL_VERSION,
      hostApiVersion,
      grants: perms,
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
                  void this.syncManualContribution(pluginId, normalized);
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
      ...(manifest.kind === 'subShell' ? { host: { mountChild: childHost, children: () => this.registryEntries.filter((entry) => (entry.hostRef ?? 'main') === pluginId).map((entry) => entry.id) } } : {}),
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
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
		headers.delete('authorization');
		headers.delete('x-os-id-token');
		headers.delete('x-opensphere-user');
		headers.delete('x-opensphere-actor');
    const token = this.auth.token();
    if (token) headers.set('authorization', `Bearer ${token}`);
		const correlationId = headers.get('X-OS-Correlation-ID');
		if (!correlationId || !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)) headers.set('X-OS-Correlation-ID', crypto.randomUUID());
		const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
		if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers.has('X-OS-Idempotency-Key')) {
			headers.set('X-OS-Idempotency-Key', crypto.randomUUID());
		}
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    if (init.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      return await fetchWithTimeout(target, { ...init, headers, signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private normalizeManualContribution(pluginId: string, input: ManualContribution): ManualContribution {
    const rawDocs = Array.isArray(input?.documents) ? input.documents : [];
    return {
      sourceId: String(input?.sourceId || `plugin:${pluginId}`).trim() || `plugin:${pluginId}`,
      name: String(input?.name || pluginId).trim() || pluginId,
      authorityTier: Math.max(2, Math.min(4, Number(input?.authorityTier ?? 3) || 3)),
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

  private async syncManualContribution(pluginId: string, source: ManualContribution): Promise<void> {
    if (!source.documents.length) return;
    const token = this.auth.token();
    if (!token) return;
    const sourceId = source.sourceId || `plugin:${pluginId}`;
    try {
      const res = await this.http.request('/api/oaa/admin/knowledge/manual-seed', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schema: 'manual-seed.opensphere.io/v1alpha1',
          source: {
            id: sourceId,
            type: 'plugin',
            name: source.name || pluginId,
            authorityTier: source.authorityTier ?? 3,
            defaultNamespace: 'opensphere',
            defaultLanguage: source.language || 'mixed',
            refreshMode: 'release-bound',
          },
          documents: source.documents.map((doc) => ({
            sourceId: `${sourceId}/${doc.id}`,
            title: doc.title,
            route: doc.route || `/p/${pluginId}`,
            sourcePath: doc.sourcePath || `${pluginId}/${doc.id}`,
            documentType: doc.documentType || 'reference',
            authorityTier: source.authorityTier ?? 3,
            component: [pluginId],
            tags: doc.tags || [],
            content: doc.content,
          })),
        }),
      });
      if (!res.ok) console.warn(`[extension-host] manual contribution sync skipped for '${pluginId}': HTTP ${res.status}`);
    } catch (e) {
      console.warn(`[extension-host] manual contribution sync skipped for '${pluginId}':`, e);
    }
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
