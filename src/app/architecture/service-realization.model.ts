export type ServiceRealizationLayerId =
  | 'SRL-L1'
  | 'SRL-L2'
  | 'SRL-L3'
  | 'SRL-L4'
  | 'SRL-L5'
  | 'SRL-L6';

export interface ServiceRealizationLayer {
  id: ServiceRealizationLayerId;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  short: string;
  scope: string;
  role: string;
  requires: string;
  establishes: string;
  evidence: string;
  authority: string;
  failurePolicy: string;
  objects: string[];
}

/**
 * Service Realization Layers are persistent operating strata, not repository
 * folders, product modules, or a strictly linear installer sequence.
 *
 * The array is ordered top-down for the architecture map. Establishment uses
 * SERVICE_REALIZATION_ESTABLISHMENT_SEQUENCE because full HIS verification is
 * performed through the L3 Cluster Manager after the L1 bootstrap gate exists.
 */
export const SERVICE_REALIZATION_LAYERS: readonly ServiceRealizationLayer[] = [
  {
    id: 'SRL-L6',
    ordinal: 6,
    name: 'Domain Service Layer',
    short: 'Domain Service',
    scope: 'Perspective-owned value',
    role: '직원·고객·개발자에게 실제 업무와 제품 경험을 제공한다.',
    requires: 'SRL-L5 capability binding과 domain admission',
    establishes: '도메인 서비스, 업무 흐름, 사용자 가치',
    evidence: '사용자 여정, SLO, 도메인별 운영·복구 증거',
    authority: '각 Perspective의 owning subShell',
    failurePolicy: '공유 capability를 복제하지 않고 소비 계약이 닫히면 domain write를 차단한다.',
    objects: ['Developer', 'Workspace', 'Customer Services', 'External Web', 'Website'],
  },
  {
    id: 'SRL-L5',
    ordinal: 5,
    name: 'Platform Foundation Layer',
    short: 'Platform Foundation',
    scope: 'Shared service capability',
    role: '모든 Perspective가 공통으로 소비하는 PFSS capability를 제공한다.',
    requires: 'SRL-L4 Platform Support Profile Ready',
    establishes: '공유 identity·data·communication·AI와 소비자 binding 계약',
    evidence: 'Model·Claim·Binding, 보호된 I/O, consumer-protect와 복구 계약',
    authority: 'Foundation control plane과 capability별 operand owner',
    failurePolicy: '보호된 consumer가 있으면 제거를 거부하고 증거 부재 시 Established를 주장하지 않는다.',
    objects: [
      'PFSS',
      'Identity',
      'Data',
      'Communication',
      'AI Substrate',
      'Observability Binding',
      'Recovery Consumer Contract',
    ],
  },
  {
    id: 'SRL-L4',
    ordinal: 4,
    name: 'Platform Support Layer',
    short: 'Platform Support',
    scope: 'Cross-perspective safety',
    role: '상위 서비스를 반복 가능하게 배포하고 관측·복구·통제할 수 있게 한다.',
    requires: 'SRL-L3 control authority와 SRL-L1 HIS Preflight Ready',
    establishes: 'Delivery·Observability·Backup/Restore·Security/Policy 안전망',
    evidence: 'sync·rollback, telemetry canary, restore drill, admission red test',
    authority: 'Main Shell의 PlatformSupportProfile gate와 capability별 고정 owner',
    failurePolicy: '필수 capability 하나라도 실증되지 않으면 Profile과 PFSS admission을 닫는다.',
    objects: [
      'Argo CD',
      'Crossplane Adapter',
      'Observability Runtime & Control',
      'Recovery Control',
      'Security / Policy',
    ],
  },
  {
    id: 'SRL-L3',
    ordinal: 3,
    name: 'Platform Control Layer',
    short: 'Platform Control',
    scope: 'Control and operational authority',
    role: '설치·활성화·정책·진단·감사의 단일 관리 표면과 권위 경계를 제공한다.',
    requires: 'SRL-L2 Console Backbone Ready',
    establishes: 'Main Shell baseline, 검증된 Registry, lifecycle control, Cluster Manager 진단 경로',
    evidence: '서명·digest 검증, activation, CLI parity, audited write와 rollback',
    authority: 'Main Shell control plane; runtime truth는 Kubernetes API',
    failurePolicy: 'Backbone 또는 audit 불가 시 관리 write를 차단하고 복구용 read-only 표면만 유지한다.',
    objects: ['Main Shell', 'DUPA / Registry', 'Cluster Manager', 'R2D2', 'Policy Gate'],
  },
  {
    id: 'SRL-L2',
    ordinal: 2,
    name: 'Console Backbone Layer',
    short: 'Console Backbone',
    scope: 'Durable console authority',
    role: 'Console의 신원·상태·선언형 변경·감사 이력을 내구 저장한다.',
    requires: 'SRL-L1 Bootstrap Gate: Kubernetes API와 Console workload 실행 기반',
    establishes: '운영자 신원, durable state, object storage, declarative change authority',
    evidence: 'login·revoke, DB append/read·RLS, object I/O, Git commit·revert·correlation',
    authority: 'Supabase Data & Identity, Gitea change authority, Kubernetes runtime',
    failurePolicy: '비내구 fallback을 금지하고 감사 저장 불가 시 모든 관리 write를 503으로 닫는다.',
    objects: ['Supabase Data & Identity', 'Gitea State Change Authority', 'Durable Audit', 'Object History'],
  },
  {
    id: 'SRL-L1',
    ordinal: 1,
    name: 'Host Infrastructure Layer',
    short: 'Host Infrastructure',
    scope: 'Host-provided substrate',
    role: 'OpenSphere와 모든 서비스가 실행되는 호스트 기반을 제공한다.',
    requires: 'Kubernetes API에 연결 가능한 물리·가상 인프라',
    establishes: 'bootstrap substrate와 검증된 compute·network·DNS·ingress·storage 기반',
    evidence: 'API, CNI, DNS, Ingress, CSI, metrics와 snapshot의 live canary',
    authority: '호스트 관리자와 명시 위임된 Cluster Manager; runtime truth는 Kubernetes API',
    failurePolicy: 'HIS 실증 실패 시 SRL-L4 이상을 차단하되 기존 Console 복구 표면은 유지한다.',
    objects: ['Kubernetes API', 'CNI / DNS / Ingress', 'CSI / Storage', 'Host Metrics', 'Volume Snapshot'],
  },
] as const;

/**
 * Persistent layer order and establishment order are intentionally different.
 * The first L1 entry is the small bootstrap gate; the second is full HIS
 * verification performed after L3 has established Cluster Manager authority.
 */
export const SERVICE_REALIZATION_ESTABLISHMENT_SEQUENCE = [
  'SRL-L1.Bootstrap',
  'SRL-L2.CBSReady',
  'SRL-L3.MainShellAndClusterManagerReady',
  'SRL-L1.HISPreflightReady',
  'SRL-L4.PlatformSupportProfileReady',
  'SRL-L5.PFSSEstablished',
  'SRL-L6.DomainAdmission',
] as const;
