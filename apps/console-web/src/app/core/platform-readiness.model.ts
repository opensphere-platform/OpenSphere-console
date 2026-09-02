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