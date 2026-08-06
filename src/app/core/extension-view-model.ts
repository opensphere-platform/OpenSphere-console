export interface ExtensionCatalogIdentity {
  name: string;
  displayName: string;
  kind: 'subShell' | 'plugin';
  hostRef: string;
}

export interface ExtensionRegistrationIdentity {
  name: string;
}

export interface PluginHostGroup<TRegistration extends ExtensionRegistrationIdentity> {
  hostRef: string;
  hostLabel: string;
  items: TRegistration[];
}

export interface ExtensionManagementViews<TRegistration extends ExtensionRegistrationIdentity> {
  subShells: TRegistration[];
  pluginGroups: PluginHostGroup<TRegistration>[];
  unclassified: TRegistration[];
}

export function buildExtensionManagementViews<TRegistration extends ExtensionRegistrationIdentity>(
  catalog: readonly ExtensionCatalogIdentity[],
  registrations: readonly TRegistration[],
): ExtensionManagementViews<TRegistration> {
  const catalogByName = new Map(catalog.map((item) => [item.name, item]));
  const labelOf = (name: string) => catalogByName.get(name)?.displayName || name;
  const byLabel = (left: TRegistration, right: TRegistration) => labelOf(left.name).localeCompare(labelOf(right.name));
  const subShells: TRegistration[] = [];
  const pluginsByHost = new Map<string, TRegistration[]>();
  const unclassified: TRegistration[] = [];

  for (const registration of registrations) {
    const item = catalogByName.get(registration.name);
    if (!item) {
      unclassified.push(registration);
      continue;
    }
    if (item.kind === 'subShell' && (item.hostRef || 'main') === 'main') {
      subShells.push(registration);
      continue;
    }
    if (item.kind === 'plugin') {
      const hostRef = item.hostRef || 'main';
      const group = pluginsByHost.get(hostRef) || [];
      group.push(registration);
      pluginsByHost.set(hostRef, group);
      continue;
    }
    // A nested subShell is a topology contract violation for first-level
    // management. Keep it visible without pretending it is a plugin.
    unclassified.push(registration);
  }

  return {
    subShells: subShells.sort(byLabel),
    pluginGroups: [...pluginsByHost.entries()]
      .map(([hostRef, items]) => ({
        hostRef,
        hostLabel: hostRef === 'main' ? 'Main Shell' : labelOf(hostRef),
        items: items.sort(byLabel),
      }))
      .sort((left, right) => left.hostLabel.localeCompare(right.hostLabel)),
    unclassified: unclassified.sort(byLabel),
  };
}
