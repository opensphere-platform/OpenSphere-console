import { OS_SHELL_SYSTEM_PLUGIN } from '../system-plugins/os-shell/os-shell.descriptor';
import { R2D2_SYSTEM_PLUGIN } from '../system-plugins/r2d2/r2d2.descriptor';
import type { SystemPluginContractFailure, SystemPluginDescriptor } from './system-plugin-contract';
import { validateSystemPluginDescriptor } from './system-plugin-contract';

export interface CoreSurfaceDescriptor {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'coreSurface';
  readonly owner: 'cbss-main-shell';
  readonly route: `/${string}`;
  readonly lifecycle: 'console-release';
  readonly required: true;
}

export interface ConsoleCompositionManifest {
  readonly schemaVersion: 1;
  readonly host: 'cbss-main-shell';
  readonly coreSurfaces: readonly CoreSurfaceDescriptor[];
  readonly systemPlugins: readonly SystemPluginDescriptor[];
}

export const MANUAL_CORE_SURFACE = Object.freeze({
  schemaVersion: 1,
  id: 'manual',
  displayName: 'Manual',
  kind: 'coreSurface',
  owner: 'cbss-main-shell',
  route: '/manual',
  lifecycle: 'console-release',
  required: true,
} as const satisfies CoreSurfaceDescriptor);

/**
 * Main Shell composition authority. Core surfaces and built-in system plugins
 * are deliberately separate from the optional DUPA Registry lifecycle.
 */
export const CONSOLE_COMPOSITION_MANIFEST = Object.freeze({
  schemaVersion: 1,
  host: 'cbss-main-shell',
  coreSurfaces: Object.freeze([MANUAL_CORE_SURFACE]),
  systemPlugins: Object.freeze([OS_SHELL_SYSTEM_PLUGIN, R2D2_SYSTEM_PLUGIN]),
} as const satisfies ConsoleCompositionManifest);

export function validateConsoleComposition(
  manifest: ConsoleCompositionManifest,
): readonly SystemPluginContractFailure[] {
  const failures: SystemPluginContractFailure[] = [];
  const ids = new Set<string>();
  const routes = new Set<string>();

  if (manifest.schemaVersion !== 1 || manifest.host !== 'cbss-main-shell') {
    failures.push({
      id: 'console-composition',
      code: 'ConsoleCompositionSchemaInvalid',
      detail: 'schemaVersion=1 and host=cbss-main-shell are required.',
    });
  }

  for (const surface of manifest.coreSurfaces) {
    if (surface.schemaVersion !== 1 || surface.kind !== 'coreSurface' || surface.owner !== manifest.host
      || surface.lifecycle !== 'console-release' || surface.required !== true
      || !surface.id || !surface.displayName.trim() || !surface.route.startsWith('/') || surface.route.startsWith('/p/')) {
      failures.push({ id: surface.id || 'core-surface', code: 'CoreSurfaceContractInvalid', detail: 'core surface contract is not closed.' });
      continue;
    }
    if (ids.has(surface.id) || routes.has(surface.route)) {
      failures.push({ id: surface.id, code: 'ConsoleCompositionCollision', detail: 'composition ids and routes must be unique.' });
      continue;
    }
    ids.add(surface.id);
    routes.add(surface.route);
  }

  for (const descriptor of manifest.systemPlugins) {
    const issue = validateSystemPluginDescriptor(descriptor);
    if (issue) {
      failures.push({ id: descriptor.id, ...issue });
      continue;
    }
    if (ids.has(descriptor.id) || routes.has(descriptor.route)) {
      failures.push({ id: descriptor.id, code: 'ConsoleCompositionCollision', detail: 'composition ids and routes must be unique.' });
      continue;
    }
    ids.add(descriptor.id);
    routes.add(descriptor.route);
  }

  return Object.freeze(failures);
}
