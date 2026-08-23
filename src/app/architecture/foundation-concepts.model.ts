export type FoundationConceptTabId =
  | 'service-stacks'
  | 'dupa'
  | 'control-pillars'
  | 'control-engine'
  | 'ai-lifecycle';

export interface FoundationConceptTab {
  id: FoundationConceptTabId;
  label: string;
  eyebrow: string;
  summary: string;
  pictogram: string;
  pictogramAlt: string;
}

export interface ArchitectureDefinition {
  id: string;
  name: string;
  role: string;
  owns: readonly string[];
  excludes: readonly string[];
  evidence: string;
  productLogo?: string;
  productLogoAlt?: string;
}

export interface LifecycleDefinition {
  step: string;
  title: string;
  owner: string;
  outcome: string;
  evidence: string;
}

export interface ControlEngineNode {
  id: string;
  name: string;
  role: string;
  boundary: string;
  pictogram: string;
  pictogramAlt: string;
}

export const FOUNDATION_CONCEPT_TABS: readonly FoundationConceptTab[] = [
  {
    id: 'service-stacks',
    label: 'Service Stacks',
    eyebrow: 'SS · HISS · CBSS · PFSS',
    summary: '실행 기반, Console 권위, 공유 Platform capability를 서로 다른 lifecycle owner로 분리합니다.',
    pictogram: '/assets/pictograms/cloud-infrastructure-management.svg',
    pictogramAlt: 'Cloud infrastructure connected to three managed service nodes',
  },
  {
    id: 'dupa',
    label: 'DUPA',
    eyebrow: 'Dynamic UI Plugin Architecture',
    summary: 'Main Shell, subShell, plugin과 Agent Runtime의 동적 결합 경계를 정의합니다.',
    pictogram: '/assets/pictograms/connected-ecosystem.svg',
    pictogramAlt: 'Independent components connected as one ecosystem',
  },
  {
    id: 'control-pillars',
    label: 'Control Pillars',
    eyebrow: 'OSAA · OSC · OSS',
    summary: 'Agent, CLI, Shell이라는 세 접근면을 하나의 OSCE operation·evidence 계약으로 연결합니다.',
    pictogram: '/assets/pictograms/control-tower.svg',
    pictogramAlt: 'One control point connected to three operating surfaces',
  },
  {
    id: 'control-engine',
    label: 'OSCE',
    eyebrow: 'CBSS Core Service · Control Engine',
    summary: 'Console과 모든 제어 채널을 각 component의 실행 계약에 연결하는 CBSS 핵심 제어 서비스를 정의합니다.',
    pictogram: '/assets/pictograms/control-panel.svg',
    pictogramAlt: 'Control panel with three independent control channels',
  },
  {
    id: 'ai-lifecycle',
    label: 'AI Lifecycle',
    eyebrow: 'Model · GPU · Agent · Replacement',
    summary: '모델의 반입부터 학습, 검증, serving, 업무 배치, 교체와 폐기까지를 통제합니다.',
    pictogram: '/assets/pictograms/ai-governance-lifecycle-factsheet.svg',
    pictogramAlt: 'AI governance lifecycle recorded on a factsheet',
  },
] as const;

