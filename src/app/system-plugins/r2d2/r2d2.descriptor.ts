import type { SystemPluginDescriptor } from '../../core/system-plugin-contract';

/** Console-owned, release-bound R2D2 AI orchestration descriptor. */
export const R2D2_SYSTEM_PLUGIN = Object.freeze({
  schemaVersion: 1,
  id: 'r2d2',
  displayName: 'R2D2',
  category: 'AI Orchestration',
  kind: 'systemPlugin',
  owner: 'cbss-main-shell',
  route: '/manage/osaa',
  requestedCapabilities: [],
  grantedCapabilities: [],
  defaultEnabled: false,
  sessionClass: 'governed-orchestration',
  runtimeAdapterId: 'cbss.osaa-gateway',
  releaseAuthority: 'opensphere-console-exact-digest',
} as const satisfies SystemPluginDescriptor);
