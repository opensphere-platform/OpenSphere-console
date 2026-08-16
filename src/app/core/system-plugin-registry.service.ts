import { Injectable, signal } from '@angular/core';
import type { Capability } from '@opensphere/sdk';
import { OS_SHELL_SYSTEM_PLUGIN } from '../system-plugins/os-shell/os-shell.descriptor';
import { R2D2_SYSTEM_PLUGIN } from '../system-plugins/r2d2/r2d2.descriptor';

export type SystemPluginCategory = 'Developer Tools' | 'AI Orchestration';

export interface SystemPluginDescriptor {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly category: SystemPluginCategory;
  readonly kind: 'systemPlugin';
  readonly owner: string;
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

/**
 * Compile-time CBSS feature inventory. It is deliberately separate from the
 * DUPA Registry: a system plugin cannot acquire an independent image,
 * Registration, service account or lifecycle outside the Console release.
 */
@Injectable({ providedIn: 'root' })
export class SystemPluginRegistryService {
  private readonly descriptors = new Map<string, SystemPluginDescriptor>();
  readonly failures = signal<readonly SystemPluginContractFailure[]>([]);
  readonly initialized = signal(false);

  initialize(): void {
    if (this.initialized()) return;
    const failures: SystemPluginContractFailure[] = [];
    for (const descriptor of [OS_SHELL_SYSTEM_PLUGIN, R2D2_SYSTEM_PLUGIN] as readonly SystemPluginDescriptor[]) {
      const issue = this.validate(descriptor);
      if (issue) failures.push({ id: descriptor.id, ...issue });
      else this.descriptors.set(descriptor.id, Object.freeze(descriptor));
    }
    this.failures.set(Object.freeze(failures));
    this.initialized.set(true);
  }

  get(id: string): SystemPluginDescriptor | undefined {
    this.initialize();
    return this.descriptors.get(id);
  }

  list(): readonly SystemPluginDescriptor[] {
    this.initialize();
    return Object.freeze([...this.descriptors.values()]);
  }

  hasGrant(id: string, capability: Capability): boolean {
    return this.get(id)?.grantedCapabilities.includes(capability) === true;
  }

  private validate(descriptor: SystemPluginDescriptor): { code: string; detail: string } | null {
    if (descriptor.schemaVersion !== 1 || descriptor.kind !== 'systemPlugin') {
      return { code: 'SystemPluginSchemaInvalid', detail: 'schemaVersion=1 and kind=systemPlugin are required.' };
    }
    if (!ID.test(descriptor.id) || !descriptor.displayName.trim() || !descriptor.owner.trim()) {
      return { code: 'SystemPluginIdentityInvalid', detail: 'id, displayName and owner must be closed, non-empty identifiers.' };
    }
    if (!['Developer Tools', 'AI Orchestration'].includes(descriptor.category)) {
      return { code: 'SystemPluginCategoryInvalid', detail: 'category must be a supported Console-owned capability class.' };
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
}
