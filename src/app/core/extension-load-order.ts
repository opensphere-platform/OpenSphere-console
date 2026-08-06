export interface ExtensionRouteEntry {
  id: string;
  hostRef?: string;
}

export interface ExtensionRouteTarget {
  hostId: string;
  childId: string;
}

/**
 * Returns only the canonical `/p/<subShell>[/<plugin>]` ownership segments.
 * Native Console routes never influence extension activation order.
 */
export function extensionRouteTarget(pathname: string): ExtensionRouteTarget {
  const segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
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
