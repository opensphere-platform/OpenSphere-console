const STALE_LAZY_CHUNK_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk [^ ]+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
];

interface LazyChunkRecoveryBrowser {
  readonly location: Pick<Location, 'href' | 'reload'>;
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown; message?: unknown };
    return `${String(candidate.name || '')}: ${String(candidate.message || '')}`;
  }
  return String(error || '');
}

function retryKey(systemPluginId: string): string {
  return `opensphere.system-plugin.${systemPluginId}.lazy-chunk-retry`;
}

function activeBrowser(): LazyChunkRecoveryBrowser | null {
  return typeof window === 'undefined' ? null : window;
}

export function isStaleLazyChunkError(error: unknown): boolean {
  const text = errorText(error);
  return STALE_LAZY_CHUNK_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A tab opened before a Console rollout can request a lazy chunk that the new
 * immutable image no longer contains. Reload the document once so index.html
 * and its chunks come from one revision. A session marker prevents loops when
 * the failure is a real deployment defect rather than a stale tab.
 */
export function recoverStaleLazyChunkOnce(
  systemPluginId: string,
  error: unknown,
  browser: LazyChunkRecoveryBrowser | null = activeBrowser(),
): boolean {
  if (!browser || !isStaleLazyChunkError(error)) return false;

  try {
    const key = retryKey(systemPluginId);
    if (browser.sessionStorage.getItem(key) === browser.location.href) return false;
    browser.sessionStorage.setItem(key, browser.location.href);
    browser.location.reload();
    return true;
  } catch {
    return false;
  }
}

export function clearStaleLazyChunkRetry(
  systemPluginId: string,
  browser: LazyChunkRecoveryBrowser | null = activeBrowser(),
): void {
  if (!browser) return;
  try {
    browser.sessionStorage.removeItem(retryKey(systemPluginId));
  } catch {
    // Storage can be unavailable under a restricted browser policy. A
    // successful module load needs no recovery in that case.
  }
}
