import type { Capability } from '@opensphere/sdk';

export type SystemPluginCategory = 'Developer Tools' | 'AI Orchestration';

export interface SystemPluginDescriptor {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly category: SystemPluginCategory;
  readonly kind: 'systemPlugin';
  readonly owner: 'cbss-main-shell';
  readonly route: `/${string}`;
  readonly framePath?: `/${string}`;
  readonly requestedCapabilities: readonly Capability[];
  readonly grantedCapabilities: readonly Capability[];
  readonly defaultEnabled: false;
  readonly sessionClass?: string;
  readonly runtimeAdapterId?: string;
  readonly releaseAuthority: 'opensphere-console-exact-digest';
}

export interface SystemPluginContractFailure {
  readonly id: string;
  readonly code: string;
  readonly detail: string;
}

const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CATEGORIES: readonly SystemPluginCategory[] = ['Developer Tools', 'AI Orchestration'];

export function validateSystemPluginDescriptor(
  descriptor: SystemPluginDescriptor,
): { code: string; detail: string } | null {
  if (descriptor.schemaVersion !== 1 || descriptor.kind !== 'systemPlugin') {
    return { code: 'SystemPluginSchemaInvalid', detail: 'schemaVersion=1 and kind=systemPlugin are required.' };
  }
  if (!ID.test(descriptor.id) || !descriptor.displayName.trim()) {
    return { code: 'SystemPluginIdentityInvalid', detail: 'id and displayName must be closed, non-empty identifiers.' };
  }
  if (descriptor.owner !== 'cbss-main-shell' || !CATEGORIES.includes(descriptor.category)) {
    return { code: 'SystemPluginOwnershipInvalid', detail: 'owner and category must be closed Console-owned values.' };
  }
  if (!descriptor.route.startsWith('/') || descriptor.route.startsWith('/p/')) {
    return { code: 'SystemPluginRouteInvalid', detail: 'a CBSS system plugin must use a Host-owned route outside /p.' };
  }
  if (descriptor.defaultEnabled !== false || descriptor.releaseAuthority !== 'opensphere-console-exact-digest') {
    return { code: 'SystemPluginAuthorityInvalid', detail: 'system plugins are default-off and bound to the Console exact digest.' };
  }
  const requested = new Set(descriptor.requestedCapabilities);
  if (descriptor.grantedCapabilities.some((capability) => !requested.has(capability))) {
    return { code: 'SystemPluginGrantInvalid', detail: 'a grant must be a subset of requested capabilities.' };
  }
  return null;
}
