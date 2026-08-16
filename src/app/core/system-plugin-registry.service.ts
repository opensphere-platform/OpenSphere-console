import { Injectable, signal } from '@angular/core';
import type { Capability } from '@opensphere/sdk';
import { CONSOLE_COMPOSITION_MANIFEST, validateConsoleComposition } from './console-composition.manifest';
import type { SystemPluginContractFailure, SystemPluginDescriptor } from './system-plugin-contract';

export type { SystemPluginCategory, SystemPluginContractFailure, SystemPluginDescriptor } from './system-plugin-contract';

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
    const failures = [...validateConsoleComposition(CONSOLE_COMPOSITION_MANIFEST)];
    const invalidIds = new Set(failures.map((failure) => failure.id));
    for (const descriptor of CONSOLE_COMPOSITION_MANIFEST.systemPlugins) {
      if (!invalidIds.has(descriptor.id)) this.descriptors.set(descriptor.id, Object.freeze(descriptor));
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
}
