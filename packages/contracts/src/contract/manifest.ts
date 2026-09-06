import type { ComponentKind } from './kinds.js';
import type { Capability } from './capabilities.js';

export const MANIFEST_VERSION = 3 as const;

export interface ContributionDeclaration {
  enabled: boolean;
  /** Required operational explanation when enabled=false. */
  reason?: string;
}

export interface IntegrationContributions {
  page: ContributionDeclaration;
  navigation: ContributionDeclaration & { mode: 'runtime' | 'install-time' | 'none' };
  api: ContributionDeclaration & { basePath?: string };
  cli: ContributionDeclaration & { namespace?: string; manifestPath?: string };
  manual: ContributionDeclaration & { sourceId?: string; mode: 'install-time' | 'runtime' | 'none' };
  search: ContributionDeclaration & { mode: 'runtime' | 'index' | 'none' };
  notification: ContributionDeclaration & { frontend: boolean; backend: boolean };
  observability: ContributionDeclaration & { logs: boolean; metrics: boolean; traces: boolean };
}

/**
 * guest 번들 렌더 모드(결정 2026-06-25):
 *   'esm'        — 서명된 자기완결 단일 ESM(기본·보안기본). 현 7단 신뢰사슬이 그대로 적용.
 *   'federation' — Module Federation. 무거운 subShell의 opt-in(remoteEntry + 청크 무결성 계약 필요).
 */
export type RenderMode = 'esm' | 'federation';

/**
 * 서명 manifest가 고정하는 보조 실행 자산.
 *
 * entry만 검증한 뒤 main.js/styles.css를 다시 URL로 주입하면 신뢰 사슬을 우회하므로,
 * 실행·스타일 자산도 manifest 서명 범위 안에서 개별 sha256으로 고정한다.
 */
export interface ManifestAsset {
  /** guest 안에서 유일한 논리 이름(예: app, styles). */
  id: string;
  /** manifest URL 기준 상대 경로. */
  path: string;
  type: 'module' | 'style' | 'data';
  /** 원본 바이트의 lowercase SHA-256 hex. */
  sha256: string;
}

/**
 * C4 — Package Manifest v3 (SSOT). 셸·SDK·생성기·검증기·CLI가 이 한 스키마를 공유한다.
 *
 * v2 → v3 변경:
 *   + kind        : C3 component kind를 1급화(이전엔 무구분 'plugin').
 *   + sdkVersion  : 이 guest가 빌드된 SDK 버전(호환 추적).
 *   + renderMode  : 'esm'(기본) | 'federation'.
 *   · nav/designSystem를 1급 필드화 — 생성기가 이미 방출하나 v2 타입이 몰라 드리프트였음(해소).
 */
export interface ManifestV3 {
  manifestVersion: typeof MANIFEST_VERSION;
  /** C3 — mainShell은 manifest를 갖지 않음(루트). guest는 subShell|plugin. */
  kind: Exclude<ComponentKind, 'mainShell'>;
  id: string;
  /** canonical parent host identifier. */
  hostRef: string;
  /** API contract exposed by this host when kind=subShell. */
  hostApiVersion?: string;
  /** compatibility range required from hostRef. */
  hostCompat: string;
  /** 자기완결 ESM 상대 경로(renderMode:'esm'). */
  entry: string;
  /** 번들 바이트 sha256 — 무결성 핀. */
  entrySha256: string;
  /** entry가 로드하는 실행·스타일 자산의 무결성 핀. */
  assets?: ManifestAsset[];
  /** 호환 셸 버전 범위(semver). */
  shellCompat: string;
  /** 이 guest가 빌드된 SDK semver. */
  sdkVersion: string;
  /** 닫힌 집합(capabilities.ts)의 부분집합. */
  permissions?: Capability[];
  /** api:proxy 대상 base. */
  apiBase?: string;
  /** 기본 'esm'. */
  renderMode?: RenderMode;
  nav?: { band: string; label: string };
  designSystem?: 'clarity' | 'none';
  contributions: IntegrationContributions;
}

/**
 * @deprecated v2 — kind/sdkVersion/renderMode 이전 형식. 하위호환을 위해 loader가 계속 수용한다.
 * (generate.mjs가 방출하던 nav·designSystem를 1급화 — v2 드리프트도 해소.)
 */
export interface ManifestV2 {
  manifestVersion: 2;
  id: string;
  entry: string;
  entrySha256: string;
  assets?: ManifestAsset[];
  shellCompat: string;
  permissions?: Capability[];
  apiBase?: string;
  nav?: { band: string; label: string };
  designSystem?: 'clarity' | 'none';
}

/** loader가 받는 manifest — v2(레거시) | v3(정본). manifestVersion으로 판별. */
export type Manifest = ManifestV2 | ManifestV3;

/** v2/v3를 균일하게 본 뷰. 누락 필드는 기본값(kind='plugin'·renderMode='esm'·permissions=[]). */
export interface NormalizedManifest {
  manifestVersion: 2 | 3;
  kind: Exclude<ComponentKind, 'mainShell'>;
  id: string;
  hostRef: string;
  hostApiVersion?: string;
  hostCompat: string;
  entry: string;
  entrySha256: string;
  assets: ManifestAsset[];
  shellCompat: string;
  sdkVersion?: string;
  permissions: Capability[];
  apiBase?: string;
  renderMode: RenderMode;
  nav?: { band: string; label: string };
  designSystem?: 'clarity' | 'none';
  contributions: IntegrationContributions;
}

/** v2/v3 manifest를 NormalizedManifest로 정규화(하위호환 기본값 주입). 런타임 헬퍼. */
export function normalizeManifest(m: Manifest): NormalizedManifest {
  const v3 = m.manifestVersion === 3 ? m : null;
  return {
    manifestVersion: m.manifestVersion,
    kind: v3?.kind ?? 'plugin',
    id: m.id,
    hostRef: v3?.hostRef ?? 'main',
    hostApiVersion: v3?.hostApiVersion,
    hostCompat: v3?.hostCompat ?? m.shellCompat,
    entry: m.entry,
    entrySha256: m.entrySha256,
    assets: v3?.assets ?? [],
    shellCompat: m.shellCompat,
    sdkVersion: v3?.sdkVersion,
    permissions: m.permissions ?? [],
    apiBase: m.apiBase,
    renderMode: v3?.renderMode ?? 'esm',
    nav: m.nav,
    designSystem: m.designSystem,
    contributions: v3?.contributions ?? {
			page: { enabled: true },
			navigation: m.nav ? { enabled: true, mode: 'runtime' } : { enabled: false, mode: 'none', reason: 'not declared by legacy manifest' },
			api: m.apiBase ? { enabled: true, basePath: m.apiBase } : { enabled: false, reason: 'not declared by legacy manifest' },
			cli: { enabled: false, reason: 'not declared by legacy manifest' },
			manual: (m.permissions ?? []).includes('manual:contribute')
				? { enabled: true, sourceId: `plugin:${m.id}`, mode: 'runtime' }
				: { enabled: false, sourceId: `plugin:${m.id}`, mode: 'none', reason: 'not declared by legacy manifest' },
			search: (m.permissions ?? []).includes('search:contribute')
				? { enabled: true, mode: 'runtime' }
				: { enabled: false, mode: 'none', reason: 'not declared by legacy manifest' },
			notification: { enabled: false, frontend: false, backend: false, reason: 'not declared by legacy manifest' },
			observability: { enabled: false, logs: false, metrics: false, traces: false, reason: 'not declared by legacy manifest' },
    },
  };
}
