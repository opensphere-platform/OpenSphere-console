import type { SystemPluginDescriptor } from '../../core/system-plugin-contract';

/** CBSS-owned, Console-release-bound OS Shell descriptor. */
export const OS_SHELL_SYSTEM_PLUGIN = Object.freeze({
  schemaVersion: 1,
  id: 'os-shell',
  displayName: 'OS Shell',
  category: 'Developer Tools',
  kind: 'systemPlugin',
  owner: 'cbss-main-shell',
  route: '/shell',
  framePath: '/os-shell-frame/index.html',
  requestedCapabilities: ['session:attach'],
  grantedCapabilities: ['session:attach'],
  defaultEnabled: false,
  sessionClass: 'operator-interactive',
  runtimeAdapterId: 'cbss.kubernetes-pod',
  releaseAuthority: 'opensphere-console-exact-digest',
} as const satisfies SystemPluginDescriptor);