export const SERVICE_STACKS: readonly ArchitectureDefinition[] = [
  {
    id: 'HISS',
    name: 'Host Infrastructure Service Stack',
    role: 'OpenSphere가 실행될 compute·network·DNS·ingress·storage와 Kubernetes substrate를 제공하고 실증합니다.',
    owns: ['Kubernetes API와 node', 'CNI·DNS·Ingress', 'CSI·snapshot', 'host metrics와 infrastructure readiness'],
    excludes: ['Console 사용자·감사 데이터', 'PFSS domain lifecycle', '사용자-facing extension navigation'],
    evidence: 'API·CNI·DNS·Ingress·CSI·snapshot live canary와 host readiness',
  },
  {
    id: 'CBSS',
    name: 'Console Backbone Service Stack',
    role: 'Console의 신원, 내구 상태, 선언형 변경, 감사와 운영 관측을 제품 UI와 분리된 backbone으로 제공합니다.',
    owns: ['Supabase identity·durable data·audit', 'Gitea desired change lineage', 'Beszel host observation', 'Console recovery state'],
    excludes: ['Kubernetes runtime truth 대체', 'domain operand 직접 소유', '관측 결과를 근거로 한 무승인 자동 변경'],
    evidence: 'login/revoke, RLS·append/read, commit/merge/revert correlation, read-only telemetry freshness',
  },
  {
    id: 'PFSS',
    name: 'Platform Foundation Service Stack',
    role: '여러 Perspective와 subShell이 공통으로 소비하는 identity·data·communication·AI capability를 안정된 owner API로 제공합니다.',
    owns: ['capability Model·Claim·Binding', 'operator reconciliation', 'operand lifecycle', 'consumer protection과 status evidence'],
    excludes: ['Main Shell의 직접 kubectl/SQL 변경', 'consumer별 capability 복제', 'Ready 증거 없는 Established 선언'],
    evidence: 'desired/actual convergence, status condition, protected I/O, restore·upgrade·consumer-removal contract',
  },
] as const;

export const CBSS_COMPONENTS: readonly ArchitectureDefinition[] = [
  {
    id: 'Supabase',
    name: 'Data & Identity Authority',
    role: '사용자 신원, 정책 입력, operation/approval/audit ledger와 object metadata를 내구 저장합니다.',
    owns: ['AuthN session·MFA', 'RLS-protected data', 'append-only audit', 'operation and receipt state'],
    excludes: ['Kubernetes actual state', 'Git merge authority', 'host monitoring controller'],
    evidence: 'RLS negative, revoke, append/read correlation, backup/restore',
    productLogo: '/assets/product-logos/supabase-icon.svg',
    productLogoAlt: 'Supabase product logo',
  },
  {
    id: 'Gitea',
    name: 'Declarative Change Authority',
    role: 'desired change의 선언, review, merge revision과 executor 입력을 보존합니다.',
    owns: ['change proposal', 'reviewed merge revision', 'desired manifest lineage', 'revert source'],
    excludes: ['workload runtime truth', '브라우저의 직접 apply', '감사 DB 대체'],
    evidence: 'proposal→review→merge→executor→receipt correlation',
    productLogo: '/assets/product-logos/gitea.svg',
    productLogoAlt: 'Gitea product logo',
  },
  {
    id: 'Beszel',
    name: 'Host Observation',
    role: 'host와 workload의 자원 신호를 읽기 전용으로 수집하여 readiness와 진단에 제공합니다.',
    owns: ['host metrics', 'resource trend', 'observation freshness', 'diagnostic projection'],
    excludes: ['desired-state write', 'alert만으로 자동 mutation', 'Supabase audit 대체'],
    evidence: 'freshness, scrape coverage, read-only identity, degraded-state projection',
    productLogo: '/assets/product-logos/beszel-light.svg',
    productLogoAlt: 'Beszel product logo',
  },
] as const;

export const PFSS_CAPABILITIES: readonly ArchitectureDefinition[] = [
  {
    id: 'Identity',
    name: 'Identity Foundation',
    role: 'workforce·service identity와 claim/binding을 공통 capability로 제공합니다.',
    owns: ['identity model', 'claim', 'binding', 'revocation projection'],
    excludes: ['Console session UI', 'consumer별 shadow identity store'],
    evidence: 'issuer·subject·audience binding, revoke propagation, cross-tenant denial',
  },
  {
    id: 'Data',
    name: 'Data Foundation',
    role: 'PostgreSQL 같은 stateful service의 선언·복구·upgrade를 owner API와 operator로 제공합니다.',
    owns: ['cluster claim', 'plan/apply', 'operator status', 'backup/restore contract'],
    excludes: ['consumer의 raw SQL administration', 'Console의 direct StatefulSet mutation'],
    evidence: 'plan digest, fenced operation, postcondition, restore drill',
  },
  {
    id: 'Communication',
    name: 'Communication Foundation',
    role: '내부·외부 메시지와 notification delivery를 policy-bound capability로 제공합니다.',
    owns: ['channel model', 'delivery policy', 'retry/dead-letter', 'delivery receipt'],
    excludes: ['consumer-owned credential 저장', '감사 없는 외부 전송'],
    evidence: 'recipient/policy binding, delivery receipt, replay and secret-scan negative',
  },
  {
    id: 'AI',
    name: 'AI Foundation',
    role: 'model endpoint, GPU serving, evaluation과 Agent Runtime이 소비할 model binding을 제공합니다.',
    owns: ['model claim', 'serving binding', 'GPU quota profile', 'model lifecycle evidence'],
    excludes: ['AI-Workbench UI 자체', 'agent tool의 domain mutation authority'],
    evidence: 'model/artifact digest, evaluation gate, endpoint identity, rollout/rollback',
  },
] as const;

