export interface ModuleDefinition {
  id: string; name: string; description: string; stage: string; capabilities: readonly string[];
}
export const PLATFORM_MODULES: readonly ModuleDefinition[] = Object.freeze([
  { id: 'cluster-manager', name: 'OpenSphere-Cluster-Manager', stage: '다음 단계', description: 'Kubernetes 운영 환경, 기초 모듈과 Ceph 저장소를 관리합니다.', capabilities: ['클러스터 상태', '기초 모듈', '스토리지 · Ceph'] },
  { id: 'foundation', name: 'OpenSphere-Foundation', stage: '기반 서비스', description: '제품이 요구하는 데이터·스토리지 등의 기반 서비스를 제공합니다.', capabilities: ['서비스 제공', '소비자 연결', '수명주기'] },
  { id: 'workspace', name: 'OpenSphere-Workspace', stage: '사용자 서비스', description: 'Account, Portal, Apps를 통해 사용자에게 서비스를 제공합니다.', capabilities: ['Account', 'Portal', 'Apps'] },
  { id: 'developer', name: 'OpenSphere-Developer', stage: '개발 환경', description: '프로젝트와 개발 작업을 관리합니다.', capabilities: ['프로젝트', '개발 작업', '산출물'] },
  { id: 'pulse', name: 'OpenSphere-Pulse', stage: '관측', description: '서비스 관측과 운영 상황을 분석합니다.', capabilities: ['Telemetry', 'Topology', 'Incident'] },
  { id: 'ai-workbench', name: 'OpenSphere-AI-Workbench', stage: 'AI 작업', description: 'AI workload와 개발·운영 작업을 구성합니다.', capabilities: ['AI workload', '도구', '실행 관리'] },
]);
export interface ModuleCandidate {
  id: string; class: string; displayName: string;
  release: { version?: string; imageDigest?: string };
  installation: { mode: string; eligible: boolean };
}
export interface ModuleRegistration {
  name: string; desiredState: string; health?: string;
  status: { phase?: string; currentDigest?: string; reason?: string; serving?: { phase?: string }; verification?: { manifest?: string; signature?: string; entryDigest?: string } };
}
export function moduleCatalogFresh(snapshot: {stale: boolean; sources?: Record<string, {ready: boolean; reason?: string}>}): boolean {
  const sources = snapshot.sources;
  if (snapshot.stale !== false || !sources) return false;
  const required = ['extensions.packages', 'extensions.registrations', 'extensions.navigation', 'trust.keys', 'release.inventory'];
  if (!required.every(name => sources[name]?.ready === true)) return false;
  return Object.entries(sources).every(([name, source]) => source.ready === true
    || name === 'catalog.descriptors' && source.reason === 'NotInstalled');
}
export function moduleCandidate(id: string, descriptors: readonly ModuleCandidate[]): ModuleCandidate | undefined {
  const matches = descriptors.filter(d => d.id === `extension.${id}` && d.class === 'extension'
    && d.installation?.mode === 'extension-controller' && d.installation.eligible
    && /^sha256:[a-f0-9]{64}$/.test(d.release?.imageDigest || ''));
  return matches.length === 1 ? matches[0] : undefined;
}
export function moduleStatus(fresh: boolean, candidate?: ModuleCandidate, registration?: ModuleRegistration, runtimeFresh = fresh) {
  if (!runtimeFresh) return { label: '상태 확인 필요', ready: false, installable: false };
  if (registration) {
    const status = registration.status || {};
    const v = status.verification;
    const ready = registration.desiredState === 'Enabled' && status.phase === 'Activated'
      && status.serving?.phase === 'Current' && registration.health === 'Ready'
      && v?.manifest === 'Verified' && v?.signature === 'Verified' && v?.entryDigest === 'Verified'
      && /^sha256:[a-f0-9]{64}$/.test(status.currentDigest || '');
    return { label: ready ? '사용 가능' : status.phase === 'Failed' ? '설치 실패' : registration.desiredState === 'Disabled' ? '비활성' : '설치 · 검증 중', ready, installable: false };
  }
  if (!fresh) return { label: '배포본 확인 필요', ready: false, installable: false };
  return { label: candidate ? '설치 가능' : '배포본 준비 중', ready: false, installable: Boolean(candidate) };
}
export function operationInProgress(state: string): boolean {
  return ['Planned', 'Authorized', 'Submitted', 'Reconciling', 'Applied'].includes(state);
}
export function validInstallReceipt(value: unknown): boolean {
  const receipt = value as Record<string, unknown> | null;
  return Boolean(receipt && receipt['schemaVersion'] === '1.0' && receipt['actionId'] === 'console.extension.install'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(receipt['operationId'] || ''))
    && /^ghcr\.io\/opensphere-platform\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/.test(String(receipt['targetRef'] || ''))
    && Number.isSafeInteger(receipt['stateVersion']) && Number(receipt['stateVersion']) >= 0
    && ['Planned', 'Authorized', 'Submitted', 'Reconciling', 'Applied', 'Verified', 'Failed', 'Unknown', 'RolledBack'].includes(String(receipt['state'])));
}
export function operationStage(state: string): number {
  return ({ Planned: 0, Authorized: 1, Submitted: 1, Reconciling: 2, Applied: 3, Verified: 4 } as Record<string, number>)[state] ?? -1;
}
