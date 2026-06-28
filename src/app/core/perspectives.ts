/**
 * 플러그인 라우트 경로 계약 — 등록된 모든 플러그인(subShell·plugin)은 `/p/<id>` 동적 호스트로 진입.
 *
 * ADR-UI-003 §3.3 (메뉴 출처 규칙): 콘솔 메뉴는 ① mainShell native 구현 또는 ② DUPA 동적 등록,
 * 둘 중 하나여야 한다. "예정된" 하드코딩 perspective 슬러그/클린라우트는 그 자체가 위반이므로 제거했다.
 * (구 PERSPECTIVE_SLUGS 10개 = 미등록 plugin용 phantom 라우트 → 삭제.)
 * 클린 라우트(`/cluster` 등)가 필요하면 등록 manifest가 선언하도록 후속 — 셸이 미리 박지 않는다.
 */
export function routeForPlugin(id: string): string {
  return `/p/${id}`;
}