export const DUPA_INSTALL_STAGES: readonly LifecycleDefinition[] = [
  { step: '01', title: 'Declare', owner: 'Package author', outcome: 'kind·hostRef·compat·contribution·permission을 선언', evidence: 'closed package/manifest schema' },
  { step: '02', title: 'Verify', owner: 'DUPA controller', outcome: 'source·digest·signature·host contract를 검증', evidence: 'trusted key, immutable image and manifest SHA' },
  { step: '03', title: 'Realize', owner: 'Component owner', outcome: '독립 workload와 service를 준비', evidence: 'exact image, rollout and serving readiness' },
  { step: '04', title: 'Register', owner: 'Registry', outcome: '검증된 descriptor와 capability를 투영', evidence: 'package/registration/registry equality' },
  { step: '05', title: 'Activate', owner: 'Main or host subShell', outcome: '허용된 page·nav·command만 동적 결합', evidence: 'hostRef, compatibility and contribution checks' },
  { step: '06', title: 'Operate', owner: 'Lifecycle owner', outcome: 'disable·update·rollback·remove를 독립 수행', evidence: 'audit, cleanup and failure isolation' },
] as const;

export const DUPA_PLUGIN_ROLES: readonly ArchitectureDefinition[] = [
  {
    id: 'Hosted UI',
    name: 'Page & Navigation Plugin',
    role: 'subShell의 문맥 안에서 화면, navigation과 local workflow를 제공합니다.',
    owns: ['host-scoped page', 'child navigation', 'presentation state'],
    excludes: ['Main Shell 1단 메뉴 직접 소유', 'hostRef 밖 route', 'shared capability lifecycle'],
    evidence: 'host projection, route isolation, host-unavailable negative',
  },
  {
    id: 'Capability',
    name: 'Capability Binding Plugin',
    role: 'subShell의 사용자 흐름을 PFSS 또는 고정 owner API에 연결합니다.',
    owns: ['typed input', 'owner API binding', 'status/receipt presentation'],
    excludes: ['owner 우회 mutation', '별도 approval/audit store', 'cluster credential'],
    evidence: 'schema parity, owner receipt, cross-tenant/risk negative',
  },
  {
    id: 'Projection',
    name: 'Observer & Projection Plugin',
    role: '외부 owner의 상태와 evidence를 subShell 문맥에 읽기 전용으로 투영합니다.',
    owns: ['read model', 'freshness/degraded state', 'diagnostic link'],
    excludes: ['projection을 runtime truth로 승격', '관측 실패 시 다른 기능 차단'],
    evidence: 'source identity, watermark, stale projection fail-closed',
  },
] as const;

