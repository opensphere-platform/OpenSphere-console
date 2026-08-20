export interface ExtensionRouteTarget {
  hostId: string;
  childId: string;
}
export const TRANSIENT_EXTENSION_RETRY_DELAY_MS = 250;

/** Only transport interruption and timeout failures are safe to retry. */
export function isTransientExtensionLoadError(error: unknown): boolean {
  const candidate = error as { name?: unknown; message?: unknown } | null;
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error);
  return ['AbortError', 'TimeoutError', 'HttpRequestTimeoutError'].includes(name)
    || /request timed out|signal is aborted|failed to fetch|networkerror/i.test(message);
}

/**
 * Returns canonical extension ownership segments. Foundation exposes its
 * hosted plugins through `/pfss/<plugin>` while other subShells retain the
 * generic `/p/<subShell>[/<plugin>]` route.
 * Native Console routes never influence extension activation order.
 */
export function extensionRouteTarget(pathname: string): ExtensionRouteTarget {
  const segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments[0] === 'pfss') {
    return {
      hostId: 'foundation',
      childId: segments[1] && segments[1] !== 'foundation' ? segments[1] : '',
    };
  }
  if (segments[0] !== 'p') return { hostId: '', childId: '' };
  return { hostId: segments[1] || '', childId: segments[2] || '' };
}
