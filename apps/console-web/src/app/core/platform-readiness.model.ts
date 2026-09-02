export type BackboneComponentId = 'supabase' | 'gitea' | 'release' | 'beszel';

export interface BackboneReadinessComponent {
  id: BackboneComponentId;
  label: string;
  authority: string;
  endpoint: string;
  route: string;
  ready: boolean;
  state: 'Ready' | 'Attention' | 'AuthorityUnavailable';
  detail: string;
  observedAt: string;
  evidence: Record<string, unknown> | null;
}

export interface PlatformReadinessStatus {
  schemaVersion: '1.0';
  kind: 'ConsoleBackboneReadiness';
  observedAt: string;
  phase: 'Ready' | 'Attention';
  ready: boolean;
  components: BackboneReadinessComponent[];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function evaluateSupabaseReadiness(document: Record<string, unknown>): { ready: boolean; detail: string } {
  const data = asRecord(document['data']);
  const components = Array.isArray(data['components']) ? data['components'] as Record<string, unknown>[] : [];
  const count = components.filter((component) => component['state'] === 'Ready').length;
  return {
    ready: components.length > 0 && count === components.length,
    detail: components.length ? count + '/' + components.length + ' services Ready' : 'Supabase component evidence is absent',
  };
}
export function evaluateReleaseLockReadiness(document: Record<string, unknown>): { ready: boolean; detail: string } {
  const current = asRecord(document['current']);
  const execution = asRecord(document['execution']);
  const digest = String(current['releaseDigest'] || '');
  const channel = String(current['channel'] || 'unknown');
  const ready = /^sha256:[a-f0-9]{64}$/.test(digest);
  if (!ready) return { ready: false, detail: 'Installed release lock evidence is incomplete' };
  const executor = execution['ready'] === true
    ? 'separate executor Ready'
    : `separate executor ${String(execution['state'] || 'inactive')}`;
  return {
    ready: true,
    detail: `Installed ${channel} release · ${digest.slice(0, 19)}… · ${executor}`,
  };
}