export const AGENT_RUNTIME_SPECTRUM: readonly ArchitectureDefinition[] = [
  {
    id: 'Logical Contract',
    name: 'OpenSphere Agent Runtime',
    role: 'session, agent loop, tool/job, approval, trace와 ledger 의미론을 정의합니다. 현재 R2D2가 최초 Native 구현입니다.',
    owns: ['AgentRunRead', 'session/step state', 'tool decision', 'runtime evidence'],
    excludes: ['곧바로 신설되는 독립 service plane', 'domain owner authority'],
    evidence: 'run/step ledger, fencing epoch, policy revision, terminal receipt',
  },
  {
    id: 'Runtime Adapter',
    name: 'Native / Composable Runtime Adapter',
    role: '공통 Runtime 계약을 특정 실행 엔진에 연결하고 내부 구현 차이를 캡슐화합니다.',
    owns: ['version negotiation', 'event normalization', 'adapter conformance'],
    excludes: ['Shell plugin으로 내부 unit 노출', '다른 adapter의 state 공유'],
    evidence: 'same contract conformance, unsupported-version fail-closed',
  },
  {
    id: 'Runtime Unit',
    name: 'Model · Session · Loop · Policy · Telemetry',
    role: 'Composable Runtime 내부에서 교체 가능한 구현 단위입니다. OpenSphere의 product plugin과 구분합니다.',
    owns: ['bounded internal capability', 'declared dependency', 'reversible local effect'],
    excludes: ['무제한 in-process 권한', '외부 side effect의 자동 rollback 주장'],
    evidence: 'unit version, dependency graph, unload residue check',
  },
  {
    id: 'Workspace Driver',
    name: 'Pod / KubeVirt Agent Playground',
    role: 'agent가 code·tool을 실행할 격리 workspace를 risk profile에 맞춰 제공합니다.',
    owns: ['workspace lifecycle', 'network/storage limit', 'teardown evidence'],
    excludes: ['요청 격리보다 약한 Driver로 자동 하향', 'control plane credential 전달'],
    evidence: 'sandbox profile, runtime identity, resource bound, residue zero',
  },
] as const;

export const CONTROL_PILLARS: readonly ArchitectureDefinition[] = [
  {
    id: 'OSAA',
    name: 'OSA / OSAA · OpenSphere AI Agent (R2D2)',
    role: '자연어 의도를 capability inventory의 closed action으로 변환하고 위험·승인·evidence를 해석합니다.',
    owns: ['intent interpretation', 'capability selection', 'explanation', 'operation observation'],
    excludes: ['owner API 우회', 'raw kubectl/SQL', '자체 shadow approval store'],
    evidence: 'intent→action digest, approval reference, owner receipt, uncertainty disclosure',
  },
  {
    id: 'OSC',
    name: 'OpenSphere CLI · os',
    role: '사람, automation과 AI가 같은 machine-readable control contract를 안정적으로 호출하는 기본 인터페이스입니다.',
    owns: ['discover/help', 'typed plan/apply/watch', 'JSON output', 'local input validation'],
    excludes: ['권위 있는 business logic', 'cluster credential 배포', 'UI와 다른 별도 action schema'],
    evidence: 'exit code, stable JSON schema, owner plan/operation/receipt identity',
  },
  {
    id: 'OSS',
    name: 'OpenSphere OS Shell',
    role: 'Console 안에서 인증된 운영자가 os CLI와 허용된 도구를 사용하는 짧은 수명의 감사 가능한 terminal을 제공합니다.',
    owns: ['session/ticket', 'PTY attach/reconnect', 'bounded runtime', 'CLI execution surface'],
    excludes: ['일반 cluster-admin shell', '직접 Kubernetes/DB owner', '영구 workspace'],
    evidence: 'actor/session binding, runtime policy, command owner receipt, teardown residue zero',
  },
] as const;

export const CONTROL_BEAMS: readonly ArchitectureDefinition[] = [
  { id: 'Capability', name: 'OSCE Control API', role: '세 접근면이 동일한 action과 유일 component control adapter를 호출합니다.', owns: ['action schema', 'component endpoint'], excludes: ['surface별 구현 분기'], evidence: 'semantic parity' },
  { id: 'Identity', name: 'Identity & Authorization', role: 'actor, tenant, assurance, purpose를 끝까지 전달합니다.', owns: ['actor context', 'RBAC/ABAC'], excludes: ['service account fallback'], evidence: 'cross-user/tenant negative' },
  { id: 'Operation', name: 'Plan · Approval · Operation', role: '위험한 변경을 계획과 확인, fence가 있는 operation으로 수행합니다.', owns: ['plan digest', 'confirmation', 'fencing'], excludes: ['fire-and-forget write'], evidence: 'durable state transition' },
  { id: 'Evidence', name: 'Audit · Receipt · Recovery', role: '무엇을 왜 바꿨고 결과가 무엇인지 같은 ledger로 설명합니다.', owns: ['audit correlation', 'terminal receipt', 'rollback reference'], excludes: ['surface-local success claim'], evidence: 'append-only correlation' },
] as const;

