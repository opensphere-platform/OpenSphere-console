import { Injectable, inject, signal } from '@angular/core';
import { NotificationService, NotifyInput, OsNotification } from './notification.service';
import { normalizeManifest, isKnownCapability } from '@opensphere/sdk';
import type { PluginPage, NavNode, SearchProvider, Manifest, NormalizedManifest } from '@opensphere/sdk';
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

interface RegistryV2 {
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
}

@Injectable({ providedIn: 'root' })
export class ExtensionHostService {
  private notif = inject(NotificationService);

  readonly pages = signal<PluginPage[]>([]);
  readonly failures = signal<PluginFailure[]>([]);
  /** 플러그인별 기여 내비 트리(nav:contribute) — pluginId → 재귀 NavNode[] */
  readonly navTrees = signal<Record<string, NavNode[]>>({});
  /** 플러그인별 기여 검색 provider(search:contribute) — pluginId → provider(동기/비동기) */
  readonly searchProviders = signal<Record<string, SearchProvider>>({});

  async load(): Promise<void> {
    let reg: RegistryV2;
    try {
      const res = await fetch('/registry/plugins.json', { cache: 'no-store' });
      if (!res.ok) return; // 레지스트리 없음 = 플러그인 0개로 기동
      reg = await res.json();
    } catch {
      return;
    }
    if (reg.version !== 2) {
      console.warn('[extension-host] 레지스트리 v2 아님 — 전체 거부(fail-closed)');
      return;
    }
    await Promise.all((reg.plugins ?? []).map((e) => this.loadOne(e, reg.trustedKeys ?? {})));
  }

  /**
   * reload — Admin Control이 설치/삭제한 뒤 호출(검토 §B.4). registry를 다시 읽고
   * pages를 재구성한다. 이미 로드된 플러그인도 전 검증을 다시 거친다(B.1 런타임 방어 유지).
   * 셸 이미지·파드는 불변 — registry 변화만으로 메뉴가 증감한다.
   */
  async reload(): Promise<void> {
    this.pages.set([]);
    this.failures.set([]);
    this.navTrees.set({});
    this.searchProviders.set({});
    await this.load();
  }

  private async loadOne(e: RegistryEntry, trustedKeys: Record<string, string>): Promise<void> {
    try {
      // ① manifest 무결성 (registry 핀)
      const mRes = await fetch(e.manifest, { cache: 'no-store' });
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

      // ② 출처 서명 (분리 서명, manifest 바이트 전체)
      const spki = trustedKeys[e.keyId];
      if (!spki) throw new Error(`신뢰 키 '${e.keyId}' 없음`);
      const sRes = await fetch(e.signature, { cache: 'no-store' });
      if (!sRes.ok) throw new Error(`서명 파일 HTTP ${sRes.status}`);
      const sigB64 = (await sRes.text()).trim();
      if (!(await verifyP256(spki, sigB64, mText))) throw new Error('manifest 서명 검증 실패');

      // ③ 셸 호환성
      if (!semverSatisfies(SHELL_VERSION, manifest.shellCompat)) {
        throw new Error(`shellCompat '${manifest.shellCompat}'이 셸 ${SHELL_VERSION}과 비호환`);
      }

      // ④ 권한 — 미지 scope 거부
      const perms = manifest.permissions;
      for (const p of perms) {
        if (!isKnownCapability(p)) throw new Error(`알 수 없는 권한 scope '${p}'`);
      }
      if (!perms.includes('page:register')) throw new Error("'page:register' 권한 미선언 — UI 플러그인 자격 없음");

      // ⑤+⑥ 번들 무결성 + 검증된 바이트만 실행
      const entryUrl = new URL(manifest.entry, new URL(e.manifest, location.origin)).href;
      const bRes = await fetch(entryUrl, { cache: 'no-store' });
      if (!bRes.ok) throw new Error(`entry HTTP ${bRes.status}`);
      const code = await bRes.text();
      if ((await sha256Hex(code)) !== manifest.entrySha256) {
        throw new Error('번들 무결성 불일치 — manifest 핀과 다름');
      }
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      let mod: { activate?: (ctx: unknown) => unknown };
      try {
        mod = await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (typeof mod.activate !== 'function') throw new Error('activate() export 없음 (§9 계약 위반)');

      // ⑦ 최소 권한 ctx
      await mod.activate(this.contextFor(e.id, manifest, perms));
      console.info(`[extension-host] plugin '${e.id}' 검증 통과(무결성·서명·호환·권한) 후 활성화`);
    } catch (err) {
      console.warn(`[extension-host] plugin '${e.id}' 제외:`, err);
      this.failures.update((f) => [...f, { id: e.id, error: String(err) }]);
    }
  }

  /** §9 OpenSpherePluginContext 부분집합 — 승인된 권한의 능력만 노출 */
  private contextFor(pluginId: string, manifest: NormalizedManifest, perms: string[]) {
    return {
      pluginId,
      shellVersion: SHELL_VERSION,
      ...(perms.includes('api:proxy') ? { api: { baseUrl: manifest.apiBase ?? '' } } : {}),
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
        registerPage: (p: PluginPage) =>
          this.pages.update((arr) => [...arr.filter((x) => x.id !== p.id), p]),
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
      },
    };
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
