export interface ExtensionRouteEntry {
  id: string;
  hostRef?: string;
}

export interface ExtensionRouteTarget {
  hostId: string;
  childId: string;
}

export const EXTENSION_ACTIVATION_CONCURRENCY = 3;
export const CHILD_EXTENSION_ACTIVATION_CONCURRENCY = 2;
export const TRANSIENT_EXTENSION_RETRY_DELAY_MS = 250;

/**
 * Loading every signed extension at once creates a burst of manifest,
 * signature, entry and asset requests. Keep that work bounded while retaining
 * registry order inside each worker.
 */
export async function loadWithConcurrency<T>(
  entries: readonly T[],
  load: (entry: T) => Promise<void>,
  concurrency = EXTENSION_ACTIVATION_CONCURRENCY,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('extension activation concurrency must be a positive integer');
  }
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < entries.length) {
      const entry = entries[nextIndex++];
      await load(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
}

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

/**
 * A cold Console must establish the subShell requested by the current deep
 * link before spending time verifying unrelated extensions. The remaining
 * entries keep registry order so this is prioritisation, not a second source
 * of lifecycle truth.
 */
export function prioritizeRequestedHost<T extends ExtensionRouteEntry>(entries: readonly T[], pathname: string): T[] {
  const { hostId } = extensionRouteTarget(pathname);
  if (!hostId) return [...entries];
  const requested = entries.find((entry) => entry.id === hostId && (entry.hostRef ?? 'main') === 'main');
  if (!requested) return [...entries];
  return [requested, ...entries.filter((entry) => entry !== requested)];
}