export const CONTROL_ENGINE_SURFACES: readonly ControlEngineNode[] = [
  {
    id: 'Console',
    name: 'Main Shell Console',
    role: '페이지, navigation과 관리 workflow를 제공하는 시각적 제어 채널입니다.',
    boundary: '화면은 domain 제어 로직이나 runtime truth를 소유하지 않습니다.',
    pictogram: '/assets/pictograms/console.svg',
    pictogramAlt: 'Console control surface',
  },
  {
    id: 'OSS',
    name: 'OpenSphere Shell',
    role: 'Console 안에서 OSC와 허용된 운영 도구를 실행하는 감사 가능한 작업 환경입니다.',
    boundary: 'Shell session은 제어 엔진이나 일반 cluster-admin 권한이 아닙니다.',
    pictogram: '/assets/pictograms/developer-tools.svg',
    pictogramAlt: 'Developer tools framed by command brackets',
  },
  {
    id: 'OSC',
    name: 'OpenSphere CLI',
    role: '사람, automation과 AI가 동일한 typed command와 JSON 결과를 사용하는 공식 명령 채널입니다.',
    boundary: 'CLI는 business logic을 복제하지 않고 OSCE Control API를 호출합니다.',
    pictogram: '/assets/pictograms/code-syntax.svg',
    pictogramAlt: 'Code syntax inside a command window',
  },
  {
    id: 'OSAA',
    name: 'OSAA · R2D2',
    role: '자연어 의도를 closed action으로 해석하고 전체 작업을 지휘하는 운영 지능입니다.',
    boundary: '모델의 추론은 직접 mutation 권위가 아니며 OSCE plan과 authorization을 통과합니다.',
    pictogram: '/assets/pictograms/intelligence.svg',
    pictogramAlt: 'Artificial intelligence brain',
  },
] as const;

export const CONTROL_ENGINE_TARGETS: readonly ControlEngineNode[] = [
  {
    id: 'SubShell',
    name: 'SubShell',
    role: '독립된 운영 영역의 lifecycle과 child plugin 문맥을 제어합니다.',
    boundary: 'Main Shell이 subShell의 domain 상태와 복구 로직을 흡수하지 않습니다.',
    pictogram: '/assets/pictograms/connected-ecosystem.svg',
    pictogramAlt: 'Connected ecosystem of independent components',
  },
  {
    id: 'Plugin',
    name: 'Plugin',
    role: 'host에 귀속된 화면, capability binding 또는 read-only projection을 제어합니다.',
    boundary: 'Plugin은 hostRef 밖의 route와 shared capability lifecycle을 소유하지 않습니다.',
    pictogram: '/assets/pictograms/microservices.svg',
    pictogramAlt: 'Independent microservices connected through defined paths',
  },
  {
    id: 'Service Stack',
    name: 'Service Stack',
    role: 'HISS, CBSS, PFSS의 원하는 상태와 실제 상태를 owner별 adapter로 연결합니다.',
    boundary: 'OSCE가 operator와 runtime truth를 대체하거나 직접 StatefulSet·SQL을 변경하지 않습니다.',
    pictogram: '/assets/pictograms/systems.svg',
    pictogramAlt: 'Independent systems sharing one bounded frame',
  },
] as const;

