export const COMPONENT_IDS = ['database', 'auth', 'dataApi', 'storage', 'migration', 'rls', 'backup', 'restore'] as const;
export type ComponentId = typeof COMPONENT_IDS[number];
export type HealthState = 'Ready' | 'Unknown' | 'Blocked' | 'Degraded' | 'Partial';
export interface ProtectionCheck { table: string; protection: string; state: HealthState; reasonCode: string | null }
export interface IdentityComponent {
  component: ComponentId; state: HealthState; authority: string; reasonCode: string | null;
  observedAt?: string; baselineRevision?: string | null; setDigest?: string | null; migrationCount?: number;
  authorityTables?: number; protectedTables?: number; scope?: string; checks?: ProtectionCheck[];
  expected?: { baselineRevision: string; setDigest: string; migrationCount: number };
}
export interface RecoveryDomain {
  domain: string; backupState: HealthState; restoreState: HealthState; checksumRecorded: boolean;
  backupVerifiedAt: string | null; restoreVerifiedAt: string | null; reasonCode: string | null;
  checks: { assertion: string; expected: string; observed: number | null; state: HealthState }[];
}
export interface IdentityStatus {
  schemaVersion: '1.0'; authority: string; observedAt: string; freshness: 'fresh' | 'stale' | 'unknown' | 'unavailable';
  correlationId: string; evidenceRefs: string[];
  data: {
    state: HealthState; required: boolean; components: IdentityComponent[];
    inventory: { operators: number; activeSessions: number; auditEvents: number;
      roles: { name: string; description: string }[];
      buckets: { id: string; name: string; public: boolean; fileSizeLimit: number | null }[];
      accessBindings: { role: string; schema: string; executableFunctions: number; selectableTables: number }[];
    };
    recovery: { state: HealthState; reasonCode: string | null; observedAt: string; generatedAt: string | null;
      maxAgeSeconds: number | null; domains: RecoveryDomain[] };
  };
}
const states = new Set(['Ready','Unknown','Blocked','Degraded','Partial']);
const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown) => v === null || date(v);
const reason = (v: unknown) => v === null || typeof v === 'string';
const rows = (v: unknown, check: (v: any) => boolean): boolean => Array.isArray(v) && v.length <= 1000 && v.every(x => record(x) && check(x));

/** Validate the actual ReadEnvelope before Angular ever evaluates a template. */
export function parseIdentityStatus(value: unknown): IdentityStatus {
  const fail = () => { throw new Error('DataIdentityContractInvalid'); };
  if (!record(value) || value['schemaVersion'] !== '1.0' || value['authority'] !== 'Supabase'
    || !date(value['observedAt']) || !['fresh','stale','unknown','unavailable'].includes(value['freshness'])
    || typeof value['correlationId'] !== 'string' || !Array.isArray(value['evidenceRefs'])
    || !value['evidenceRefs'].every((r: unknown) => typeof r === 'string')) return fail();
  const d = value['data'];
  if (!record(d) || !states.has(d['state']) || d['required'] !== true
    || !rows(d['components'], c => COMPONENT_IDS.includes(c.component) && states.has(c.state)
      && typeof c.authority === 'string' && reason(c.reasonCode))) return fail();
  const ids = d['components'].map((c: IdentityComponent) => c.component);
  if (ids.length !== COMPONENT_IDS.length || new Set(ids).size !== COMPONENT_IDS.length) return fail();
  const i = d['inventory'];
  if (!record(i) || !count(i['operators']) || !count(i['activeSessions']) || !count(i['auditEvents'])
    || !rows(i['roles'], r => typeof r.name === 'string' && typeof r.description === 'string')
    || !rows(i['buckets'], b => typeof b.id === 'string' && typeof b.name === 'string' && typeof b.public === 'boolean'
      && (b.fileSizeLimit === null || count(b.fileSizeLimit)))
    || !rows(i['accessBindings'], b => typeof b.role === 'string' && typeof b.schema === 'string'
      && count(b.executableFunctions) && count(b.selectableTables))) return fail();
  const r = d['recovery'];
  if (!record(r) || !states.has(r['state']) || !reason(r['reasonCode']) || !date(r['observedAt']) || !nullableDate(r['generatedAt'])
    || !(r['maxAgeSeconds'] === null || count(r['maxAgeSeconds']))
    || !rows(r['domains'], u => typeof u.domain === 'string' && states.has(u.backupState) && states.has(u.restoreState)
      && nullableDate(u.backupVerifiedAt) && nullableDate(u.restoreVerifiedAt) && typeof u.checksumRecorded === 'boolean' && reason(u.reasonCode)
      && rows(u.checks, c => typeof c.assertion === 'string' && typeof c.expected === 'string'
        && (c.observed === null || count(c.observed)) && states.has(c.state)))) return fail();
  for (const c of d['components']) {
    if (c.component === 'rls' && (!count(c.authorityTables) || !count(c.protectedTables)
      || typeof c.scope !== 'string' || !rows(c.checks, x => typeof x.table === 'string' && typeof x.protection === 'string'
        && states.has(x.state) && reason(x.reasonCode)))) return fail();
    if (c.component === 'migration' && (!count(c.migrationCount) || !reason(c.baselineRevision) || !reason(c.setDigest)
      || !record(c.expected) || !count(c.expected.migrationCount) || typeof c.expected.baselineRevision !== 'string'
      || typeof c.expected.setDigest !== 'string')) return fail();
  }
  return value as unknown as IdentityStatus;
}

export function isIdentityFresh(value: IdentityStatus, now = Date.now()): boolean {
  const age = now - Date.parse(value.observedAt);
  return value.freshness === 'fresh' && age >= -5000 && age <= 45000;
}
export function identityRuntimeReady(value: IdentityStatus): boolean {
  return ['database','auth','dataApi','storage','migration','rls'].every(id => value.data.components.find(c => c.component === id)?.state === 'Ready');
}
export function identityFailure(status: number | 'contract' | 'network'): string {
  if (status === 401) return '세션을 확인할 수 없습니다. 다시 로그인한 후 새로고침하세요.';
  if (status === 403) return '조회 권한 console.data_identity.read가 필요합니다. 권한 관리자에게 요청하세요.';
  if (status === 'contract') return '서버 응답 형식이 화면 계약과 다릅니다. 배포 버전과 API 계약을 확인하세요.';
  return '상태를 확인하지 못했습니다. Console API 연결을 확인한 후 다시 시도하세요.';
}
