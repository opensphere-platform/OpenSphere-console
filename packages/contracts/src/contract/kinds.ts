/**
 * C3 — Component kind. 3-tier 셸의 host/guest 경계를 1급 개념으로 정의한다.
 *
 *   mainShell : 루트 host. 레지스트리·신뢰루트·라우팅·전역표면(검색/알림/nav 집계)을 소유.
 *   subShell  : guest이면서 동시에 host(1급, 결정 2026-06-25). mainShell의 guest로 로드되며,
 *               자기 자식 plugin에게 스코프된 컨텍스트를 재노출한다(자기 검색·nav·plugin 호스팅).
 *               도메인 상위 모듈(예: foundation-shell, ai-shell).
 *   plugin    : 리프 guest. 페이지/기여만 한다. 자식을 호스팅하지 않는다.
 *
 * (이전 extension-host는 전부 평면 'plugin'으로 취급했다 — 이 kind가 그 모호성을 해소.)
 */
export type ComponentKind = 'mainShell' | 'subShell' | 'plugin';

/** 자식을 로드·집계할 수 있는(=host가 될 수 있는) kind. */
export const HOST_KINDS: readonly ComponentKind[] = ['mainShell', 'subShell'];

/** kind가 host 역할을 할 수 있는가. */
export const isHostKind = (k: ComponentKind): boolean => HOST_KINDS.includes(k);
