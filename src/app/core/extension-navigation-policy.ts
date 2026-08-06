export interface ExtensionNavigationOwner {
  id: string;
  available?: boolean;
  kind?: 'subShell' | 'plugin';
  componentKind?: 'subShell' | 'plugin';
  hostRef?: string;
}

/**
 * Main Shell first-level navigation is an ownership boundary, not a catalog
 * projection. Only a verified, available subShell directly hosted by Main
 * Shell may own a first-level entry. A child plugin remains addressable by its
 * host even when it contributes a page or a navigation band.
 */
export function isMainShellPrimaryNavigationOwner(entry: ExtensionNavigationOwner): boolean {
  return entry.available === true
    && (entry.componentKind ?? entry.kind) === 'subShell'
    && (entry.hostRef ?? 'main') === 'main';
}
