/**
 * 10 Perspective 슬러그 — 클린 URL의 단일 소스.
 * 플러그인 id == 라우트 슬러그(예: id 'user' → 라우트 '/user', 트리 nav 링크 '/user').
 * 'opensphere'·'pNN'은 설계 개념이며 URL에 노출하지 않는다.
 * app.routes.ts(정적 라우트 생성) + os-shell.ts(클린 nav 링크 분기)가 공유한다.
 */
export const PERSPECTIVE_SLUGS = [
  'os-level',   // 1 OS Level
  'cluster',    // 2 K8s Cluster + Ceph
  'user',       // 3 User
  'developer',  // 4 Developer
  'ai',         // 5 AI Level
  'api',        // 6 API = 정보 흐름
  'workspace',  // 7 Workspace (내부)
  'customer',   // 8 Customer
  'edge',       // 9 대외 웹서비스
  'website',    // 10 WebSite
] as const;

export type PerspectiveSlug = (typeof PERSPECTIVE_SLUGS)[number];

const SLUG_SET = new Set<string>(PERSPECTIVE_SLUGS);

/** 이 플러그인 id가 perspective 슬러그면 클린 라우트(`/<id>`), 아니면 `/p/<id>`. */
export function isPerspectiveSlug(id: string): boolean {
  return SLUG_SET.has(id);
}

/** nav/라우트 경로 계약: perspective는 클린, 그 외 플러그인은 /p/ 접두. */
export function routeForPlugin(id: string): string {
  return isPerspectiveSlug(id) ? `/${id}` : `/p/${id}`;
}
