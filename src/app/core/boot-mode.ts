/**
 * Captured once, before Angular bootstrap and before any Extension Host guest
 * can execute. A standalone OS Shell document can never transition into the
 * ordinary plugin-bearing SPA during the lifetime of this JavaScript realm.
 */
export const OS_SHELL_STANDALONE_BOOT = window.location.pathname === '/shell';