export const CONTROL_ENGINE_STAGES: readonly LifecycleDefinition[] = [
  {
    step: '01',
    title: 'Observe & Understand',
    owner: 'OSAA + OSCE',
    outcome: '문서·source·runtime·browser 증거를 연결해 실제 실패 지점을 판단',
    evidence: 'source revision, observation freshness, uncertainty',
  },
  {
    step: '02',
    title: 'Plan',
    owner: 'OSCE',
    outcome: '대상 component, 변경 범위, 위험, 시험과 rollback을 하나의 plan으로 폐쇄',
    evidence: 'planId, target revision, affected component',
  },
  {
    step: '03',
    title: 'Authorize',
    owner: 'Console Backend',
    outcome: '현재 actor와 정책으로 실행 가능 범위를 확인하고 필요한 승인을 결속',
    evidence: 'actor, assurance, policy revision, approval',
  },
  {
    step: '04',
    title: 'Execute',
    owner: 'Component Control Adapter',
    outcome: '각 component의 공식 apply 또는 OSC machine mode를 통해 작업 실행',
    evidence: 'operationId, exact input, owner receipt',
  },
  {
    step: '05',
    title: 'Verify & Recover',
    owner: 'OSCE + Component owner',
    outcome: 'API·runtime·browser postcondition을 확인하고 실패하면 rollback',
    evidence: 'exact digest, postcondition, rollback receipt',
  },
] as const;

export const CONTROL_ENGINE_PICTOGRAMS = {
  engine: '/assets/pictograms/control-tower.svg',
  api: '/assets/pictograms/api.svg',
} as const;

export const AI_LIFECYCLE: readonly LifecycleDefinition[] = [
  { step: '01', title: 'Source & Curate', owner: 'Data/Model owner', outcome: 'dataset·base model·license·usage policy를 등록', evidence: 'source, license, dataset/model digest' },
  { step: '02', title: 'Train & Adapt', owner: 'AI Foundation job owner', outcome: 'GPU quota 안에서 train·fine-tune·adapter build', evidence: 'job spec, code/data/base digest, resource receipt' },
  { step: '03', title: 'Evaluate & Admit', owner: 'Evaluation and policy gate', outcome: 'quality·safety·security·cost 기준 통과 모델만 승인', evidence: 'evaluation suite, policy revision, signed decision' },
  { step: '04', title: 'Allocate & Serve', owner: 'Model serving operator', outcome: 'GPU class·replica·endpoint·tenant binding을 reconcile', evidence: 'ModelClaim/Binding, runtime image and weight digest' },
  { step: '05', title: 'Assign & Run', owner: 'Agent owner + Agent Runtime', outcome: 'agent가 승인된 model/tool/policy binding으로 업무 수행', evidence: 'run/step trace, tool approval, output provenance' },
  { step: '06', title: 'Observe & Govern', owner: 'AI operations', outcome: 'quality drift·latency·cost·abuse·resource pressure를 관찰', evidence: 'telemetry watermark, evaluation replay, incident correlation' },
  { step: '07', title: 'Replace & Retire', owner: 'Model lifecycle owner', outcome: 'shadow/canary 후 새 binding으로 전환하고 구 모델을 revoke', evidence: 'compatibility, rollout, rollback, credential/artifact cleanup' },
] as const;

export const MODEL_LOCATIONS: readonly ArchitectureDefinition[] = [
  {
    id: 'Managed Provider',
    name: 'External Model API',
    role: '외부 provider가 weight와 serving runtime을 보유하며 OpenSphere는 versioned endpoint binding을 사용합니다.',
    owns: ['provider model version', 'endpoint', 'usage policy'],
    excludes: ['provider key의 agent 직접 소유'],
    evidence: 'provider identity, model name/version, request/usage receipt',
  },
  {
    id: 'OpenSphere Registry',
    name: 'Model Artifact & Metadata',
    role: '자체 모델 weight, adapter, tokenizer, evaluation 결과와 lineage를 object/OCI registry에 보존합니다.',
    owns: ['immutable artifact', 'SBOM/license', 'evaluation lineage'],
    excludes: ['artifact 존재만으로 serving Ready 주장'],
    evidence: 'digest, signature, retention and restore',
  },
  {
    id: 'Serving Runtime',
    name: 'GPU-backed Model Endpoint',
    role: '승인된 artifact를 GPU workload에 적재하고 stable Model Binding endpoint로 제공합니다.',
    owns: ['GPU scheduling', 'runtime image', 'weight mount', 'health/autoscale'],
    excludes: ['agent별 임의 model download', 'UI의 direct provider call'],
    evidence: 'endpoint identity, loaded digest, SLO, quota and isolation',
  },
] as const;
