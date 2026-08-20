export const CONSOLE_NAVIGATION_SNAPSHOT_VERSION = 1 as const;
export const CONSOLE_NAVIGATION_STORAGE_KEY = 'opensphere.console.navigation.v1';

export interface ConsoleNavigationItem {
  id: string;
  title: string;
  navBand: string;
  route: string;
  icon: string;
  manifestSha256: string;
}

export interface ConsoleNavigationSnapshot {
  version: typeof CONSOLE_NAVIGATION_SNAPSHOT_VERSION;
  observedAt: string;
  registryFingerprint: string;
  items: readonly ConsoleNavigationItem[];
}

export interface NavigationRegistryEntry {
  id: string;
  manifestSha256: string;
  kind?: 'subShell' | 'plugin';
  componentKind?: 'subShell' | 'plugin';
  hostRef?: string;
  icon?: string;
}

export interface NavigationInventoryEntry {
  id: string;
  title: string;
  navBand: string;
  hostRef: string;
  kind?: 'subShell' | 'plugin';
  icon?: string;
}

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_ITEMS = 64;

function routeForNavigationItem(id: string): string {
  return id === 'foundation' ? '/pfss/foundation' : `/p/${id}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return null;
  return value;
}

function parseItem(value: unknown): ConsoleNavigationItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, ['id', 'title', 'navBand', 'route', 'icon', 'manifestSha256'])) return null;
  const id = text(item['id'], 64);
  const title = text(item['title'], 160);
  const navBand = text(item['navBand'], 80);
  if (!id || !ID.test(id) || !title || !navBand) return null;
  if (item['route'] !== routeForNavigationItem(id)) return null;
  if (typeof item['icon'] !== 'string' || item['icon'].length > 96 || /[\r\n]/.test(item['icon'])) return null;
  if (typeof item['manifestSha256'] !== 'string' || !SHA256.test(item['manifestSha256'])) return null;
  return Object.freeze({
    id,
    title,
    navBand,
    route: item['route'],
    icon: item['icon'],
    manifestSha256: item['manifestSha256'],
  });
}

/**
 * Parses the last-known navigation projection as display-only data. It never
 * authorizes guest execution: route activation still traverses Registry pins,
 * signatures, permissions and artifact digests in ExtensionHostService.
 */
export function parseConsoleNavigationSnapshot(value: unknown): ConsoleNavigationSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (!exactKeys(snapshot, ['version', 'observedAt', 'registryFingerprint', 'items'])) return null;
  if (snapshot['version'] !== CONSOLE_NAVIGATION_SNAPSHOT_VERSION) return null;
  if (typeof snapshot['observedAt'] !== 'string' || !ISO_UTC.test(snapshot['observedAt'])) return null;
  if (typeof snapshot['registryFingerprint'] !== 'string' || !snapshot['registryFingerprint'] || snapshot['registryFingerprint'].length > 500000) return null;
  if (!Array.isArray(snapshot['items']) || snapshot['items'].length > MAX_ITEMS) return null;
  const items = snapshot['items'].map(parseItem);
  if (items.some((item) => item === null)) return null;
  const resolved = items as ConsoleNavigationItem[];
  if (new Set(resolved.map((item) => item.id)).size !== resolved.length) return null;
  return Object.freeze({
    version: CONSOLE_NAVIGATION_SNAPSHOT_VERSION,
    observedAt: snapshot['observedAt'],
    registryFingerprint: snapshot['registryFingerprint'],
    items: Object.freeze(resolved),
  });
}

export function parseStoredConsoleNavigationSnapshot(raw: string | null): ConsoleNavigationSnapshot | null {
  if (!raw) return null;
  try {
    return parseConsoleNavigationSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Builds one atomic first-level projection from control inventory + Registry. */
export function buildConsoleNavigationSnapshot(
  registryEntries: readonly NavigationRegistryEntry[],
  inventoryEntries: readonly NavigationInventoryEntry[],
  registryFingerprint: string,
  observedAt = new Date().toISOString(),
): ConsoleNavigationSnapshot {
  const activeById = new Map(registryEntries
    .filter((entry) =>
      (entry.componentKind ?? entry.kind) === 'subShell'
      && (entry.hostRef ?? 'main') === 'main'
      && ID.test(entry.id)
      && SHA256.test(entry.manifestSha256),
    )
    .map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const items: ConsoleNavigationItem[] = [];
  for (const inventory of inventoryEntries) {
    const registry = activeById.get(inventory.id);
    if (!registry || seen.has(inventory.id)) continue;
    if (inventory.kind !== 'subShell' || inventory.hostRef !== 'main') continue;
    const item = parseItem({
      id: inventory.id,
      title: inventory.title,
      navBand: inventory.navBand,
      route: routeForNavigationItem(inventory.id),
      icon: inventory.icon || registry.icon || '',
      manifestSha256: registry.manifestSha256,
    });
    if (!item) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length === MAX_ITEMS) break;
  }
  const snapshot = parseConsoleNavigationSnapshot({
    version: CONSOLE_NAVIGATION_SNAPSHOT_VERSION,
    observedAt,
    registryFingerprint,
    items,
  });
  if (!snapshot) throw new Error('ConsoleNavigationSnapshot construction failed');
  return snapshot;
}
