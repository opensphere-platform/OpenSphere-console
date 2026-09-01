/**
 * C1 — Capability(scope) 어휘. host↔guest 계약에서 guest가 요청할 수 있는 능력의 "닫힌 집합".
 *
 * 각 capability = 이름 + 부여 시 노출되는 ctx 표면(context.ts) + 위험등급 + 한줄 설명.
 * 카탈로그를 **데이터로 노출**한다 → 셸·검증기·문서·CLI가 같은 목록을 소비(console==cli).
 * 닫힌 집합 원칙: 여기 없는 scope를 manifest가 선언하면 host가 fail-closed로 거부한다.
 */
export const CAPABILITIES = {
  'page:register': {
    risk: 'low',
    ctx: 'extensions.registerPage',
    summary: '플러그인 페이지를 셸 라우트(/p/<id>)에 등록. UI 플러그인 필수 권한.',
  },
  'api:proxy': {
    risk: 'medium',
    ctx: 'api.baseUrl',
    summary: '선언한 apiBase로의 백엔드 프록시 접근(셸이 사용자 토큰을 임퍼소네이트해 호출).',
  },
  'nav:contribute': {
    risk: 'low',
    ctx: 'extensions.nav',
    summary: '런타임에 내비 트리(NavNode[])를 기여 — 셸이 집계·렌더(진실 출처=플러그인).',
  },
  'notify:publish': {
    risk: 'medium',
    ctx: 'notify',
    summary: '셸 단일 알림 인박스에 이벤트 발행. 출처는 pluginId로 강제 태깅(위조 불가).',
  },
  'search:contribute': {
    risk: 'low',
    ctx: 'extensions.search',
    summary: '검색 provider(동기/비동기)를 기여 — 클라이언트 콘텐츠를 검색에 노출. 출처 태깅.',
  },
  'manual:contribute': {
    risk: 'medium',
    ctx: 'extensions.manual',
    summary: 'canonical Manual source를 기여 — Host가 sourceId·문서 ID·route를 검증하고 태깅.',
  },
  'identity:read': {
    risk: 'medium',
    ctx: 'identity',
    summary: '검증된 읽기전용 사용자 정체성(user·groups·roles)을 제공. raw token은 노출하지 않음.',
  },
  'session:attach': {
    risk: 'high',
    ctx: 'session',
    audience: 'system',
    summary: 'CBSS durable operator session에 Host 발급 one-time ticket으로 PTY stream을 attach. 기본 disabled이며 명시 승인 필요.',
  },
} as const;

/** 부여 가능한 capability 이름. manifest.permissions의 원소 타입. */
export type Capability = keyof typeof CAPABILITIES;

/** 닫힌 집합 검사 — host가 미지 scope를 거부할 때 사용. */
export const isKnownCapability = (s: string): s is Capability =>
  Object.prototype.hasOwnProperty.call(CAPABILITIES, s);

/** Built-in Host descriptor만 요청할 수 있고 외부 ModulePackage에는 노출하지 않는 capability. */
export const isSystemOnlyCapability = (s: string): s is Capability =>
  isKnownCapability(s) && 'audience' in CAPABILITIES[s] && CAPABILITIES[s].audience === 'system';

/**
 * 예약 capability — 설계됐으나 미구현(단계적 도입). 선언은 아직 거부된다.
 *   command:contribute — (UI) 명령 팔레트에 액션 명령 기여(이동 외 실행).
 */
export const RESERVED_CAPABILITIES = {
  'command:contribute': '(UI) 명령 팔레트에 액션 명령 기여(navigation 외 실행).',
} as const;

/**
 * C2 — Headless binding 어휘(2026-07-06 신설, cli:contribute).
 *
 * ⚠️ CAPABILITIES(위)와 계층이 다르다: CAPABILITIES는 **브라우저 ctx 능력**(플러그인 JS가
 * 런타임에 ctx.extensions.*를 호출)이라 signed manifest.permissions로 게이트한다. 반면
 * cli:contribute는 브라우저가 개입하지 않는 **headless binding**이다 — os CLI 바이너리가
 * registry에서 namespace를 발견해 플러그인 백엔드로 직접 HTTP 디스패치한다(CLIDownload와 동류).
 * 따라서 signed manifest가 아니라 **UIPluginPackage.spec.cli**(CR·registry 권위)로 선언·광고하며,
 * 브라우저 closed-set(isKnownCapability)에는 넣지 않는다(넣으면 GUI가 오분류·거부).
 *
 * 선언 형태(UIPluginPackage.spec.cli):
 *   { namespace: "ad", manifestPath: "/cli/manifest" }
 * 광고(GET /api/v1/registry): plugin 항목에 cli:{namespace,manifestPath} 투영(console==cli).
 * 디스패치: os <namespace> <verb ...> → 플러그인 백엔드 <apiBase><manifestPath>의 command manifest
 *   (OAHAgentToolManifest와 동일 스키마)를 조회해 os가 재빌드 없이 실행(os ai가 첫 사례).
 */
export const BINDING_CONTRIBUTIONS = {
  'cli:contribute':
    'os CLI에 도메인 명령 네임스페이스(os <ns> <verb>)를 기여 — UIPluginPackage.spec.cli로 선언, registry가 광고, os가 동적 디스패치(headless, 브라우저 무관).',
} as const;
