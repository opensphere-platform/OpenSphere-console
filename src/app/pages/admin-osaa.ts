import { NgTemplateOutlet } from '@angular/common';
import { Component, OnInit, OnDestroy, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { FormsModule } from '@angular/forms';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';
import { OsActionDialog } from '../os/os-action-dialog';
import { HttpService } from '../core/http.service';

type DialogueMode = 'off' | 'shadow' | 'read-enforce' | 'mutation-enforce';

interface OsaaHealth {
  service: string;
  version: string;
  namespace: string;
  ok?: boolean;
  /** CONSTITUTION-0004 §4.2 서버측 fail-closed mutation gate 상태. true일 때만 Kubernetes mutation/action
   *  tool이 서버에서 제공된다(exactly 'true'인 OSAA_MUTATION_ENABLED). UI 확인만으로는 gate를 열 수 없다. */
  mutationEnabled?: boolean;
  /** gate가 닫혀 있을 때 서버가 보내는 안정적 reason code(예: mutation_disabled_until_his_ready). */
  mutationGateReason?: string | null;
  ragEnabled?: boolean;
  pgConfigured?: boolean;
  embedDim?: number;
  allowedNamespaces?: string[];
  scaleMax?: number;
  status?: 'ready' | 'degraded' | 'not_ready';
  degraded?: boolean;
  degradedReason?: string | null;
  lexicalSearchReady?: boolean;
  semanticSearchReady?: boolean;
  semanticSearch?: { ready: boolean; reason: string | null; keyId: string; provider: string; model: string; checkedAt: string | null };
  runtimeProjection?: {
    ready: boolean; reason?: string; totalResources?: number; freshResources?: number;
    lastObservedAt?: string; lagSeconds?: number; refreshSeconds?: number; authority?: string; projection?: string;
  };
  dialogueState?: {
    mode: 'off' | 'shadow' | 'read-enforce' | 'mutation-enforce' | string;
    recordTransitions: boolean;
    exposeContext: boolean;
    enforceCurrentFacts: boolean;
    enforceMutations: boolean;
  };
}
interface OsaaDialogueStateControl {
  mode: DialogueMode;
  source: 'deployment-annotation' | 'safe-default' | string;
  rollout: {
    ready: boolean;
    generation: number;
    observedGeneration: number;
    desiredReplicas: number;
    updatedReplicas: number;
    readyReplicas: number;
  };
  updatedAt?: string;
  updatedBy?: string;
}
interface AgentControlReadiness {
  apiVersion: string;
  fullyOperational: boolean;
  blockers: string[];
  missingCapabilities: { observability: string[]; hisOwner: string[]; cephOwner: string[]; recoveryOwner?: string[] };
  platformSupport: { ready: boolean; phase: string };
}
interface OsaaControlPlaneStatus {
  checkedAt: string;
  ready: boolean;
  fullyOperational: boolean;
  unavailable: string[];
  agentControl: AgentControlReadiness;
}
interface OsaaEngineeringStatus {
  schema: string;
  proposalEnabled: boolean;
  executionEnabled: boolean;
  workerReady: boolean;
  repositories: string[];
  approvalMode: 'local-edge-supervised' | 'disabled';
  capabilities: {
    diagnose: boolean; propose: boolean; approveExactWorkUnit: boolean;
    repositoryWrite: boolean; componentBuild: boolean; exactDigestDeploy: boolean;
    browserVerification: boolean; rollback: boolean;
  };
}
interface EngineeringRemediation {
  remediationRequestId: string;
  reason: string;
  riskLevel: string;
  stage: string;
  repository: string;
  baseRevision: string;
  allowedPaths: string[];
  changedPaths: string[];
  patchDigest: string;
  affectedComponents: string[];
  affectedImages: string[];
  requiredTests: string[];
  releaseScope: string;
  targetChannel: string;
  buildAuthority: string;
  approvalBindingDigest: string;
  verificationProfile: string;
  verificationRoute: string;
  approvalExpiresAt: string;
  updatedAt: string;
  requiredConfirmation?: string | null;
  latestBuild?: { sourceRevision: string; patchDigest: string; buildAuthority: string; imageDigests: string[]; releaseLockDigest: string } | null;
  activation: { approvalApi: boolean; workerReady: boolean; repositoryWrite: boolean; build: boolean; publish: boolean; deploy: boolean };
}
interface R2d2OperationalStatus {
  clusterId: string;
  graph: { total: number; fresh: number; observedAt: string | null };
  sources: { source: string; epistemic_state: string; configured: boolean; snapshot_complete: boolean; last_complete_at: string | null; lag_seconds: number | null; blocker_code: string | null }[];
  risk: { active: number; severityRank: number };
  observer: { fencing_epoch: number; collector_id: string; lease_expires_at: string; heartbeat_at: string } | null;
  runtime: { degraded?: boolean; reason?: string; fencingEpoch?: number; graph?: { nodeCount: number; relationCount: number; reconcileSessionId: string } } | null;
  flags: { observer: boolean; graph: boolean; incident: boolean; globalRisk: boolean; incidentRelay?: boolean; maintenance?: boolean };
}
interface R2d2GraphNode {
  nodeId: string; nodeType: string; displayName: string; namespace: string; authority: string;
  health: string; epistemicState: string; observedAt: string; expiresAt: string;
}
interface R2d2Incident {
  incidentId: string; type: string; status: string; severity: string; confidence: number;
  causeStatus: string; causeCode: string | null; title: string; summary: string;
  primaryNodeId: string; transitionSequence: number; firstDetectedAt: string; lastObservedAt: string;
}
interface R2d2IncidentDetail extends R2d2Incident {
  timeline: { sequence: number; transition: string; from_status: string | null; to_status: string; reason_code: string; evidence_digest: string; occurred_at: string }[];
  evidence: { observation_id: string; observation_type: string; severity: string; evidence_ref: string; observed_at: string }[];
  impacts: { node_id: string; impact_type: string; distance: number; confidence: number }[];
}
interface R2d2Operation {
  operationId: string; action: string; phase: string; executionState: string; verificationState: string;
  riskClass: string; toolId: string; verifierId: string; attempt: number; errorCode: string | null;
  createdAt: string; updatedAt: string; approvalConfirmation?: string | null;
}
interface R2d2OperationDetail extends R2d2Operation {
  steps: { sequence: number; step_type: string; status: string; error_code?: string | null; observed_at: string; evidence?: Record<string, unknown> }[];
  approvals: { approver_id: string; assurance: string; approved_at: string; revoked_at?: string | null }[];
}
interface R2d2Metacognition {
  clusterId: string;
  selfModel: null | {
    observerState: string; graphState: string; incidentState: string; operationState: string;
    remediationState: string; coverage: number; blockers: string[]; capabilityRevision: string; observedAt: string;
  };
  mismatches: {
    mismatchId: string; incidentId: string | null; subjectNodeId: string; mismatchType: string;
    epistemicState: string; expectedDigest: string; actualDigest: string; evidenceDigest: string;
    detectedAt: string; resolvedAt: string | null; assessment: null | {
      assessmentId: string; minimumLadderStep: number; engineeringRequired: boolean; rationale: string; assessedAt: string;
    };
  }[];
  remediations: {
    remediationRequestId: string; operationId: string; repository: string; patchDigest: string;
    riskLevel: string; stage: string; targetChannel: string; buildAuthority: string;
    affectedComponents: string[]; requiredTests: string[]; updatedAt: string;
  }[];
}

interface LlmKey {
  id: string;
  provider: string;
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  embeddingModel: string;
  enabled: boolean;
  keyFingerprint: string;
  secretRef: string;
  updatedAt: string;
  updatedBy: string;
  validationStatus: string;
  validationMessage: string;
  validatedAt: string;
  validationLatencyMs: number;
}
interface LlmKeyForm {
  id: string;
  provider: string;
  displayName: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  embeddingModel: string;
  enabled: boolean;
  reason: string;
}
interface LlmUsageMetric {
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  successRate: number;
  p95LatencyMs: number | null;
  estimatedCostUsd: number | null;
  pricedRequests: number;
  unpricedRequests: number;
}
interface LlmUsageKey extends LlmUsageMetric {
  keyId: string;
  provider: string;
  models: string[];
  lastUsedAt: string;
  tokens24h: number;
  tokens7d: number;
  tokens30d: number;
}
interface LlmUsageDashboard {
  schema: string;
  generatedAt: string;
  rangeDays: number;
  currency: string;
  costBasis: string;
  summary: LlmUsageMetric;
  windows: { hours24: LlmUsageMetric; days7: LlmUsageMetric; days30: LlmUsageMetric };
  byKey: LlmUsageKey[];
  byModel: (LlmUsageMetric & { provider: string; model: string; operation: string })[];
  bySource: (LlmUsageMetric & { source: string })[];
  daily: (LlmUsageMetric & { date: string })[];
  recent: {
    requestId: string; occurredAt: string; keyId: string; provider: string; model: string;
    operation: string; source: string; status: string; inputTokens: number; outputTokens: number;
    totalTokens: number; usageSource: string; latencyMs: number | null; estimatedCostUsd: number | null;
  }[];
}
interface LlmUsageGrassDay extends LlmUsageMetric {
  date: string;
  inRange: boolean;
  level: number;
}
interface LlmUsageGrassWeek {
  key: string;
  monthLabel: string;
  days: LlmUsageGrassDay[];
}
interface LlmUsageGrass {
  weeks: LlmUsageGrassWeek[];
  activeDays: number;
  peakRequests: number;
  startDate: string;
  endDate: string;
}
interface EvidenceRetentionPolicy {
  stream: string;
  retentionDays: number;
  disposition: 'retain' | 'export-before-delete';
  legalHold: boolean;
  updatedAt: string;
  updatedBy: string;
  rowCount: number;
  oldestAt: string | null;
  dueRows: number;
  exportCoveredRows: number;
  lastExportAt: string | null;
}
interface AgentEvidenceRun {
  runId: string;
  actorLabel: string;
  requestDigest: string;
  provider: string;
  model: string;
  status: string;
  toolCalls: number;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  steps: { stepIndex: number; stepKind: string; toolId?: string; status: string; inputDigest: string; outputDigest: string; occurredAt: string }[];
  retrievals: { requestId: string; rank: number; score: number; queryDigest: string; documentRevision: string; sourceId: string; title: string; occurredAt: string }[];
  tools: { requestId: string; toolId: string; target: string; permissionCode: string; status: string; inputDigest: string; resultDigest: string; occurredAt: string }[];
  providerCalls: { requestId: string; provider: string; model: string; operation: string; status: string; inputTokens: number; outputTokens: number; totalTokens: number; latencyMs: number | null; occurredAt: string }[];
}
interface AgentEvidenceDashboard {
  schema: string;
  generatedAt: string;
  rangeDays: number;
  privacy: string;
  deletionControl: string;
  summary: { runs: number; completed: number; failed: number; running: number; toolCalls: number };
  retention: EvidenceRetentionPolicy[];
  runs: AgentEvidenceRun[];
}
interface EvidenceRetentionForm {
  stream: string;
  retentionDays: number;
  disposition: 'retain' | 'export-before-delete';
  legalHold: boolean;
  reason: string;
  confirm: string;
}
interface KnowledgeStats {
  enabled: boolean;
  embedDim: number;
  manualSeedPath: string;
  documents: number;
  chunks: number;
  manualDocuments: number;
  manualChunks: number;
  manualConcepts: number;
  manualRelations: number;
  manualSources: { source: string; documents: number; chunks: number }[];
  embeddingModes: { mode: string; chunks: number }[];
  embeddingKeys: {
    id: string; provider: string; displayName: string; embeddingModel: string;
    validationStatus: string; validationMessage: string; validatedAt: string;
  }[];
  lexicalSearchReady: boolean;
  semanticSearch: { ready: boolean; reason: string | null; keyId: string; provider: string; model: string; checkedAt: string | null };
}
interface OsaaTool {
  id: string;
  name: string;
  version?: string;
  channel: string;
  readOnly: boolean;
  endpoint?: { method: string; path: string };
  riskLevel?: string;
  confirmation?: string;
  confirmationTemplate?: string;
  inputSchema?: { properties?: Record<string, { type?: string; enum?: unknown[] }> };
}
interface OsaaToolManifest {
  schema: string;
  service: string;
  version: string;
  generatedAt: string;
  allowedNamespaces: string[];
  scaleMax: number;
  tools: OsaaTool[];
  storage?: string;
}
interface OsaaActionBinding {
  id: string;
  title: string;
  intent: string;
  toolId: string;
  sourceId: string;
  sectionId?: string;
  riskLevel: string;
  confirmation: string;
  confirmationTemplate?: string;
  controlPlane?: string;
  valid?: boolean;
  targetHints?: { namespace?: string; deployment?: string; maxReplicas?: number };
  requiredInputs?: { type: string; fields: Record<string, string> };
  citations?: { sourceId: string; sourcePath?: string }[];
}
interface OsaaActionBindingManifest {
  schema: string;
  service: string;
  version: string;
  generatedAt: string;
  bindings: OsaaActionBinding[];
  invalidBindings: { id: string; toolId: string }[];
  storage?: string;
}

/**
 * /manage/osaa — R2D2 관리 표면. **셸 네이티브** 전용 페이지(CONSTITUTION-0004 §4.2/§4.4).
 * R2D2는 Main Shell native capability이고 보안·실행 격리용 Supabase consumer workload를 사용한다 — 여기서는
 * runtime health, LLM provider key custody, Knowledge/Manual Registry, Tool Registry/Action Bindings만 다룬다.
 * Data & Identity 페이지에는 절대 다시 흡수하지 않는다(§8 감사 판정).
 *
 * 모든 호출은 same-origin `/api/osaa/*` + HttpService(내부적으로 AuthService.token()을 Bearer로 첨부, cross-origin 차단).
 * LLM API key는 여기서 절대 localStorage/sessionStorage/log/DOM 목록에 저장하지 않는다 — 생성/회전 성공(또는 실패) 직후
 * 폼의 apiKey 필드를 즉시 비우고, 목록에는 서버가 계산한 fingerprint만 보여준다.
 *
 * mutation(쓰기) 바인딩 실행은 정확한 confirmation 문자열 + 사유(reason) 둘 다 로컬에서 먼저 검증하고,
 * 서버가 보고하는 health.mutationEnabled === true이면서 tool manifest/action binding 로드가 모두
 * 성공하지 않았으면(mutationGateOpen=false) 서버로 실행 요청을 보내지 않는다. 이는 UI 편의 게이트일 뿐이다 —
 * 실제 강제는 opensphere-console-osaa-gateway 서버가 Cluster Manager Activated + HISS Preflight Ready 이전에는
 * OSAA_MUTATION_ENABLED가 정확히 'true'가 아닌 한 모든 Kubernetes mutation/action tool을 tool manifest/action
 * binding 응답에서 제거하고 실행 요청을 403(mutation_disabled_until_his_ready)으로 fail-closed 처리하는
 * 방식으로 이미 수행한다(CONSTITUTION-0004 §4.2). 이 페이지는 그 서버 정책을 대체하지 않는다.
 */
@Component({
  selector: 'os-admin-osaa',
  imports: [ClarityModule, FormsModule, NgTemplateOutlet, BackendUnavailable, OsPageHeader, OsPanel, OsActionDialog],
  template: `
    <div class="os-page">
      <os-page-header title="R2D2" tag="Core·Admin · Console 내장 AI 관리 표면" />
      <ng-template #overviewIntro>
      <section class="r2d2-north-star" aria-labelledby="r2d2-north-star-title">
        <div class="r2d2-north-star-copy">
          <div class="r2d2-eyebrow">OPERATIONAL INTELLIGENCE · NORTH STAR</div>
          <h2 id="r2d2-north-star-title">OpenSphere의 상태뿐 아니라, 무엇을 모르는지와 어떻게 복구할지도 이해합니다.</h2>
          <p>
            R2D2의 최종 목표는 기대 상태와 실제 상태를 지속해서 비교하고, 관측 한계와 수행 가능 범위를 증거로 설명하며,
            위험을 전파하고, 승인된 범위에서 운영 복구부터 소스 수정·빌드·배포·검증·롤백까지 하나의 추적 가능한 폐쇄 루프로 연결하는 것입니다.
          </p>
          <div class="r2d2-target-badges" aria-label="R2D2 목표 상태">
            <span>Target model</span>
            <span>Phased enablement</span>
            <span class="guarded">Operational runtime ON · Engineering {{ engineeringStatus()?.workerReady ? 'READY' : (engineeringStatus()?.executionEnabled ? 'RUNNER 대기' : (engineeringStatus() ? 'OFF' : 'UNKNOWN')) }}</span>
          </div>
        </div>
        <aside class="r2d2-position-card" aria-label="현재 위치와 최종 목표">
          <div class="r2d2-position-head"><span>현재 위치</span><strong>Operational Intelligence</strong></div>
          <ol>
            <li class="done"><span>01</span><div><strong>관측 기반</strong><small>runtime projection · owner API · HISS</small></div></li>
            <li class="active"><span>02</span><div><strong>상황 이해</strong><small>graph · coverage · incident · impact</small></div></li>
            <li><span>03</span><div><strong>운영 복구</strong><small>governed capability · postcondition</small></div></li>
            <li [class.done]="engineeringStatus()?.workerReady"><span>04</span><div><strong>Engineering Remediation</strong><small>source · build · exact digest deploy</small></div></li>
          </ol>
          <p>관측·상황 이해·승인 기반 운영 복구와 exact patch-bound Engineering Remediation을 연결했습니다. 실제 source·build·배포 권한은 Windows local edge Repair Runner의 짧은 lease가 살아 있을 때만 열립니다.</p>
        </aside>
      </section>
      </ng-template>

      <ng-template #operationalMonitoring>
      <section class="r2d2-live" aria-labelledby="r2d2-live-title">
        <div class="r2d2-section-heading">
          <div><span class="r2d2-kicker">LIVE · OPERATIONAL CONTROL</span><h2 id="r2d2-live-title">현재 관측 범위, 위험과 관리 작업을 하나의 증거 흐름으로 확인합니다.</h2></div>
          <button class="btn btn-sm btn-outline" [disabled]="operationalBusy()" (click)="loadOperationalIntelligence()">새로고침</button>
        </div>
        @if (operationalError()) {
          <clr-alert clrAlertType="warning" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ operationalError() }}</span></clr-alert-item></clr-alert>
        }
        @if (operationalStatus(); as live) {
          <div class="r2d2-live-metrics">
            <article><span>GRAPH COVERAGE</span><strong>{{ live.graph.fresh }} / {{ live.graph.total }}</strong><small>{{ live.graph.observedAt ? formatDateTime(live.graph.observedAt) : 'fresh snapshot 없음' }}</small></article>
            <article><span>ACTIVE RISK</span><strong [class.danger]="live.risk.severityRank >= 3">{{ live.risk.active }}</strong><small>최고 severity rank {{ live.risk.severityRank }}</small></article>
            <article><span>OBSERVER FENCE</span><strong>{{ live.observer?.fencing_epoch || '-' }}</strong><small>{{ live.observer?.collector_id || 'leader 없음' }}</small></article>
            <article><span>ACTIVATION</span><strong>{{ live.flags.observer ? 'ON' : 'OFF' }}</strong><small>Graph {{ live.flags.graph ? 'ON' : 'OFF' }} · Incident {{ live.flags.incident ? 'ON' : 'OFF' }}</small></article>
          </div>
          <div class="r2d2-live-grid">
            <article class="r2d2-live-panel r2d2-authority-panel">
              <h3>Authority source와 Coverage</h3>
              <table class="table r2d2-authority-table"><thead><tr><th>Source</th><th>인식 상태</th><th>Barrier</th><th>마지막 complete</th><th>Blocker</th></tr></thead><tbody>
                @for (source of live.sources; track source.source) {
                  <tr><td class="os-mono">{{ authoritySourceLabel(source.source) }}</td><td><span class="label" [class.label-success]="source.epistemic_state === 'known'" [class.label-warning]="source.epistemic_state !== 'known'">{{ source.epistemic_state }}</span></td><td>{{ source.snapshot_complete ? 'complete' : 'partial' }}</td><td><time [attr.datetime]="source.last_complete_at || null" [title]="source.last_complete_at ? formatDateTime(source.last_complete_at) : '-'">{{ source.last_complete_at ? formatCompactDateTime(source.last_complete_at) : '-' }}</time></td><td class="os-mono">{{ source.blocker_code || '-' }}</td></tr>
                }
              </tbody></table>
            </article>
            <article class="r2d2-live-panel">
              <h3>R2D2 Self Model</h3>
              <dl class="r2d2-live-kv">
                <dt>관측자</dt><dd>{{ live.flags.observer ? (live.runtime?.degraded ? 'degraded' : 'enabled') : 'disabled' }}</dd>
                <dt>세계 모델</dt><dd>{{ live.graph.fresh === live.graph.total && live.graph.total > 0 ? 'fresh' : (live.graph.total ? 'partial/stale' : 'unknown') }}</dd>
                <dt>판단 모델</dt><dd>{{ live.flags.incident ? 'deterministic correlation enabled' : 'disabled' }}</dd>
                <dt>수행 모델</dt><dd>durable operation · execution-time authorization</dd>
                <dt>Engineering Remediation</dt><dd>{{ engineeringStatus()?.workerReady ? 'local edge Repair Runner ready' : (engineeringStatus()?.executionEnabled ? 'enabled · runner lease 대기' : 'fail-closed') }}</dd>
              </dl>
            </article>
          </div>
        }

        <div class="r2d2-live-grid">
          <article class="r2d2-live-panel">
            <h3>Operational Graph</h3>
            <p class="os-sub">Kubernetes/owner 정본을 대체하지 않는 rebuildable advisory projection입니다.</p>
            <div class="r2d2-scroll-table"><table class="table"><thead><tr><th>Node</th><th>Type</th><th>Namespace</th><th>Health</th><th>인식 상태</th></tr></thead><tbody>
              @for (node of graphNodes(); track node.nodeId) {
                <tr><td><strong>{{ node.displayName }}</strong><div class="os-mono">{{ shortId(node.nodeId) }}</div></td><td>{{ node.nodeType }}</td><td class="os-mono">{{ node.namespace || 'cluster' }}</td><td>{{ node.health }}</td><td>{{ node.epistemicState }}</td></tr>
              }
            </tbody></table></div>
            @if (!graphNodes().length) { <p class="r2d2-empty">활성화되고 complete reconcile을 통과한 graph node가 없습니다.</p> }
          </article>
          <article class="r2d2-live-panel">
            <h3>Incident와 위험 전파</h3>
            <p class="os-sub">상태·severity·근거가 바뀐 material transition만 전역 outbox/SSE로 발행합니다.</p>
            <div class="r2d2-scroll-table"><table class="table"><thead><tr><th>Incident</th><th>상태</th><th>Severity</th><th>원인 확실성</th><th>최근 관측</th></tr></thead><tbody>
              @for (incident of incidents(); track incident.incidentId) {
                <tr><td><button class="btn btn-sm btn-link r2d2-row-action" type="button" (click)="loadIncidentDetail(incident.incidentId)">{{ incident.title }}</button><div class="os-sub">{{ incident.type }} · {{ incident.summary }}</div></td><td>{{ incident.status }}</td><td><span class="label" [class.label-danger]="incident.severity === 'critical' || incident.severity === 'high'" [class.label-warning]="incident.severity === 'warning'">{{ incident.severity }}</span></td><td>{{ incident.causeStatus }} · {{ (incident.confidence * 100).toFixed(0) }}%</td><td>{{ formatDateTime(incident.lastObservedAt) }}</td></tr>
              }
            </tbody></table></div>
            @if (!incidents().length) { <p class="r2d2-empty">현재 조회 가능한 Incident가 없습니다. 이것은 건강함을 단정하지 않으며 source coverage를 함께 확인해야 합니다.</p> }
            @if (selectedIncident(); as detail) {
              <section class="r2d2-detail" aria-label="선택한 Incident timeline">
                <div class="r2d2-detail-head"><strong>{{ detail.title }}</strong><button class="btn btn-sm btn-link" type="button" (click)="selectedIncident.set(null)">닫기</button></div>
                <p class="os-sub">Evidence {{ detail.evidence.length }} · Impact {{ detail.impacts.length }} · Transition {{ detail.timeline.length }}</p>
                <ol>@for (step of detail.timeline; track step.sequence) { <li><span>{{ step.transition }}</span><strong>{{ step.from_status || 'new' }} → {{ step.to_status }}</strong><small>{{ step.reason_code }} · {{ formatDateTime(step.occurred_at) }}</small></li> }</ol>
              </section>
            }
          </article>
        </div>

        <article class="r2d2-live-panel r2d2-operation-panel">
          <div class="r2d2-operation-head"><div><h3>Durable management operation</h3><p class="os-sub">수락 후 실행 시점에 session·permission·AAL·승인을 다시 확인하고 live UID/revision과 postcondition으로 완료 판정합니다.</p></div><span class="label label-info">R1/R2 · R3 unavailable</span></div>
          <div class="r2d2-scroll-table"><table class="table"><thead><tr><th>Operation</th><th>Action</th><th>Risk</th><th>Execution</th><th>Verification</th><th>Attempt</th><th>업데이트</th></tr></thead><tbody>
            @for (operation of operations(); track operation.operationId) {
              <tr><td><button class="btn btn-sm btn-link r2d2-row-action os-mono" type="button" (click)="loadOperationDetail(operation.operationId)">{{ shortId(operation.operationId) }}</button></td><td>{{ operation.action }}</td><td>{{ operation.riskClass }}</td><td>{{ operation.phase }} / {{ operation.executionState }}</td><td>{{ operation.verificationState }}</td><td>{{ operation.attempt }}</td><td>{{ formatDateTime(operation.updatedAt) }}</td></tr>
            }
          </tbody></table></div>
          @if (!operations().length) { <p class="r2d2-empty">durable operation 기록이 없습니다. 작업은 등록된 descriptor와 exact confirmation을 통해서만 생성됩니다.</p> }
          @if (selectedOperation(); as detail) {
            <section class="r2d2-detail" aria-label="선택한 durable operation timeline">
              <div class="r2d2-detail-head"><strong>{{ detail.action }} · {{ detail.phase }}</strong><button class="btn btn-sm btn-link" type="button" (click)="selectedOperation.set(null)">닫기</button></div>
              <p class="os-sub">Approval {{ detail.approvals.length }} · Step {{ detail.steps.length }} · Verification {{ detail.verificationState }}</p>
              @if (detail.approvalConfirmation) {
                <div class="r2d2-operation-approval">
                  <code>{{ detail.approvalConfirmation }}</code>
                  <button class="btn btn-sm btn-primary" type="button" [disabled]="operationApprovalBusy()" (click)="approveOperation(detail)">AAL2 승인</button>
                </div>
              }
              <ol>@for (step of detail.steps; track step.sequence) { <li><span>{{ step.step_type }}</span><strong>{{ step.status }}</strong><small>{{ step.error_code || 'evidence recorded' }} · {{ formatDateTime(step.observed_at) }}</small></li> }</ol>
            </section>
          }
        </article>

        @if (metacognition(); as meta) {
          <article class="r2d2-live-panel r2d2-operation-panel" aria-label="R2D2 실제 메타인지와 Engineering Remediation 상태">
            <div class="r2d2-operation-head">
              <div><h3>SelfModel · Mismatch · Engineering Remediation</h3><p class="os-sub">설명용 문구가 아니라 Observer가 기록한 현재 자기 모델과 expected/actual 불일치, patch-bound 요청의 실제 상태입니다.</p></div>
              <span class="label" [class.label-success]="meta.selfModel?.graphState === 'fresh'" [class.label-warning]="meta.selfModel?.graphState !== 'fresh'">{{ meta.selfModel?.graphState || 'unknown' }}</span>
            </div>
            @if (meta.selfModel; as model) {
              <div class="r2d2-live-metrics r2d2-meta-metrics">
                <article><span>OBSERVER</span><strong>{{ model.observerState }}</strong><small>{{ model.capabilityRevision }}</small></article>
                <article><span>COVERAGE</span><strong>{{ (model.coverage * 100).toFixed(1) }}%</strong><small>{{ model.blockers.length ? model.blockers.join(' · ') : 'blocker 없음' }}</small></article>
                <article><span>OPERATION</span><strong>{{ model.operationState }}</strong><small>execution-time authorization</small></article>
                <article><span>ENGINEERING</span><strong>{{ model.remediationState }}</strong><small>실행 권한은 별도 활성화 gate</small></article>
              </div>
            } @else {
              <p class="r2d2-empty">아직 Observer가 SelfModel 증거를 기록하지 않았습니다. 이것은 ready가 아니라 unknown입니다.</p>
            }
            <h4>Expected / Actual mismatch</h4>
            <div class="r2d2-scroll-table"><table class="table"><thead><tr><th>대상</th><th>유형</th><th>인식 상태</th><th>Expected</th><th>Actual</th><th>복구 판정</th></tr></thead><tbody>
              @for (mismatch of meta.mismatches; track mismatch.mismatchId) {
                <tr><td class="os-mono">{{ shortId(mismatch.subjectNodeId) }}</td><td>{{ mismatch.mismatchType }}</td><td>{{ mismatch.epistemicState }}</td><td class="os-mono">{{ shortId(mismatch.expectedDigest) }}</td><td class="os-mono">{{ shortId(mismatch.actualDigest) }}</td><td>{{ mismatch.assessment ? ('step ' + mismatch.assessment.minimumLadderStep + ' · ' + (mismatch.assessment.engineeringRequired ? 'engineering required' : mismatch.assessment.rationale)) : 'assessment 없음' }}</td></tr>
              }
            </tbody></table></div>
            @if (!meta.mismatches.length) { <p class="r2d2-empty">기록된 mismatch가 없습니다. source coverage가 완전한지 함께 확인해야 합니다.</p> }
          </article>
        }

        <article class="r2d2-live-panel r2d2-operation-panel" aria-label="Engineering Remediation 승인과 실행 상태">
          <div class="r2d2-operation-head">
            <div><h3>Engineering Remediation</h3><p class="os-sub">OSAA가 제안한 exact patch work unit만 한 번 승인합니다. 이후 source patch · test · component-only 배포 · 실제 화면 검증 · 실패 시 rollback은 Repair Runner가 이어서 수행합니다.</p></div>
            <span class="label" [class.label-success]="engineeringStatus()?.workerReady" [class.label-warning]="engineeringStatus() && !engineeringStatus()?.workerReady">{{ engineeringStatus()?.workerReady ? 'RUNNER READY' : (engineeringStatus() ? 'RUNNER WAITING' : 'RUNNER UNKNOWN') }}</span>
          </div>
          @if (engineeringStatusError()) { <div class="alert alert-danger" role="alert"><div class="alert-items"><div class="alert-item static"><div class="alert-text">{{ engineeringStatusError() }}</div></div></div></div> }
          @if (engineeringRequestError()) { <div class="alert alert-danger" role="alert"><div class="alert-items"><div class="alert-item static"><div class="alert-text">{{ engineeringRequestError() }}</div></div></div></div> }
          <div class="r2d2-scroll-table"><table class="table"><thead><tr><th>작업</th><th>범위</th><th>증거</th><th>상태</th><th>작업</th></tr></thead><tbody>
            @for (request of engineeringRequests(); track request.remediationRequestId) {
              <tr>
                <td><strong>{{ request.reason }}</strong><small class="r2d2-work-unit-paths">{{ request.changedPaths.join(' · ') || request.allowedPaths.join(' · ') }}</small></td>
                <td>{{ request.riskLevel }} · {{ request.affectedComponents.join(', ') || '-' }}<small class="r2d2-work-unit-paths">{{ request.releaseScope }} · {{ request.targetChannel }} · {{ request.buildAuthority }}</small></td>
                <td><span class="os-mono" [title]="request.patchDigest">patch {{ shortId(request.patchDigest) }}</span><small class="r2d2-work-unit-paths os-mono" [title]="request.approvalBindingDigest">binding {{ shortId(request.approvalBindingDigest) }}</small></td>
                <td><span class="label" [class.label-success]="isEngineeringSuccess(request.stage)" [class.label-danger]="isEngineeringFailure(request.stage)" [class.label-warning]="request.stage === 'proposed' || request.stage === 'verifying'" [class.label-info]="isEngineeringRunning(request.stage)">{{ engineeringStageLabel(request.stage) }}</span><small class="r2d2-work-unit-paths">{{ formatDateTime(request.updatedAt) }}</small></td>
                <td>
                  @if (request.stage === 'proposed') {
                    <button class="btn btn-sm btn-primary" type="button" [disabled]="engineeringActionBusy() === request.remediationRequestId || !engineeringStatus()?.workerReady" (click)="approveEngineering(request)">{{ engineeringActionBusy() === request.remediationRequestId ? '승인 중' : '승인하고 실행' }}</button>
                  } @else if (request.stage === 'verifying' && request.verificationRoute === '/manage/osaa') {
                    <span class="r2d2-inline-state">현재 화면 자동 검증 중</span>
                  } @else if (request.stage === 'verifying') {
                    <span class="r2d2-inline-state">{{ request.verificationRoute }} 검증 대기</span>
                  } @else {
                    <span class="r2d2-inline-state">{{ engineeringStageAction(request.stage) }}</span>
                  }
                </td>
              </tr>
            }
          </tbody></table></div>
          @if (!engineeringRequests().length && !engineeringRequestsBusy()) { <p class="r2d2-empty">승인 대기 또는 실행 중인 Engineering Remediation 요청이 없습니다.</p> }
          @if (engineeringRequestsBusy() && !engineeringRequests().length) { <p class="r2d2-empty">Engineering Remediation 상태를 확인하고 있습니다.</p> }
        </article>
      </section>
      </ng-template>

      <ng-template #overviewDetails>
      <section class="r2d2-section" aria-labelledby="r2d2-metacognition-title">
        <div class="r2d2-section-heading">
          <div><span class="r2d2-kicker">01 · METACOGNITION</span><h2 id="r2d2-metacognition-title">메타인지란 자신의 지식과 능력의 한계를 데이터로 설명하는 것입니다.</h2></div>
          <p>값이 없다는 사실을 정상으로 오인하지 않고, 판단마다 상태·신뢰도·근거·유효 시점을 함께 보존합니다.</p>
        </div>
        <div class="r2d2-epistemic-grid">
          <article class="known"><span>KNOWN</span><strong>확인됨</strong><p>fresh한 정본 증거로 직접 확인된 상태입니다.</p><small>자동 판단에 사용 가능</small></article>
          <article class="unknown"><span>UNKNOWN</span><strong>알 수 없음</strong><p>판단에 필요한 증거가 아직 존재하지 않습니다.</p><small>정상 판정·mutation 금지</small></article>
          <article class="stale"><span>STALE</span><strong>유효기간 경과</strong><p>과거에는 확인됐지만 freshness를 초과했습니다.</p><small>재관측 전 판단 제한</small></article>
          <article class="conflicting"><span>CONFLICTING</span><strong>정본 충돌</strong><p>둘 이상의 권위 source가 서로 다른 상태를 보고합니다.</p><small>Incident 생성·자동 복구 중지</small></article>
          <article class="inferred"><span>INFERRED</span><strong>추론됨</strong><p>직접 관측이 아닌 관계와 규칙으로 계산한 상태입니다.</p><small>추론 경로 표시·단독 실행 근거 금지</small></article>
          <article class="unobservable"><span>UNOBSERVABLE</span><strong>관측 불가</strong><p>권한, 정책 또는 장애로 현재 확인할 수 없습니다.</p><small>coverage gap을 위험으로 전파</small></article>
        </div>
        <div class="r2d2-evidence-contract" aria-label="판단 증거 계약">
          <span>모든 핵심 판단</span>
          <code>epistemicState</code><i>+</i><code>confidence</code><i>+</i><code>evidenceRefs</code><i>+</i><code>observedAt / expiresAt</code><i>+</i><code>collectionEpoch</code>
        </div>
      </section>

      <section class="r2d2-section r2d2-dark" aria-labelledby="r2d2-four-planes-title">
        <div class="r2d2-section-heading">
          <div><span class="r2d2-kicker">02 · OPERATING MODEL</span><h2 id="r2d2-four-planes-title">세계 모델과 자기 모델이 함께 있어야 안전한 결정을 내릴 수 있습니다.</h2></div>
          <p>네 plane은 논리적인 책임 분리이며, 별도 데이터베이스나 네 개의 신규 서비스를 의미하지 않습니다.</p>
        </div>
        <div class="r2d2-plane-flow" aria-label="R2D2 네 개의 논리 plane">
          <article><span>01</span><strong>World Model</strong><p>resource · relation · desired/actual</p><small>OpenSphere의 구성과 실제 상태</small></article>
          <b aria-hidden="true">→</b>
          <article><span>02</span><strong>Self Model</strong><p>coverage · freshness · capability</p><small>R2D2가 보고 수행할 수 있는 범위</small></article>
          <b aria-hidden="true">→</b>
          <article><span>03</span><strong>Decision Model</strong><p>mismatch · incident · confidence</p><small>불일치, 영향과 불확실성</small></article>
          <b aria-hidden="true">→</b>
          <article><span>04</span><strong>Remediation Model</strong><p>proposal · approval · verification</p><small>허용된 복구와 결과 검증</small></article>
        </div>
        <div class="r2d2-authority-sources">
          <span>AUTHORITY SOURCES</span>
          <strong>Kubernetes</strong><i>·</i><strong>Gitea desired state</strong><i>·</i><strong>Release BOM</strong><i>·</i><strong>Owner APIs</strong><i>·</i><strong>HISS</strong>
          <small>R2D2 projection은 정본을 대체하지 않으며 source · observed time · freshness · evidence digest를 보존합니다.</small>
        </div>
      </section>

      <section class="r2d2-section" aria-labelledby="r2d2-mismatch-title">
        <div class="r2d2-section-heading">
          <div><span class="r2d2-kicker">03 · SITUATIONAL AWARENESS</span><h2 id="r2d2-mismatch-title">기대 상태와 실제 상태의 차이를 원인·영향·신뢰도와 함께 봅니다.</h2></div>
          <p>Mismatch는 곧 변경 승인이 아닙니다. 먼저 증거를 고정하고 가장 작은 안전 조치를 계산합니다.</p>
        </div>
        <div class="r2d2-compare">
          <article><span>EXPECTED STATE</span><strong>어떻게 동작해야 하는가</strong><ul><li>Release BOM · installation lock</li><li>Gitea desired state</li><li>owner policy · capability contract</li><li>환경 profile · namespace contract</li></ul></article>
          <div class="r2d2-compare-core"><span>COMPARE</span><strong>Mismatch</strong><small>evidence + impact<br />+ confidence</small></div>
          <article><span>ACTUAL STATE</span><strong>실제로 어떻게 동작하는가</strong><ul><li>Kubernetes workload · imageID</li><li>runtime owner API</li><li>HISS metric · log · trace</li><li>schema · migration state</li></ul></article>
        </div>
        <div class="r2d2-mismatch-types" aria-label="탐지할 mismatch 유형">
          <span>configuration drift</span><span>image / digest drift</span><span>dependency readiness</span><span>migration lineage</span><span>capability contract</span><span>environment profile</span><span>provenance</span><span>coverage gap</span>
        </div>
      </section>

      <section class="r2d2-section" aria-labelledby="r2d2-repair-title">
        <div class="r2d2-section-heading">
          <div><span class="r2d2-kicker">04 · REMEDIATION LADDER</span><h2 id="r2d2-repair-title">가장 작은 안전 조치부터 평가하고, 소스 변경은 마지막 수단으로 격리합니다.</h2></div>
          <p>각 단계는 durable operation, 정책 gate와 postcondition 검증을 통과해야 다음 상태로 종료됩니다.</p>
        </div>
        <ol class="r2d2-repair-ladder">
          <li><span>00</span><div><strong>재관측</strong><p>complete reconcile · owner 상태 재조회</p></div><small>READ ONLY</small></li>
          <li><span>01</span><div><strong>운영 재시도</strong><p>reconcile 재요청 · notification retry</p></div><small>OWNER CAPABILITY</small></li>
          <li><span>02</span><div><strong>런타임 복구</strong><p>restart · scale · CronJob one-off</p></div><small>DURABLE OPERATION</small></li>
          <li><span>03</span><div><strong>검증된 산출물 복구</strong><p>이전에 검증된 exact digest rollback</p></div><small>RELEASE POLICY</small></li>
          <li><span>04</span><div><strong>선언 상태 복구</strong><p>allowlist된 config · desired-state 변경</p></div><small>GITEA CHANGE LANE</small></li>
          <li [class.future]="!engineeringStatus()?.executionEnabled"><span>05</span><div><strong>Engineering Remediation</strong><p>격리된 source patch · test · component build</p></div><small>EXACT WORK UNIT</small></li>
          <li [class.future]="!engineeringStatus()?.executionEnabled"><span>06</span><div><strong>공급망 배포</strong><p>provenance · exact digest deploy · browser verify · rollback</p></div><small>CONSTITUTION-0005</small></li>
        </ol>
      </section>

      <section class="r2d2-section r2d2-engineering" aria-labelledby="r2d2-engineering-title">
        <div class="r2d2-section-heading">
          <div><span class="r2d2-kicker">05 · ENGINEERING REMEDIATION</span><h2 id="r2d2-engineering-title">관리자 허락은 포괄 권한이 아니라 정확한 patch와 결과물에 결속됩니다.</h2></div>
          <p>OSAA service principal이 요청하고 현재 사용자가 exact patch work unit을 승인합니다. 한 번의 local edge 승인으로 등록된 test·component build·exact digest 배포·검증·롤백을 수행합니다.</p>
        </div>
        <div class="r2d2-engineering-flow" aria-label="Engineering Remediation 안전 흐름">
          <div><span>1</span><strong>Evidence</strong><small>불일치 재현과 원인 후보 고정</small></div>
          <div><span>2</span><strong>Isolate</strong><small>ephemeral worktree / build sandbox</small></div>
          <div><span>3</span><strong>Propose</strong><small>최소 patch와 영향 component 계산</small></div>
          <div><span>4</span><strong>Verify</strong><small>정적 분석 · unit · contract · integration</small></div>
          <div><span>5</span><strong>Approve</strong><small>exact patch digest · risk · expiry</small></div>
          <div><span>6</span><strong>Build</strong><small>SBOM · provenance · signature</small></div>
          <div><span>7</span><strong>Deploy</strong><small>exact digest · postcondition · rollback</small></div>
        </div>
        <div class="r2d2-engineering-grid">
          <article>
            <span class="r2d2-card-label">APPROVAL ENVELOPE</span>
            <h3>승인이 정확히 고정하는 것</h3>
            <dl>
              <div><dt>Source</dt><dd>canonical repository · base revision · allowed paths</dd></div>
              <div><dt>Change</dt><dd>patch digest · reason · required tests</dd></div>
              <div><dt>Impact</dt><dd>affected components/images · release scope</dd></div>
              <div><dt>Delivery</dt><dd>channel · build authority · exact image digest</dd></div>
              <div><dt>Recovery</dt><dd>rollback revision/digest · approval expiry</dd></div>
            </dl>
            <p class="r2d2-invalidation">어느 값이든 바뀌면 기존 승인은 즉시 무효화됩니다.</p>
          </article>
          <article>
            <span class="r2d2-card-label">STRUCTURAL RESOURCES</span>
            <h3>처음부터 예약할 데이터와 실행 경계</h3>
            <div class="r2d2-resource-list">
              <span><code>SelfModel</code> 관측·capability·blocker</span>
              <span><code>CoverageState</code> reconcile·freshness</span>
              <span><code>Mismatch</code> expected/actual·evidence</span>
              <span><code>RemediationAssessment</code> 최소 복구 단계</span>
              <span><code>EngineeringRemediationRequest</code> patch·승인 lifecycle</span>
              <span><code>BuildEvidence</code> test·SBOM·provenance·signature</span>
              <span><code>DeploymentVerification</code> lock·imageID·postcondition</span>
            </div>
          </article>
        </div>
      </section>

      <section class="r2d2-section" aria-labelledby="r2d2-guardrails-title">
        <div class="r2d2-section-heading">
          <div><span class="r2d2-kicker">06 · NON-NEGOTIABLE GUARDRAILS</span><h2 id="r2d2-guardrails-title">최종 목표가 커져도 안전 경계는 넓어지지 않습니다.</h2></div>
          <p>R2D2는 정본과 owner를 대체하는 super-controller가 아니라, 증거와 승인을 연결하는 운영 지능입니다.</p>
        </div>
        <div class="r2d2-guardrails">
          <article><strong>Owner-only mutation</strong><p>Kubernetes 직접 임의 변경 없이 등록된 owner capability 또는 governed adapter만 사용합니다.</p></article>
          <article><strong>Uncertainty blocks action</strong><p>unknown · stale · conflicting · inferred만으로 mutation을 승인하지 않습니다.</p></article>
          <article><strong>Isolated source work</strong><p>source 변경은 격리된 worktree에서만 수행하며 main worktree 직접 수정과 임의 shell은 금지합니다.</p></article>
          <article><strong>Revalidate before execute</strong><p>authorization · approval · precondition을 실행 직전에 다시 확인합니다.</p></article>
          <article><strong>Supply-chain authority</strong><p>build·channel·publication·exact digest는 CONSTITUTION-0005를 그대로 따릅니다.</p></article>
          <article><strong>Verify or rollback</strong><p>정본에서 postcondition과 rollback 결과를 확인하기 전에는 완료가 아닙니다.</p></article>
        </div>
      </section>

      <section class="r2d2-section r2d2-roadmap" aria-labelledby="r2d2-roadmap-title">
        <div class="r2d2-section-heading">
          <div><span class="r2d2-kicker">07 · PHASED DELIVERY</span><h2 id="r2d2-roadmap-title">구현은 단계적으로, identity와 correlation 계약은 최종 목표에 맞춰 지금 고정합니다.</h2></div>
          <p>아래 상태는 source 구현 기준입니다. 운영 migration·배포·기능 활성화는 구현 후 레드팀 평가와 사용자 승인을 별도로 통과해야 합니다.</p>
        </div>
        <div class="r2d2-wave-grid">
          <article class="current"><span>WAVE 0</span><strong>계약·기준선 동결</strong><p>identity · migration lineage · inventory · coverage denominator</p><small>COMPLETE</small></article>
          <article><span>WAVE 1</span><strong>Observer · Graph</strong><p>epoch · barrier · freshness · CoverageState</p><small>SOURCE IMPLEMENTED · ACCEPTANCE PENDING</small></article>
          <article><span>WAVE 2</span><strong>Incident · Impact</strong><p>epistemic state · evidence · confidence</p><small>SOURCE IMPLEMENTED · ACCEPTANCE PENDING</small></article>
          <article><span>WAVE 3</span><strong>Risk propagation</strong><p>Console global state · notification · context</p><small>SOURCE IMPLEMENTED · ACCEPTANCE PENDING</small></article>
          <article><span>WAVE 4</span><strong>Governed recovery</strong><p>instruction · operation · postcondition</p><small>SOURCE IMPLEMENTED · ACCEPTANCE PENDING</small></article>
          <article><span>WAVE 5</span><strong>Operational durability</strong><p>retention · partition · replay · failure isolation</p><small>SOURCE IMPLEMENTED · DRILL PENDING</small></article>
          <article class="future"><span>ENGINEERING REMEDIATION</span><strong>Source repair contract</strong><p>patch approval · sandbox · build evidence · deploy</p><small>EXECUTION SOURCE IMPLEMENTED · ACTIVATION PROHIBITED</small></article>
        </div>
      </section>
      </ng-template>

      <ng-template #runtimeManagement>
      <div class="r2d2-runtime-divider" role="separator"><span>현재 R2D2 runtime 관리</span><small>아래 영역은 실제 연결 상태와 현재 구현된 관리 기능을 표시합니다.</small></div>
      @if (gatewayDown(); as d) {
        <os-backend-unavailable
          feature="R2D2"
          backend="R2D2 runtime (/api/osaa)"
          hint="Console 내장 R2D2 runtime과 Supabase PostgreSQL/pgvector 연결이 준비되면 복구됩니다. R2D2 장애는 콘솔 로그인/관리/Manual에 영향을 주지 않습니다."
          [detail]="d"
        />
      } @else {
        <p class="os-sub">
          R2D2는 Main Shell native capability이며, 보안·실행 격리를 위한 Console 소유 Supabase consumer workload를 사용합니다
          (<code>CONSTITUTION-0004 §4.2</code>). Provider key 미배포 시 채팅은 <strong>Degraded</strong>일 수 있으나 콘솔 관리는 항상 동작합니다.
          @if (health(); as h) { · <code>R2D2 runtime</code> v{{ h.version }} · ns <code>{{ h.namespace }}</code> }
        </p>

        <section class="manage-status-rail" aria-label="R2D2 운영 상태">
          <div><span>Runtime</span><strong [class.ok]="!!health()">{{ health() ? 'Reachable' : 'Unavailable' }}</strong><small>{{ health() ? 'R2D2 runtime' : 'health unavailable' }}</small></div>
          <div><span>LLM keys</span><strong [class.warn]="llmKeysLoaded() && !llmKeys().length">{{ llmKeysLoaded() ? llmKeys().length : 'Loading' }}</strong><small>{{ llmKeys().length ? 'fingerprint inventory' : 'provider custody' }}</small></div>
          <div><span>Knowledge</span><strong>{{ knowledgeStats()?.documents ?? 'Loading' }}</strong><small>{{ knowledgeStats()?.chunks ?? 0 }} chunks</small></div>
          <div><span>Tools</span><strong>{{ toolManifest()?.tools?.length ?? 'Loading' }}</strong><small>registered capabilities</small></div>
          <div><span>Bindings</span><strong>{{ actionBindings()?.bindings?.length ?? 'Loading' }}</strong><small>{{ actionBindings()?.invalidBindings?.length ?? 0 }} invalid</small></div>
          <div><span>Mutation gate</span><strong [class.ok]="mutationGateOpen()" [class.warn]="!mutationGateOpen()">{{ mutationGateOpen() ? 'Server enabled' : 'Closed' }}</strong><small>{{ mutationGateOpen() ? 'governed submissions only' : mutationGateReasonText() }}</small></div>
          <div><span>Full Agent</span><strong [class.ok]="controlPlaneStatus()?.fullyOperational" [class.warn]="controlPlaneStatus() && !controlPlaneStatus()?.fullyOperational">{{ controlPlaneStatus() ? (controlPlaneStatus()?.fullyOperational ? 'Operational' : 'Degraded') : 'Not checked' }}</strong><small>{{ controlPlaneStatus()?.agentControl?.blockers?.length ?? 0 }} explicit blockers</small></div>
        </section>

        @if (msg(); as m) {
          <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)">
            <clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item>
          </clr-alert>
        }

        <clr-tabs>
          <!-- 탭1: R2D2 runtime health/readiness -->
          <clr-tab>
            <button clrTabLink>Runtime</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-sm btn-outline" [disabled]="healthBusy()" (click)="loadHealth()">새로고침</button>
                @if (healthBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
              <div class="os-card">
                <div class="os-card-h">Health / Readiness</div>
                <div class="gw-body">
                  @if (health(); as h) {
                    <span class="label" [class.label-success]="h.status === 'ready'" [class.label-warning]="h.status === 'degraded'">{{ h.status === 'degraded' ? 'Degraded' : 'Reachable' }}</span>
                    <span class="os-mono">R2D2 runtime · v{{ h.version }} · ns {{ h.namespace }}</span>
                    <span class="label label-success">Lexical search ready</span>
                    <span class="label" [class.label-success]="h.semanticSearchReady" [class.label-warning]="!h.semanticSearchReady">
                      Semantic search: {{ h.semanticSearchReady ? 'ready' : 'unavailable' }}
                    </span>
                    <span class="label" [class.label-success]="h.runtimeProjection?.ready" [class.label-warning]="!h.runtimeProjection?.ready">
                      Runtime projection: {{ h.runtimeProjection?.ready ? (h.runtimeProjection?.freshResources + ' fresh') : 'stale' }}
                    </span>
                  } @else {
                    <span class="label label-warning">조회 중이거나 응답 없음</span>
                  }
                  <span class="label" [class.label-success]="mutationGateOpen()" [class.label-warning]="!mutationGateOpen()">
                    Mutation gate: {{ mutationGateOpen() ? 'open' : 'closed' }}{{ !mutationGateOpen() && mutationGateReasonText() ? ' (' + mutationGateReasonText() + ')' : '' }}
                  </span>
                </div>
                <p class="os-sub">Mutation gate는 서버가 보고하는 <code>health.mutationEnabled === true</code>(CONSTITUTION-0004 §4.2 fail-closed)이고 tool manifest · action binding 로드가 모두 성공했을 때만 열립니다. Cluster Manager Activated + HISS Preflight Ready 이전에는 서버가 Kubernetes mutation/action tool을 제공하지 않으므로 이 UI 표시와 무관하게 실행은 항상 403으로 차단됩니다.</p>
              </div>

              @if (controlPlaneStatus(); as control) {
                <div class="os-card osaa-control-readiness">
                  <div class="os-card-h"><span>Complete Agent readiness</span><strong [class.ok]="control.fullyOperational" [class.warn]="!control.fullyOperational">{{ control.fullyOperational ? 'Fully operational' : 'Degraded' }}</strong></div>
                  <p class="os-sub">Owner API 도달 여부와 별개로 지식·실시간 projection·승인 mutation·Platform Support·HISS·Ceph capability를 모두 검증합니다. 마지막 확인 {{ formatDateTime(control.checkedAt) }}</p>
                  @if (control.agentControl.blockers.length) {
                    <div class="osaa-blocker-list" aria-label="R2D2 완전 운영 차단 사유">
                      @for (blocker of control.agentControl.blockers; track blocker) { <code>{{ blocker }}</code> }
                    </div>
                  }
                  <div class="osaa-capability-gaps">
                    <span>Observability missing <strong>{{ control.agentControl.missingCapabilities.observability.join(', ') || 'none' }}</strong></span>
                    <span>HISS owner missing <strong>{{ control.agentControl.missingCapabilities.hisOwner.join(', ') || 'none' }}</strong></span>
                    <span>Ceph owner missing <strong>{{ control.agentControl.missingCapabilities.cephOwner.join(', ') || 'none' }}</strong></span>
                    <span>Recovery owner missing <strong>{{ control.agentControl.missingCapabilities.recoveryOwner?.join(', ') || 'none' }}</strong></span>
                  </div>
                </div>
              } @else if (controlPlaneError()) {
                <clr-alert clrAlertType="warning" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">Complete Agent readiness 조회 실패: {{ controlPlaneError() }}</span></clr-alert-item></clr-alert>
              }

              @if (knowledgeStats(); as ks) {
                @if (!ks.enabled || !ks.semanticSearch.ready) {
                  <clr-alert clrAlertType="info" [clrAlertClosable]="false">
                    <clr-alert-item><span class="alert-text">Degraded: {{ !ks.enabled ? 'RAG/knowledge store가 비활성' : ('semantic embedding 사용 불가 (' + (ks.semanticSearch.reason || 'unknown') + ')') }} — 매뉴얼 검색은 PostgreSQL lexical search로 계속 동작하며, 의미 기반 검색만 저하됩니다.</span></clr-alert-item>
                  </clr-alert>
                }
              } @else if (!llmKeys().length && llmKeysLoaded()) {
                <clr-alert clrAlertType="info" [clrAlertClosable]="false">
                  <clr-alert-item><span class="alert-text">Degraded: 등록된 LLM provider key가 없습니다 — R2D2 채팅만 저하되고 콘솔 관리 기능에는 영향이 없습니다.</span></clr-alert-item>
                </clr-alert>
              }
            </clr-tab-content>
          </clr-tab>

          <!-- 탭2: LLM Provider Keys -->
          <clr-tab>
            <button clrTabLink (click)="ensureLlmKeysLoaded()">LLM Keys</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-sm btn-outline" [disabled]="llmBusy()" (click)="loadLlmKeys()">새로고침</button>
                <button class="btn btn-sm btn-primary" [disabled]="llmBusy()" (click)="openCreateKey()">Key 추가</button>
                @if (llmBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
              <clr-datagrid [clrDgLoading]="llmBusy()">
                <clr-dg-column>ID</clr-dg-column>
                <clr-dg-column>Provider</clr-dg-column>
                <clr-dg-column>Model</clr-dg-column>
                <clr-dg-column>Fingerprint</clr-dg-column>
                <clr-dg-column>상태</clr-dg-column>
                <clr-dg-column>Provider 검증</clr-dg-column>
                <clr-dg-column>토큰 사용량</clr-dg-column>
                <clr-dg-column>업데이트</clr-dg-column>
                <clr-dg-column></clr-dg-column>
                @for (k of llmKeys(); track k.id) {
                  <clr-dg-row>
                    <clr-dg-cell><strong>{{ k.displayName || k.id }}</strong><div class="os-mono">{{ k.id }}</div></clr-dg-cell>
                    <clr-dg-cell>{{ k.provider }}</clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ k.defaultModel || '-' }}</clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ k.keyFingerprint }}</clr-dg-cell>
                    <clr-dg-cell>
                      @if (k.enabled) { <span class="label label-success">Enabled</span> }
                      @else { <span class="label">Disabled</span> }
                    </clr-dg-cell>
                    <clr-dg-cell [attr.title]="k.validationMessage">
                      <span
                        class="label"
                        [class.label-success]="k.validationStatus === 'ready'"
                        [class.label-danger]="k.validationStatus === 'invalid' || k.validationStatus === 'invalid-config' || k.validationStatus === 'model-missing' || k.validationStatus === 'embedding-unavailable' || k.validationStatus === 'embedding-invalid'"
                        [class.label-warning]="k.validationStatus !== 'ready' && k.validationStatus !== 'invalid' && k.validationStatus !== 'invalid-config' && k.validationStatus !== 'model-missing' && k.validationStatus !== 'embedding-unavailable' && k.validationStatus !== 'embedding-invalid'"
                      >{{ llmValidationLabel(k.validationStatus) }}</span>
                      <div class="osaa-validation-detail">{{ k.validationLatencyMs ? (k.validationLatencyMs + 'ms') : '' }}{{ k.validatedAt ? (' · ' + k.validatedAt) : '' }}</div>
                    </clr-dg-cell>
                    <clr-dg-cell>
                      @if (usageKey(k.id); as keyUsage) {
                        <div class="osaa-key-usage">
                          <span>24h <strong>{{ formatCompactTokens(keyUsage.tokens24h) }}</strong></span>
                          <span>7d <strong>{{ formatCompactTokens(keyUsage.tokens7d) }}</strong></span>
                          <span>30d <strong>{{ formatCompactTokens(keyUsage.tokens30d) }}</strong></span>
                        </div>
                      } @else {
                        <span class="os-sub">사용 기록 없음</span>
                      }
                    </clr-dg-cell>
                    <clr-dg-cell class="os-mono">{{ k.updatedAt }} · {{ k.updatedBy }}</clr-dg-cell>
                    <clr-dg-cell>
                      <button class="btn btn-sm btn-link" [disabled]="!!llmTestingId()" (click)="testLlmKey(k)">{{ llmTestingId() === k.id ? '검증 중…' : '재검증' }}</button>
                      <button class="btn btn-sm btn-link" (click)="openRotateKey(k)">회전</button>
                      <button class="btn btn-sm btn-link btn-danger" (click)="openDeleteKey(k)">삭제</button>
                    </clr-dg-cell>
                  </clr-dg-row>
                }
                <clr-dg-placeholder>등록된 LLM key가 없습니다.</clr-dg-placeholder>
                <clr-dg-footer>{{ llmKeys().length }} keys — raw key material은 절대 표시되지 않습니다(fingerprint만).</clr-dg-footer>
              </clr-datagrid>
            </clr-tab-content>
          </clr-tab>

          <!-- 탭3: Supabase append-only LLM usage ledger -->
          <clr-tab>
            <button clrTabLink (click)="ensureUsageLoaded()">Usage</button>
            <clr-tab-content>
              <div class="os-actions osaa-usage-actions">
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 1" [class.btn-outline]="usageRangeDays !== 1" (click)="setUsageRange(1)">24시간</button>
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 7" [class.btn-outline]="usageRangeDays !== 7" (click)="setUsageRange(7)">7일</button>
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 30" [class.btn-outline]="usageRangeDays !== 30" (click)="setUsageRange(30)">30일</button>
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 90" [class.btn-outline]="usageRangeDays !== 90" (click)="setUsageRange(90)">90일</button>
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 365" [class.btn-outline]="usageRangeDays !== 365" (click)="setUsageRange(365)">1년</button>
                <button class="btn btn-sm btn-outline" [disabled]="usageBusy()" (click)="loadLlmUsage()">새로고침</button>
                @if (usageBusy()) { <span class="spinner spinner-inline"></span> }
                @if (usage(); as currentUsage) { <span class="osaa-usage-generated">Supabase 기준 · {{ formatDateTime(currentUsage.generatedAt) }}</span> }
              </div>

              @if (usageError()) {
                <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ usageError() }}</span></clr-alert-item></clr-alert>
              } @else if (usage(); as currentUsage) {
                <section class="osaa-usage-window-grid" aria-label="LLM 사용량 기간 비교">
                  <article>
                    <span>최근 24시간</span><strong>{{ formatTokenCount(currentUsage.windows.hours24.totalTokens) }}</strong>
                    <small>{{ formatTokenCount(currentUsage.windows.hours24.requests) }} requests · {{ formatSuccessRate(currentUsage.windows.hours24.successRate) }}</small>
                  </article>
                  <article>
                    <span>최근 7일</span><strong>{{ formatTokenCount(currentUsage.windows.days7.totalTokens) }}</strong>
                    <small>{{ formatTokenCount(currentUsage.windows.days7.requests) }} requests · {{ formatSuccessRate(currentUsage.windows.days7.successRate) }}</small>
                  </article>
                  <article>
                    <span>최근 30일</span><strong>{{ formatTokenCount(currentUsage.windows.days30.totalTokens) }}</strong>
                    <small>{{ formatTokenCount(currentUsage.windows.days30.requests) }} requests · {{ formatSuccessRate(currentUsage.windows.days30.successRate) }}</small>
                  </article>
                </section>

                <section class="manage-status-rail osaa-usage-summary" aria-label="선택 기간 LLM 사용량 요약">
                  <div><span>Requests</span><strong>{{ formatTokenCount(currentUsage.summary.requests) }}</strong><small>{{ currentUsage.rangeDays }}일 조회 범위</small></div>
                  <div><span>Input tokens</span><strong>{{ formatTokenCount(currentUsage.summary.inputTokens) }}</strong><small>cached {{ formatTokenCount(currentUsage.summary.cachedInputTokens) }}</small></div>
                  <div><span>Output tokens</span><strong>{{ formatTokenCount(currentUsage.summary.outputTokens) }}</strong><small>reasoning {{ formatTokenCount(currentUsage.summary.reasoningTokens) }}</small></div>
                  <div><span>Total tokens</span><strong>{{ formatTokenCount(currentUsage.summary.totalTokens) }}</strong><small>provider reported</small></div>
                  <div><span>Success</span><strong [class.ok]="currentUsage.summary.successRate >= 99" [class.warn]="currentUsage.summary.successRate < 99">{{ formatSuccessRate(currentUsage.summary.successRate) }}</strong><small>{{ currentUsage.summary.failedRequests }} failed</small></div>
                  <div><span>p95 latency</span><strong>{{ currentUsage.summary.p95LatencyMs == null ? '-' : (formatTokenCount(currentUsage.summary.p95LatencyMs) + 'ms') }}</strong><small>provider round trip</small></div>
                  <div><span>Estimated cost</span><strong>{{ usageCostLabel(currentUsage.summary) }}</strong><small>{{ usageCostCoverage(currentUsage.summary) }}</small></div>
                </section>

                <div class="osaa-usage-layout">
                  <section class="os-card osaa-usage-card osaa-grass-card">
                    <div class="os-card-h">사용 빈도 <span>일별 요청 횟수 · KST</span></div>
                    @if (usageGrass(); as grass) {
                      <div class="osaa-grass-chart" aria-label="일별 LLM 사용 빈도">
                        <div class="osaa-grass-axis" aria-hidden="true">
                          <span></span><span>월</span><span></span><span>수</span><span></span><span>금</span><span></span>
                        </div>
                        <div class="osaa-grass-scroll">
                          <div class="osaa-grass-months" aria-hidden="true">
                            @for (week of grass.weeks; track week.key) { <span>{{ week.monthLabel }}</span> }
                          </div>
                          <div class="osaa-grass-weeks">
                            @for (week of grass.weeks; track week.key) {
                              <div class="osaa-grass-week">
                                @for (day of week.days; track day.date) {
                                  @if (day.inRange) {
                                    <span
                                      class="osaa-grass-cell"
                                      [attr.data-level]="day.level"
                                      [attr.title]="usageGrassDayLabel(day)"
                                      [attr.aria-label]="usageGrassDayLabel(day)"
                                      role="img"
                                      tabindex="0"
                                    ></span>
                                  } @else {
                                    <span class="osaa-grass-cell outside-range" aria-hidden="true"></span>
                                  }
                                }
                              </div>
                            }
                          </div>
                        </div>
                      </div>
                      <div class="osaa-grass-footer">
                        <span><strong>{{ grass.activeDays }}</strong>/{{ currentUsage.rangeDays }}일 활동 · 하루 최대 <strong>{{ formatTokenCount(grass.peakRequests) }}</strong> requests</span>
                        <span class="osaa-grass-legend" aria-label="사용 빈도 범례">
                          <small>적음</small>
                          @for (level of usageGrassLevels; track level) { <i class="osaa-grass-cell" [attr.data-level]="level"></i> }
                          <small>많음</small>
                        </span>
                      </div>
                    }
                  </section>
                  <section class="os-card osaa-usage-card">
                    <div class="os-card-h">Consumer sources <span>Console · subShell 투명성</span></div>
                    <div class="osaa-usage-source-list">
                      @for (source of currentUsage.bySource; track source.source) {
                        <div><span><strong>{{ source.source }}</strong><small>{{ source.requests }} requests</small></span><b>{{ formatTokenCount(source.totalTokens) }}</b></div>
                      } @empty { <p class="os-sub">사용 기록이 없습니다.</p> }
                    </div>
                  </section>
                </div>

                <h3 class="osaa-usage-heading">Key별 사용량</h3>
                <clr-datagrid>
                  <clr-dg-column>Key</clr-dg-column><clr-dg-column>Provider / Models</clr-dg-column>
                  <clr-dg-column>Requests</clr-dg-column><clr-dg-column>Input</clr-dg-column>
                  <clr-dg-column>Output</clr-dg-column><clr-dg-column>Total</clr-dg-column>
                  <clr-dg-column>Success</clr-dg-column><clr-dg-column>p95</clr-dg-column><clr-dg-column>마지막 사용</clr-dg-column>
                  @for (item of currentUsage.byKey; track item.keyId) {
                    <clr-dg-row>
                      <clr-dg-cell><strong>{{ llmKeyLabel(item.keyId) }}</strong><div class="os-mono">{{ item.keyId }}</div></clr-dg-cell>
                      <clr-dg-cell>{{ item.provider }}<div class="os-mono">{{ item.models.join(', ') }}</div></clr-dg-cell>
                      <clr-dg-cell>{{ formatTokenCount(item.requests) }}</clr-dg-cell>
                      <clr-dg-cell>{{ formatTokenCount(item.inputTokens) }}</clr-dg-cell>
                      <clr-dg-cell>{{ formatTokenCount(item.outputTokens) }}</clr-dg-cell>
                      <clr-dg-cell><strong>{{ formatTokenCount(item.totalTokens) }}</strong></clr-dg-cell>
                      <clr-dg-cell>{{ formatSuccessRate(item.successRate) }}</clr-dg-cell>
                      <clr-dg-cell>{{ item.p95LatencyMs == null ? '-' : (formatTokenCount(item.p95LatencyMs) + 'ms') }}</clr-dg-cell>
                      <clr-dg-cell>{{ formatDateTime(item.lastUsedAt) }}</clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>선택 기간에 사용된 LLM Key가 없습니다.</clr-dg-placeholder>
                  <clr-dg-footer>{{ currentUsage.byKey.length }} keys · API key 원문과 프롬프트/응답 원문은 저장하지 않습니다.</clr-dg-footer>
                </clr-datagrid>

                <div class="osaa-usage-layout osaa-usage-tables">
                  <section>
                    <h3 class="osaa-usage-heading">모델·작업별</h3>
                    <div class="osaa-usage-source-list">
                      @for (model of currentUsage.byModel; track model.provider + '/' + model.model + '/' + model.operation) {
                        <div><span><strong>{{ model.provider }} / {{ model.model }}</strong><small>{{ model.operation }} · {{ model.requests }} requests</small></span><b>{{ formatTokenCount(model.totalTokens) }}</b></div>
                      } @empty { <p class="os-sub">모델 사용 기록이 없습니다.</p> }
                    </div>
                  </section>
                  <section>
                    <h3 class="osaa-usage-heading">최근 요청</h3>
                    <div class="osaa-usage-recent">
                      @for (event of currentUsage.recent.slice(0, 10); track event.requestId) {
                        <div><span class="label" [class.label-success]="event.status === 'succeeded'" [class.label-danger]="event.status !== 'succeeded'">{{ event.status }}</span><code>{{ event.keyId }}</code><span>{{ event.source }}</span><strong>{{ formatTokenCount(event.totalTokens) }}</strong><time>{{ formatDateTime(event.occurredAt) }}</time></div>
                      } @empty { <p class="os-sub">최근 요청이 없습니다.</p> }
                    </div>
                  </section>
                </div>
              }
            </clr-tab-content>
          </clr-tab>

          <!-- 탭4: correlated agent/tool/retrieval evidence -->
          <clr-tab>
            <button clrTabLink (click)="ensureEvidenceLoaded()">Agent Evidence</button>
            <clr-tab-content>
              <div class="os-actions osaa-usage-actions">
                @for (days of [1, 7, 30, 90, 365]; track days) {
                  <button class="btn btn-sm" [class.btn-primary]="evidenceRangeDays === days" [class.btn-outline]="evidenceRangeDays !== days" (click)="setEvidenceRange(days)">{{ days === 1 ? '24시간' : (days === 365 ? '1년' : days + '일') }}</button>
                }
                <button class="btn btn-sm btn-outline" [disabled]="evidenceBusy()" (click)="loadAgentEvidence()">새로고침</button>
                @if (evidenceBusy()) { <span class="spinner spinner-inline"></span> }
                @if (evidence(); as currentEvidence) { <span class="osaa-usage-generated">Supabase 증적 기준 · {{ formatDateTime(currentEvidence.generatedAt) }}</span> }
              </div>

              @if (evidenceError()) {
                <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ evidenceError() }}</span></clr-alert-item></clr-alert>
              } @else if (evidence(); as currentEvidence) {
                <clr-alert clrAlertType="info" [clrAlertClosable]="false">
                  <clr-alert-item><span class="alert-text">프롬프트·응답·credential·raw log는 저장하지 않습니다. Run ID 아래에 digest와 최소 metadata만 연결합니다. 삭제 API는 없으며 export receipt와 검토된 owner maintenance가 필요합니다.</span></clr-alert-item>
                </clr-alert>
                <section class="manage-status-rail osaa-evidence-summary" aria-label="Agent 증적 요약">
                  <div><span>Runs</span><strong>{{ formatTokenCount(currentEvidence.summary.runs) }}</strong><small>{{ currentEvidence.rangeDays }}일</small></div>
                  <div><span>Completed</span><strong class="ok">{{ formatTokenCount(currentEvidence.summary.completed) }}</strong><small>정상 종료</small></div>
                  <div><span>Failed</span><strong [class.warn]="currentEvidence.summary.failed > 0">{{ formatTokenCount(currentEvidence.summary.failed) }}</strong><small>실패</small></div>
                  <div><span>Running</span><strong>{{ formatTokenCount(currentEvidence.summary.running) }}</strong><small>진행 중</small></div>
                  <div><span>Tool calls</span><strong>{{ formatTokenCount(currentEvidence.summary.toolCalls) }}</strong><small>run correlation</small></div>
                </section>

                <h3 class="osaa-usage-heading">보존·Legal hold 정책</h3>
                <clr-datagrid>
                  <clr-dg-column>Stream</clr-dg-column><clr-dg-column>Policy</clr-dg-column>
                  <clr-dg-column>Rows / oldest</clr-dg-column><clr-dg-column>Due / exported</clr-dg-column>
                  <clr-dg-column>Last export</clr-dg-column><clr-dg-column></clr-dg-column>
                  @for (policy of currentEvidence.retention; track policy.stream) {
                    <clr-dg-row>
                      <clr-dg-cell><strong>{{ policy.stream }}</strong>@if (policy.legalHold) { <div><span class="label label-warning">Legal hold</span></div> }</clr-dg-cell>
                      <clr-dg-cell>{{ policy.retentionDays }}일<div class="os-mono">{{ policy.disposition }}</div></clr-dg-cell>
                      <clr-dg-cell>{{ formatTokenCount(policy.rowCount) }}<div class="os-mono">{{ formatDateTime(policy.oldestAt || '') }}</div></clr-dg-cell>
                      <clr-dg-cell><strong>{{ formatTokenCount(policy.dueRows) }}</strong> / {{ formatTokenCount(policy.exportCoveredRows) }}</clr-dg-cell>
                      <clr-dg-cell>{{ formatDateTime(policy.lastExportAt || '') }}</clr-dg-cell>
                      <clr-dg-cell><button class="btn btn-sm btn-link" [disabled]="evidenceSaving()" (click)="openRetentionPolicy(policy)">정책 변경</button></clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>보존 정책이 없습니다.</clr-dg-placeholder>
                </clr-datagrid>

                <h3 class="osaa-usage-heading">Run → retrieval / tool / provider correlation</h3>
                <clr-accordion [clrAccordionMultiPanel]="true" class="osaa-evidence-runs">
                  @for (run of currentEvidence.runs; track run.runId) {
                    <clr-accordion-panel>
                      <clr-accordion-title>
                        <span class="osaa-evidence-run-title"><span class="label" [class.label-success]="run.status === 'completed'" [class.label-danger]="run.status === 'failed'" [class.label-warning]="run.status === 'running'">{{ run.status }}</span><code>{{ shortId(run.runId) }}</code><strong>{{ run.provider }} / {{ run.model }}</strong><span>{{ run.actorLabel }}</span><time>{{ formatDateTime(run.startedAt) }}</time></span>
                      </clr-accordion-title>
                      <clr-accordion-content *clrIfExpanded>
                        <div class="osaa-evidence-run-meta"><code>run {{ run.runId }}</code><code>request {{ run.requestDigest }}</code><span>{{ run.steps.length }} steps · {{ run.retrievals.length }} retrieval hits · {{ run.tools.length }} tool evidence · {{ run.providerCalls.length }} provider calls</span></div>
                        <div class="osaa-evidence-grid">
                          <section><h4>Retrieval revisions</h4>
                            @for (item of run.retrievals; track item.requestId + '-' + item.rank) { <div class="osaa-evidence-item"><span>#{{ item.rank }} · {{ item.title || item.sourceId }}</span><code>{{ item.documentRevision || '-' }}</code><small>score {{ item.score.toFixed(3) }}</small></div> }
                            @empty { <p class="os-sub">retrieval 없음</p> }
                          </section>
                          <section><h4>Tool evidence</h4>
                            @for (item of run.tools; track item.requestId) { <div class="osaa-evidence-item"><span>{{ item.toolId }}</span><code>{{ item.target }}</code><small>{{ item.status }} · {{ item.permissionCode }}</small></div> }
                            @empty { <p class="os-sub">tool 호출 없음</p> }
                          </section>
                          <section><h4>Provider calls</h4>
                            @for (item of run.providerCalls; track item.requestId) { <div class="osaa-evidence-item"><span>{{ item.operation }} · {{ item.status }}</span><code>{{ item.provider }}/{{ item.model }}</code><small>{{ formatTokenCount(item.totalTokens) }} tokens · {{ item.latencyMs == null ? '-' : item.latencyMs + 'ms' }}</small></div> }
                            @empty { <p class="os-sub">provider 호출 증적 없음</p> }
                          </section>
                        </div>
                      </clr-accordion-content>
                    </clr-accordion-panel>
                  }
                </clr-accordion>
              }
            </clr-tab-content>
          </clr-tab>

          <!-- 탭5: Knowledge / Manual Registry -->
          <clr-tab>
            <button clrTabLink (click)="ensureKnowledgeLoaded()">Knowledge</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="loadKnowledgeStats()">새로고침</button>
                <button class="btn btn-sm btn-outline" [disabled]="knowledgeBusy()" (click)="seedBundledManuals()">Seed bundled manuals</button>
                <button class="btn btn-sm btn-primary" [disabled]="knowledgeBusy()" (click)="reembedKnowledge()">Re-embed</button>
                @if (knowledgeBusy()) { <span class="spinner spinner-inline"></span> }
              </div>
              @if (knowledgeStats(); as ks) {
                <div class="stat-grid">
                  <div><span>Documents</span><strong>{{ ks.documents }}</strong></div>
                  <div><span>Chunks</span><strong>{{ ks.chunks }}</strong></div>
                  <div><span>Manual docs</span><strong>{{ ks.manualDocuments || 0 }}</strong></div>
                  <div><span>Manual chunks</span><strong>{{ ks.manualChunks || 0 }}</strong></div>
                  <div><span>Concepts</span><strong>{{ ks.manualConcepts || 0 }}</strong></div>
                  <div><span>Relations</span><strong>{{ ks.manualRelations || 0 }}</strong></div>
                  <div><span>Vector dim</span><strong>{{ ks.embedDim }}</strong></div>
                  <div><span>Embedding keys</span><strong>{{ ks.embeddingKeys.length }}</strong></div>
                  <div><span>Lexical search</span><strong>{{ ks.lexicalSearchReady ? 'Ready' : 'Unavailable' }}</strong></div>
                  <div><span>Semantic search</span><strong>{{ ks.semanticSearch.ready ? 'Ready' : 'Degraded' }}</strong></div>
                </div>
                <p class="os-sub">Manual sources:
                  @for (s of ks.manualSources || []; track s.source) { <span class="label label-purple">{{ s.source }} {{ s.documents }}/{{ s.chunks }}</span> }
                  @if (!(ks.manualSources || []).length) { <span class="os-mono">없음 — "Seed bundled manuals" 사용</span> }
                </p>
              } @else if (knowledgeError()) {
                <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ knowledgeError() }}</span></clr-alert-item></clr-alert>
              } @else {
                <p class="os-sub">불러오는 중…</p>
              }
            </clr-tab-content>
          </clr-tab>

          <!-- 탭6: Tool Registry / Action Bindings -->
          <clr-tab>
            <button clrTabLink (click)="ensureToolsLoaded()">Tools &amp; Bindings</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-sm btn-outline" [disabled]="toolBusy()" (click)="loadToolManifest()">Tools 새로고침</button>
                <button class="btn btn-sm btn-outline" [disabled]="toolBusy()" (click)="loadActionBindings()">Bindings 새로고침</button>
                @if (toolBusy()) { <span class="spinner spinner-inline"></span> }
              </div>

              @if (toolManifest(); as tm) {
                <h3>Tool Registry <span class="os-engine">{{ tm.tools.length }} tools</span></h3>
                <clr-datagrid>
                  <clr-dg-column>Tool</clr-dg-column>
                  <clr-dg-column>Channel</clr-dg-column>
                  <clr-dg-column>Endpoint</clr-dg-column>
                  <clr-dg-column>Risk</clr-dg-column>
                  <clr-dg-column>Confirmation</clr-dg-column>
                  @for (t of tm.tools; track t.id) {
                    <clr-dg-row>
                      <clr-dg-cell><strong>{{ t.name }}</strong><div class="os-mono">{{ t.id }}</div></clr-dg-cell>
                      <clr-dg-cell>{{ t.channel }}</clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ t.endpoint?.method || '-' }} {{ t.endpoint?.path || '-' }}</clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-success]="t.readOnly" [class.label-warning]="!t.readOnly">{{ t.riskLevel || (t.readOnly ? 'read' : 'write') }}</span></clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ t.confirmation || 'none' }}</clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>등록된 tool이 없습니다.</clr-dg-placeholder>
                </clr-datagrid>
              }

              @if (actionBindings(); as ab) {
                <h3>Action Bindings <span class="os-engine">{{ ab.bindings.length }}건 · invalid {{ ab.invalidBindings.length }}</span></h3>
                <clr-datagrid>
                  <clr-dg-column>Binding</clr-dg-column>
                  <clr-dg-column>Intent / Risk</clr-dg-column>
                  <clr-dg-column>Tool</clr-dg-column>
                  <clr-dg-column>Confirmation</clr-dg-column>
                  <clr-dg-column></clr-dg-column>
                  @for (b of ab.bindings; track b.id) {
                    <clr-dg-row>
                      <clr-dg-cell><strong>{{ b.title }}</strong><div class="os-mono">{{ b.id }}</div></clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-success]="b.riskLevel === 'read'" [class.label-warning]="b.riskLevel !== 'read'">{{ b.intent }} / {{ b.riskLevel }}</span></clr-dg-cell>
                      <clr-dg-cell><span class="os-mono">{{ b.toolId }}</span> @if (b.valid === false) { <span class="label label-danger">invalid</span> }</clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ b.confirmation }}</clr-dg-cell>
                      <clr-dg-cell>
                        <button class="btn btn-sm btn-link" [disabled]="b.valid === false" (click)="openExecute(b)">Use</button>
                      </clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>등록된 action binding이 없습니다.</clr-dg-placeholder>
                </clr-datagrid>
              }
            </clr-tab-content>
          </clr-tab>
        </clr-tabs>

        <!-- LLM key 생성/회전 — 인라인 폼 대신 우측 슬라이딩 패널. apiKey는 password 입력이고 성공/실패 직후 즉시 비운다. -->
        <os-panel [open]="llmPanelOpen()" [title]="llmEditingId() ? 'LLM Key 회전 — ' + llmEditingId() : 'LLM Key 추가'" subtitle="R2D2 · Kubernetes Secret custody" (closed)="closeKeyPanel()">
          <div class="osaa-key-intro">
            <strong>Provider credential</strong>
            <p>API key는 게이트웨이가 Kubernetes Secret으로만 보관합니다. 이 화면은 raw key를 저장·재표시하지 않으며, 저장 직후 입력값을 비웁니다.</p>
          </div>
          <form clrForm clrLayout="vertical" class="clr-form-full-width osaa-key-form" autocomplete="off">
            <div class="osaa-form-section">
              <strong>Provider configuration</strong>
              <span>식별자와 provider endpoint</span>
            </div>
            <div class="osaa-generated-id" aria-label="설정 ID">
              <span class="osaa-generated-id-label">설정 ID <small>(자동 생성 · API key 아님)</small></span>
              <code>{{ llmForm.id }}</code>
              <span class="osaa-generated-id-helper">Provider 선택에 따라 생성되며 R2D2 runtime과 감사 로그에서만 사용합니다.</span>
            </div>
            <clr-select-container>
              <label>Provider</label>
              <select clrSelect [(ngModel)]="llmForm.provider" (ngModelChange)="onLlmProviderChange($event)" name="osaa-key-provider" [disabled]="llmSaving()">
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="azure-openai">Azure OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
                <option value="custom">Custom</option>
              </select>
            </clr-select-container>
            <clr-input-container>
              <label>Display name</label>
              <input clrInput [(ngModel)]="llmForm.displayName" name="osaa-key-display" placeholder="OpenAI Main" [disabled]="llmSaving()" maxlength="120" />
            </clr-input-container>
            <clr-input-container>
              <label>Base URL</label>
              <input clrInput [(ngModel)]="llmForm.baseUrl" name="osaa-key-baseurl" placeholder="https://api.openai.com/v1" [disabled]="llmSaving()" maxlength="200" />
            </clr-input-container>
            <div class="osaa-form-section">
              <strong>Model routing</strong>
              <span>기본 응답 모델과 knowledge embedding 모델</span>
            </div>
            <clr-input-container>
              <label>Default model</label>
              <input clrInput [(ngModel)]="llmForm.defaultModel" name="osaa-key-model" placeholder="gpt-4.1" [disabled]="llmSaving()" maxlength="128" />
            </clr-input-container>
            <clr-input-container>
              <label>Embedding model (선택)</label>
              <input clrInput [(ngModel)]="llmForm.embeddingModel" name="osaa-key-embed" placeholder="text-embedding-3-large" [disabled]="llmSaving()" maxlength="128" />
            </clr-input-container>
            <div class="osaa-form-section">
              <strong>Credential & governance</strong>
              <span>비밀 값과 운영 변경 증거</span>
            </div>
            <div class="osaa-field-wide osaa-secret-control">
              <label class="clr-control-label" for="osaa-key-secret">API key{{ llmEditingId() ? ' (비우면 메타데이터만 갱신)' : '' }}</label>
              <div class="osaa-secret-input-shell">
                <input
                  id="osaa-key-secret"
                  class="clr-input"
                  [type]="llmSecretVisible() ? 'text' : 'password'"
                  autocomplete="new-password"
                  [(ngModel)]="llmForm.apiKey"
                  (ngModelChange)="onLlmApiKeyChange($event)"
                  name="osaa-key-secret"
                  placeholder="sk-..."
                  [disabled]="llmSaving()"
                  maxlength="256"
                  aria-describedby="osaa-key-secret-help"
                />
                <button
                  type="button"
                  class="osaa-secret-toggle"
                  [attr.aria-label]="llmSecretVisible() ? 'API key 숨기기' : 'API key 표시'"
                  [attr.title]="llmSecretVisible() ? 'API key 숨기기' : 'API key 표시'"
                  [attr.aria-pressed]="llmSecretVisible()"
                  [disabled]="llmSaving() || !llmForm.apiKey"
                  (click)="toggleLlmSecretVisibility()"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="2.75" />
                    @if (llmSecretVisible()) { <path d="M4 4l16 16" /> }
                  </svg>
                </button>
              </div>
              <span id="osaa-key-secret-help" class="clr-subtext">눈동자를 누르면 입력값을 확인할 수 있습니다. 원문은 저장 후 다시 조회할 수 없습니다.</span>
            </div>
            <clr-checkbox-container>
              <clr-checkbox-wrapper>
                <input type="checkbox" clrCheckbox [(ngModel)]="llmForm.enabled" name="osaa-key-enabled" [disabled]="llmSaving()" />
                <label>Enabled</label>
              </clr-checkbox-wrapper>
            </clr-checkbox-container>
            <clr-input-container class="osaa-field-wide">
              <label>사유 (필수)</label>
              <input clrInput [(ngModel)]="llmForm.reason" name="osaa-key-reason" placeholder="초기 설정 / 회전 사유" [disabled]="llmSaving()" maxlength="200" />
              <clr-control-helper>8자 이상의 변경 사유가 Console 감사 증거에 기록됩니다.</clr-control-helper>
            </clr-input-container>
          </form>
          <div osPanelFooter class="panel-actions">
            <button class="btn btn-primary" [disabled]="llmSaving() || !llmForm.id.trim() || (!llmEditingId() && !llmForm.apiKey.trim()) || llmForm.reason.trim().length < 8" (click)="saveLlmKey()">저장</button>
            <button class="btn btn-outline" [disabled]="llmSaving()" (click)="closeKeyPanel()">취소</button>
            @if (llmSaving()) { <span class="spinner spinner-inline"></span> }
          </div>
        </os-panel>

        <os-panel [open]="retentionPanelOpen()" [title]="retentionForm.stream ? 'Evidence retention — ' + retentionForm.stream : 'Evidence retention'" subtitle="Supabase evidence owner · AAL2 required" (closed)="closeRetentionPolicy()">
          <clr-alert clrAlertType="info" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text">이 설정은 보존·legal hold·export 필요 조건을 관리합니다. 정책 변경 자체는 증거를 삭제하지 않으며, R2D2에는 purge API가 없습니다.</span></clr-alert-item>
          </clr-alert>
          <form clrForm clrLayout="vertical" class="clr-form-full-width osaa-retention-form">
            <div class="osaa-generated-id"><span class="osaa-generated-id-label">Evidence stream</span><code>{{ retentionForm.stream }}</code></div>
            <clr-input-container>
              <label>Retention days</label>
              <input clrInput type="number" min="30" max="3650" [(ngModel)]="retentionForm.retentionDays" name="evidence-retention-days" [disabled]="evidenceSaving()" />
              <clr-control-helper>30–3650일</clr-control-helper>
            </clr-input-container>
            <clr-select-container>
              <label>Disposition</label>
              <select clrSelect [(ngModel)]="retentionForm.disposition" name="evidence-retention-disposition" [disabled]="evidenceSaving()">
                <option value="retain">retain</option>
                <option value="export-before-delete">export-before-delete</option>
              </select>
            </clr-select-container>
            <clr-checkbox-container>
              <clr-checkbox-wrapper><input type="checkbox" clrCheckbox [(ngModel)]="retentionForm.legalHold" name="evidence-retention-hold" [disabled]="evidenceSaving()" /><label>Legal hold</label></clr-checkbox-wrapper>
            </clr-checkbox-container>
            <clr-input-container>
              <label>변경 사유</label>
              <input clrInput [(ngModel)]="retentionForm.reason" name="evidence-retention-reason" maxlength="500" placeholder="8자 이상의 운영 사유" [disabled]="evidenceSaving()" />
            </clr-input-container>
            <clr-input-container>
              <label>정확한 확인 문구</label>
              <input clrInput [(ngModel)]="retentionForm.confirm" name="evidence-retention-confirm" [placeholder]="expectedRetentionConfirm()" [disabled]="evidenceSaving()" />
              <clr-control-helper><code>{{ expectedRetentionConfirm() }}</code></clr-control-helper>
            </clr-input-container>
          </form>
          <div osPanelFooter class="panel-actions">
            <button class="btn btn-primary" [disabled]="!canSaveRetentionPolicy()" (click)="saveRetentionPolicy()">정책 저장</button>
            <button class="btn btn-outline" [disabled]="evidenceSaving()" (click)="closeRetentionPolicy()">취소</button>
            @if (evidenceSaving()) { <span class="spinner spinner-inline"></span> }
          </div>
        </os-panel>

        <os-action-dialog
          [open]="!!deleteTarget()"
          title="LLM Key 삭제"
          [message]="deleteTarget() ? ('키 ' + deleteTarget()!.id + ' 를 삭제합니다. 진행 중인 채팅에 즉시 영향을 줄 수 있습니다.') : ''"
          confirmLabel="삭제"
          [danger]="true"
          [busy]="llmBusy()"
          [reasonRequired]="true"
          reasonLabel="삭제 사유"
          [minReasonLength]="4"
          (confirmed)="confirmDeleteKey($event)"
          (cancelled)="cancelDeleteKey()"
        />

        <!-- Action binding 실행 — 정확한 confirmation 문자열 + 사유가 모두 충족돼야만 실행 버튼이 활성화되고,
             그 전에는 절대 fetch하지 않는다(로컬 게이트). 서버가 다시 독립적으로 confirmation을 검증한다. -->
        <os-panel [open]="!!execBinding()" [title]="execBinding() ? 'Execute — ' + execBinding()!.title : 'Execute'" subtitle="audited binding execution" (closed)="closeExecute()">
          @if (execBinding(); as b) {
            <p class="os-sub">
              <span class="os-mono">{{ b.id }}</span> · {{ b.intent }} / <span class="label" [class.label-success]="b.riskLevel === 'read'" [class.label-warning]="b.riskLevel !== 'read'">{{ b.riskLevel }}</span>
              · tool <span class="os-mono">{{ b.toolId }}</span>
            </p>
            @if (b.riskLevel !== 'read' && !mutationGateOpen()) {
              <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
                <clr-alert-item><span class="alert-text">Mutation gate closed{{ mutationGateReasonText() ? ' (' + mutationGateReasonText() + ')' : '' }} — 서버가 Kubernetes mutation/action tool을 아직 제공하지 않습니다(CONSTITUTION-0004 §4.2). health.mutationEnabled가 true를 보고하고 tool manifest/action binding 로드가 모두 성공해야 이 버튼이 활성화되며, 그 뒤에도 서버가 다시 독립적으로 gate와 confirmation을 검증합니다.</span></clr-alert-item>
              </clr-alert>
            }
            <form clrForm clrLayout="vertical">
              @for (key of execFieldKeys(b); track key) {
                <clr-input-container>
                  <label>{{ key }}</label>
                  <input clrInput [(ngModel)]="execInputs[key]" [name]="'exec-' + key" [placeholder]="b.requiredInputs?.fields?.[key] || ''" [disabled]="execBusy()" />
                </clr-input-container>
              }
              @if (b.confirmation !== 'none') {
                <clr-input-container>
                  <label>Confirmation (정확히 일치해야 함)</label>
                  <input clrInput [(ngModel)]="execConfirm" name="exec-confirm" [placeholder]="expectedConfirmText()" [disabled]="execBusy()" />
                </clr-input-container>
                <p class="os-sub">정확히 입력: <code>{{ expectedConfirmText() }}</code></p>
              }
              <clr-input-container>
                <label>사유 (필수)</label>
                <input clrInput [(ngModel)]="execReason" name="exec-reason" placeholder="실행 목적" [disabled]="execBusy()" maxlength="240" />
              </clr-input-container>
            </form>
            <div class="panel-actions">
              <button class="btn btn-primary" [disabled]="!canSubmitExecute()" (click)="executeBinding()">Execute</button>
              <button class="btn btn-outline" [disabled]="execBusy()" (click)="closeExecute()">취소</button>
              @if (execBusy()) { <span class="spinner spinner-inline"></span> }
            </div>
            @if (execError()) { <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ execError() }}</span></clr-alert-item></clr-alert> }
            @if (execResult()) { <pre class="exec-result">{{ execResult() }}</pre> }
          }
        </os-panel>
      }
      </ng-template>

      <clr-tabs class="r2d2-page-tabs" aria-label="R2D2 관리 페이지 분류">
        <clr-tab>
          <button clrTabLink id="r2d2-overview-tab">개요와 구조</button>
          <clr-tab-content id="r2d2-overview-panel">
            <div class="r2d2-top-tab-content">
              <ng-container [ngTemplateOutlet]="overviewIntro"></ng-container>
              <ng-container [ngTemplateOutlet]="overviewDetails"></ng-container>
            </div>
          </clr-tab-content>
        </clr-tab>
        <clr-tab>
          <button clrTabLink id="r2d2-monitoring-tab">
            관측 및 운영
            <span class="r2d2-tab-state" [class.state-off]="dialogueMode() === 'off'" [class.state-on]="dialogueMode() !== 'off' && dialogueMode() !== 'unknown'">{{ dialogueMode() }}</span>
          </button>
          <clr-tab-content id="r2d2-monitoring-panel">
            <div class="r2d2-top-tab-content">
              <section class="r2d2-dialogue-state" [class.state-off]="dialogueMode() === 'off'" [class.state-unknown]="dialogueMode() === 'unknown'" aria-labelledby="r2d2-dialogue-state-title">
                <div class="r2d2-dialogue-state-heading">
                  <div>
                    <span class="r2d2-kicker">LIVE POLICY · DIALOGUE STATE TRACKER</span>
                    <h2 id="r2d2-dialogue-state-title">OSAA Dialogue State Tracker</h2>
                    <p>{{ dialogueModeDescription() }}</p>
                  </div>
                  <div class="r2d2-dialogue-mode" [class.state-off]="dialogueMode() === 'off'" [class.state-on]="dialogueMode() !== 'off' && dialogueMode() !== 'unknown'">
                    <span>MODE</span>
                    <strong>{{ dialogueMode() }}</strong>
                    <small><code>OSAA_DIALOGUE_STATE_MODE</code></small>
                  </div>
                </div>
                <div class="r2d2-dialogue-policy-grid">
                  <article [class.enabled]="health()?.dialogueState?.recordTransitions"><span>대화 전이 기록</span><strong>{{ health()?.dialogueState?.recordTransitions ? 'ON' : 'OFF' }}</strong><small>turn별 상태 변경과 revision 보존</small></article>
                  <article [class.enabled]="health()?.dialogueState?.exposeContext"><span>문맥 projection</span><strong>{{ health()?.dialogueState?.exposeContext ? 'ON' : 'OFF' }}</strong><small>검증된 대화 상태를 응답에 노출</small></article>
                  <article [class.enabled]="health()?.dialogueState?.enforceCurrentFacts"><span>현재 사실 강제</span><strong>{{ health()?.dialogueState?.enforceCurrentFacts ? 'ON' : 'OFF' }}</strong><small>Owner typed projection과 결정적 렌더러 사용</small></article>
                  <article [class.enabled]="health()?.dialogueState?.enforceMutations"><span>변경 대화 강제</span><strong>{{ health()?.dialogueState?.enforceMutations ? 'ON' : 'OFF' }}</strong><small>계획·승인·operation binding 적용</small></article>
                </div>
                <div class="r2d2-dialogue-control" aria-labelledby="r2d2-dialogue-control-title">
                  <div>
                    <strong id="r2d2-dialogue-control-title">관리자 모드 선택</strong>
                    <small>선택한 정책은 OSAA Gateway 전체 복제본에 적용되며 변경 시 한 번만 순차 재시작됩니다.</small>
                  </div>
                  <div class="r2d2-dialogue-switch" role="radiogroup" aria-label="OSAA Dialogue State Tracker 모드">
                    @for (mode of dialogueModes; track mode.value) {
                      <button type="button" role="radio"
                        [attr.aria-checked]="selectedDialogueMode() === mode.value"
                        [class.active]="selectedDialogueMode() === mode.value"
                        [disabled]="dialogueControlBusy()"
                        (click)="selectDialogueMode(mode.value)">
                        <span>{{ mode.label }}</span><small>{{ mode.help }}</small>
                      </button>
                    }
                  </div>
                  <div class="r2d2-dialogue-apply">
                    <span>실제 {{ dialogueMode() }} · 목표 {{ dialogueControl()?.mode || 'off' }}</span>
                    @if (dialogueControlError()) { <small class="error">{{ dialogueControlError() }}</small> }
                    @else if (dialogueControl()?.rollout?.ready === false) { <small>Gateway {{ dialogueControl()?.rollout?.readyReplicas || 0 }}/{{ dialogueControl()?.rollout?.desiredReplicas || 0 }} 전환 중</small> }
                    <button class="btn btn-sm btn-primary" type="button"
                      [disabled]="dialogueControlBusy() || selectedDialogueMode() === dialogueControl()?.mode"
                      (click)="applyDialogueMode()">
                      {{ dialogueControlBusy() ? '적용 중' : '모드 적용' }}
                    </button>
                  </div>
                </div>
                <footer>
                  <span>관측 기준 <code>/api/osaa/health</code> · Runtime이 보고한 실제 서버 정책</span>
                  <button class="btn btn-sm btn-outline" type="button" [disabled]="healthBusy()" (click)="loadHealth()">상태 새로고침</button>
                </footer>
              </section>

              <ng-container [ngTemplateOutlet]="operationalMonitoring"></ng-container>
              <ng-container [ngTemplateOutlet]="runtimeManagement"></ng-container>
            </div>
          </clr-tab-content>
        </clr-tab>
      </clr-tabs>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .gw-body { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; padding: 0.6rem 0.9rem; }
      .osaa-control-readiness .os-card-h { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
      .osaa-blocker-list { display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 0 0.9rem 0.7rem; }
      .osaa-blocker-list code { border: 1px solid #e0a046; background: #fff7e6; color: #7a4300; padding: 0.28rem 0.42rem; font-size: 0.8125rem; }
      .osaa-capability-gaps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--os-hairline); }
      .osaa-capability-gaps span { display: grid; gap: 0.2rem; min-width: 0; padding: 0.75rem; border-right: 1px solid var(--os-hairline); color: var(--os-ink-muted); font-size: 0.875rem; }
      .osaa-capability-gaps span:last-child { border-right: 0; }
      .osaa-capability-gaps strong { color: var(--os-ink); overflow-wrap: anywhere; font-size: 1rem; }
      .stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.6rem; margin-bottom: 0.55rem; }
      .stat-grid div { border: 1px solid #e1e5ea; border-radius: 4px; padding: 0.55rem 0.65rem; background: #f8fafc; }
      .stat-grid span { display: block; color: var(--os-muted); font-size: 0.875rem; }
      .stat-grid strong { display: block; margin-top: 0.2rem; font-size: 1.25rem; color: #1b2733; }
      .panel-actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
      .osaa-key-intro { margin: 0 0 1rem; padding: 0 0 0.8rem; border-bottom: 1px solid var(--os-hairline); }
      .osaa-key-intro strong { display: block; color: var(--os-ink); font-size: 1rem; }
      .osaa-key-intro p { max-width: 62rem; margin: 0.3rem 0 0; color: var(--os-muted); font-size: 1rem; line-height: 1.6; }
      .osaa-key-form { --os-panel-form-max: 68rem; width: 100%; max-width: 68rem; display: grid; grid-template-columns: repeat(2, minmax(16rem, 1fr)); column-gap: 1.4rem; row-gap: 0; padding: 0; }
      .osaa-key-form clr-input-container,
      .osaa-key-form clr-select-container,
      .osaa-key-form clr-checkbox-container { min-width: 0; display: block; }
      .osaa-generated-id { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 0.28rem; margin-top: 0.7rem; padding: 0.55rem 0.65rem; border: 1px solid var(--os-hairline); border-radius: 3px; background: #f7f9fa; }
      .osaa-generated-id-label { color: var(--os-ink); font-size: 0.875rem; font-weight: 600; }
      .osaa-generated-id-label small { color: var(--os-muted); font-size: 0.8125rem; font-weight: 400; }
      .osaa-generated-id code { color: #1f4f75; font-size: 0.875rem; font-weight: 600; }
      .osaa-generated-id-helper { color: var(--os-muted); font-size: 0.875rem; line-height: 1.5; }
      .osaa-key-form .osaa-field-wide,
      .osaa-form-section { grid-column: 1 / -1; }
      .osaa-form-section { display: flex; align-items: baseline; gap: 0.45rem; margin: 1rem 0 -0.15rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--os-hairline); }
      .osaa-form-section:first-child { margin-top: 0; }
      .osaa-form-section strong { color: var(--os-ink); font-size: 1rem; }
      .osaa-form-section span { color: var(--os-muted); font-size: 0.875rem; }
      :host ::ng-deep .osaa-key-form .clr-form-control { margin-top: 0.7rem; }
      :host ::ng-deep .osaa-key-form .clr-control-container,
      :host ::ng-deep .osaa-key-form .clr-input-wrapper,
      :host ::ng-deep .osaa-key-form .clr-select-wrapper { width: 100%; }
      :host ::ng-deep .osaa-key-form input.clr-input,
      :host ::ng-deep .osaa-key-form select.clr-select { width: 100%; max-width: none; }
      .osaa-secret-control { min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.7rem; }
      .osaa-secret-input-shell { position: relative; width: 100%; }
      .osaa-secret-input-shell input.clr-input { width: 100%; max-width: none; min-height: 1.8rem; padding-right: 2.35rem; }
      .osaa-secret-control .clr-subtext { display: block; color: var(--os-muted); font-size: 0.875rem; line-height: 1.5; }
      .osaa-secret-toggle { position: absolute; z-index: 1; top: 50%; right: 0.12rem; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; width: 1.8rem; height: 1.65rem; padding: 0; border: 0; border-radius: 3px; background: #fff; color: #4f6475; cursor: pointer; }
      .osaa-secret-toggle:hover:not(:disabled) { background: #eef2f5; color: #1f66b3; }
      .osaa-secret-toggle:focus-visible { outline: 2px solid #2f7ed8; outline-offset: 1px; }
      .osaa-secret-toggle:disabled { color: #9baab5; cursor: not-allowed; opacity: 0.65; }
      .osaa-secret-toggle svg { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
      .osaa-validation-detail { margin-top: 0.25rem; color: var(--os-muted); font-family: var(--os-font-mono); font-size: 0.8125rem; overflow-wrap: anywhere; }
      :host ::ng-deep .osaa-key-form .clr-checkbox-wrapper { margin-top: 0.7rem; }
      :host ::ng-deep .osaa-key-form + .panel-actions { margin-top: 1rem; }
      .osaa-retention-form { --os-panel-form-max: 42rem; width: 100%; max-width: 42rem; }
      :host ::ng-deep .osaa-retention-form .clr-control-container,
      :host ::ng-deep .osaa-retention-form .clr-input-wrapper,
      :host ::ng-deep .osaa-retention-form .clr-select-wrapper { width: 100%; }
      :host ::ng-deep .osaa-retention-form input.clr-input,
      :host ::ng-deep .osaa-retention-form select.clr-select { width: 100%; max-width: none; }
      .exec-result { margin: 0.7rem 0 0; max-height: 16rem; overflow: auto; border: 1px solid #e1e5ea; border-radius: 4px; background: #0f2230; color: #d7e6ee; padding: 0.85rem; font-size: 0.875rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
      .r2d2-live { margin: 1.2rem 0; padding: 1.1rem; border: 1px solid #b7c8d6; border-radius: 8px; background: linear-gradient(180deg, #f8fbfd, #fff); }
      .r2d2-live .r2d2-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.8rem; }
      .r2d2-live .r2d2-section-heading h2 { margin: 0.15rem 0 0; font-size: 1.5rem; line-height: 1.35; }
      .r2d2-kicker { color: #1e638c; font-size: 0.8125rem; font-weight: 700; letter-spacing: 0.08em; }
      .r2d2-live-metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border: 1px solid #dce5eb; border-radius: 6px; background: #fff; }
      .r2d2-live-metrics article { display: grid; gap: 0.1rem; padding: 0.7rem; border-right: 1px solid #dce5eb; }
      .r2d2-live-metrics article:last-child { border-right: 0; }
      .r2d2-live-metrics span { color: #526b7d; font-size: 0.875rem; font-weight: 700; letter-spacing: 0.06em; }
      .r2d2-live-metrics strong { font-size: 1.375rem; color: #173b52; }
      .r2d2-live-metrics strong.danger { color: #b3261e; }
      .r2d2-live-metrics small { color: #526b7d; font-size: 0.875rem; overflow-wrap: anywhere; }
      .r2d2-live-grid { display: grid; grid-template-columns: minmax(0,1.08fr) minmax(0,.92fr); gap: 0.8rem; margin-top: 0.8rem; }
      .r2d2-live-panel { min-width: 0; padding: 0.8rem; border: 1px solid #dce5eb; border-radius: 6px; background: #fff; }
      .r2d2-live-panel h3 { margin: 0 0 0.45rem; color: #173b52; font-size: 1.125rem; }
      .r2d2-scroll-table { max-height: 20rem; overflow: auto; }
      .r2d2-scroll-table .table { margin: 0.45rem 0 0; font-size: 0.875rem; }
      .r2d2-authority-table { width: 100%; table-layout: fixed; font-size: 0.875rem; }
      .r2d2-authority-table th:nth-child(1) { width: 18%; }
      .r2d2-authority-table th:nth-child(2) { width: 17%; }
      .r2d2-authority-table th:nth-child(3) { width: 14%; }
      .r2d2-authority-table th:nth-child(4) { width: 25%; }
      .r2d2-authority-table th:nth-child(5) { width: 26%; }
      .r2d2-authority-table td { vertical-align: middle; overflow-wrap: anywhere; }
      .r2d2-authority-table th:nth-child(-n+4),.r2d2-authority-table td:nth-child(-n+4) { white-space: nowrap; }
      .r2d2-authority-table time { white-space: nowrap; font-variant-numeric: tabular-nums; }
      .r2d2-live-kv { display: grid; grid-template-columns: 10rem 1fr; margin: 0.5rem 0 0; font-size: 0.875rem; }
      .r2d2-live-kv dt,.r2d2-live-kv dd { margin: 0; padding: 0.35rem 0.4rem; border-bottom: 1px solid #edf1f3; }
      .r2d2-live-kv dt { color: #60798a; font-weight: 600; }
      .r2d2-empty { margin: 0.65rem 0 0; padding: 0.8rem; border: 1px dashed #b7c8d6; color: #425466; font-size: 1rem; }
      .r2d2-operation-panel { margin-top: 0.8rem; }
      .r2d2-operation-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
      .r2d2-row-action { margin: 0; padding: 0; min-width: 0; text-align: left; font-weight: 600; }
      .r2d2-detail { margin-top: 0.75rem; padding: 0.75rem; border: 1px solid var(--cds-alias-object-border-color, #d7d7d7); background: var(--cds-alias-object-container-background, #fff); }
      .r2d2-detail-head { display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
      .r2d2-operation-approval { margin-top: 0.6rem; padding: 0.55rem; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; background: var(--cds-alias-object-interaction-background, #f2f2f2); }
      .r2d2-operation-approval code { overflow-wrap: anywhere; }
      .r2d2-work-unit-paths { display: block; margin-top: 0.2rem; color: #60798a; line-height: 1.35; overflow-wrap: anywhere; }
      .r2d2-inline-state { color: #486574; font-weight: 600; font-size: 0.875rem; }
      .r2d2-detail ol { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.35rem; }
      .r2d2-detail li { display: grid; grid-template-columns: minmax(8rem, 0.7fr) minmax(10rem, 1fr) 2fr; gap: 0.75rem; align-items: baseline; font-size: 1rem; }
      @media (max-width: 1180px) { .r2d2-live-grid { grid-template-columns: 1fr; } }
      @media (max-width: 980px) { .stat-grid { grid-template-columns: 1fr 1fr; } }
      @media (max-width: 760px) {
        .r2d2-live-metrics,.r2d2-live-grid { grid-template-columns: 1fr; }
        .r2d2-live-metrics article { border-right: 0; border-bottom: 1px solid #dce5eb; }
        .osaa-key-form { grid-template-columns: 1fr; }
        .osaa-key-form .osaa-field-wide,
        .osaa-form-section { grid-column: 1; }
        .osaa-form-section { align-items: flex-start; flex-direction: column; gap: 0.1rem; }
        .osaa-capability-gaps { grid-template-columns: 1fr; }
        .osaa-capability-gaps span { border-right: 0; border-bottom: 1px solid var(--os-hairline); }
        .osaa-capability-gaps span:last-child { border-bottom: 0; }
      }
    `,
  ],
})
export class AdminOsaa implements OnInit, OnDestroy {
  private http = inject(HttpService);

  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);

  // Gateway health/readiness
  readonly health = signal<OsaaHealth | null>(null);
  readonly gatewayDown = signal<string>('');
  readonly healthBusy = signal(false);
  readonly dialogueModes: ReadonlyArray<{ value: DialogueMode; label: string; help: string }> = [
    { value: 'off', label: 'OFF', help: '안전 기본값' },
    { value: 'shadow', label: 'SHADOW', help: '기록만' },
    { value: 'read-enforce', label: 'READ', help: '현재 사실 적용' },
    { value: 'mutation-enforce', label: 'MUTATION', help: '변경 대화 적용' },
  ];
  readonly dialogueControl = signal<OsaaDialogueStateControl | null>(null);
  readonly selectedDialogueMode = signal<DialogueMode>('off');
  readonly dialogueControlBusy = signal(false);
  readonly dialogueControlError = signal('');
  readonly dialogueMode = computed(() => this.health()?.dialogueState?.mode || 'unknown');
  authoritySourceLabel(source: string): string {
    return /^(?:his|hiss)$/i.test(String(source || '').trim()) ? 'HISS' : String(source || '');
  }
  readonly dialogueModeDescription = computed(() => {
    switch (this.dialogueMode()) {
      case 'off': return '대화 상태 기록·문맥 projection·Owner 기반 현재 사실 강제가 모두 꺼져 있습니다. 일반 응답 경로의 안전 차단만 남아 있으므로 운영 질문이 구체적인 상태 조회로 연결되지 않을 수 있습니다.';
      case 'shadow': return '대화 상태 전이를 기록하고 비교하지만 사용자 응답과 현재 사실 판정에는 아직 강제하지 않습니다.';
      case 'read-enforce': return '대화 문맥과 Owner 기반 현재 사실 판정을 강제합니다. 변경 작업은 계속 별도 승인 경계에서 차단됩니다.';
      case 'mutation-enforce': return '현재 사실 판정과 승인된 변경 대화 계약을 모두 강제합니다. 실제 실행 권한은 OSCE와 각 Owner 정책이 다시 검증합니다.';
      default: return 'OSAA Gateway health를 아직 관측하지 못해 Dialogue State Tracker 적용 모드를 확인할 수 없습니다.';
    }
  });
  readonly controlPlaneStatus = signal<OsaaControlPlaneStatus | null>(null);
  readonly controlPlaneError = signal('');
  readonly engineeringStatus = signal<OsaaEngineeringStatus | null>(null);
  readonly engineeringStatusError = signal('');
  readonly engineeringRequests = signal<EngineeringRemediation[]>([]);
  readonly engineeringRequestsBusy = signal(false);
  readonly engineeringRequestError = signal('');
  readonly engineeringActionBusy = signal('');
  readonly operationalStatus = signal<R2d2OperationalStatus | null>(null);
  readonly graphNodes = signal<R2d2GraphNode[]>([]);
  readonly incidents = signal<R2d2Incident[]>([]);
  readonly operations = signal<R2d2Operation[]>([]);
  readonly metacognition = signal<R2d2Metacognition | null>(null);
  readonly selectedIncident = signal<R2d2IncidentDetail | null>(null);
  readonly selectedOperation = signal<R2d2OperationDetail | null>(null);
  readonly operationalBusy = signal(false);
  readonly operationApprovalBusy = signal(false);
  readonly operationalError = signal('');
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly browserVerificationAttempts = new Set<string>();
  private browserConsoleErrorCount = 0;
  private browserNetworkFailureCount = 0;
  private readonly onBrowserError = () => { this.browserConsoleErrorCount += 1; };
  private readonly onUnhandledRejection = () => { this.browserConsoleErrorCount += 1; };

  // LLM provider keys
  readonly llmKeys = signal<LlmKey[]>([]);
  readonly llmKeysLoaded = signal(false);
  readonly llmBusy = signal(false);
  readonly llmSaving = signal(false);
  readonly llmPanelOpen = signal(false);
  readonly llmEditingId = signal<string>('');
  readonly llmSecretVisible = signal(false);
  readonly llmTestingId = signal<string>('');
  llmForm: LlmKeyForm = this.emptyLlmForm();
  readonly deleteTarget = signal<LlmKey | null>(null);

  // Supabase append-only LLM usage ledger
  readonly usage = signal<LlmUsageDashboard | null>(null);
  readonly usageLoaded = signal(false);
  readonly usageBusy = signal(false);
  readonly usageError = signal('');
  usageRangeDays = 30;
  readonly usageGrassLevels = [0, 1, 2, 3, 4];
  readonly usageGrass = computed<LlmUsageGrass | null>(() => {
    const usage = this.usage();
    if (!usage) return null;

    const emptyMetric: LlmUsageMetric = {
      requests: 0, successfulRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0, successRate: 0, p95LatencyMs: null,
      estimatedCostUsd: null, pricedRequests: 0, unpricedRequests: 0,
    };
    const addDays = (date: Date, days: number) => new Date(date.getTime() + (days * 86_400_000));
    const dateKey = (date: Date) => date.toISOString().slice(0, 10);
    const parseDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
    const generatedDate = new Date(usage.generatedAt);
    const endDate = this.kstDateKey(Number.isFinite(generatedDate.getTime()) ? generatedDate : new Date());
    const safeRangeDays = Math.max(1, Math.floor(Number(usage.rangeDays) || 1));
    const startDate = dateKey(addDays(parseDate(endDate), -(safeRangeDays - 1)));
    const daily = new Map(usage.daily.map((day) => [day.date, day]));
    const activeRows = usage.daily.filter((day) => day.date >= startDate && day.date <= endDate && day.requests > 0);
    const peakRequests = Math.max(0, ...activeRows.map((day) => day.requests));

    const rangeStart = parseDate(startDate);
    const rangeEnd = parseDate(endDate);
    const gridStart = addDays(rangeStart, -rangeStart.getUTCDay());
    const gridEnd = addDays(rangeEnd, 6 - rangeEnd.getUTCDay());
    const weeks: LlmUsageGrassWeek[] = [];
    let previousMonth = '';

    for (let cursor = gridStart; cursor <= gridEnd; cursor = addDays(cursor, 7)) {
      const days: LlmUsageGrassDay[] = [];
      for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
        const currentDate = dateKey(addDays(cursor, dayOffset));
        const metric = daily.get(currentDate) || emptyMetric;
        const inRange = currentDate >= startDate && currentDate <= endDate;
        const requests = inRange ? metric.requests : 0;
        const level = requests <= 0 || peakRequests <= 0
          ? 0
          : Math.max(1, Math.min(4, Math.ceil((Math.log1p(requests) / Math.log1p(peakRequests)) * 4)));
        days.push({ ...metric, date: currentDate, inRange, level });
      }
      const firstVisible = days.find((day) => day.inRange);
      const monthStart = days.find((day) => day.inRange && day.date.endsWith('-01'));
      const visibleMonth = (monthStart || (weeks.length === 0 ? firstVisible : null))?.date.slice(0, 7) || '';
      const monthLabel = visibleMonth && visibleMonth !== previousMonth ? `${Number(visibleMonth.slice(5, 7))}월` : '';
      if (monthLabel) previousMonth = visibleMonth;
      weeks.push({ key: dateKey(cursor), monthLabel, days });
    }

    return { weeks, activeDays: activeRows.length, peakRequests, startDate, endDate };
  });

  // Digest-only agent/tool/retrieval/provider correlation and retention policy.
  readonly evidence = signal<AgentEvidenceDashboard | null>(null);
  readonly evidenceLoaded = signal(false);
  readonly evidenceBusy = signal(false);
  readonly evidenceError = signal('');
  readonly evidenceSaving = signal(false);
  readonly retentionPanelOpen = signal(false);
  evidenceRangeDays = 30;
  retentionForm: EvidenceRetentionForm = {
    stream: '', retentionDays: 365, disposition: 'retain', legalHold: false, reason: '', confirm: '',
  };

  // Knowledge / Manual Registry
  readonly knowledgeStats = signal<KnowledgeStats | null>(null);
  readonly knowledgeLoaded = signal(false);
  readonly knowledgeBusy = signal(false);
  readonly knowledgeError = signal<string>('');

  // Tool Registry / Action Bindings
  readonly toolManifest = signal<OsaaToolManifest | null>(null);
  readonly actionBindings = signal<OsaaActionBindingManifest | null>(null);
  readonly toolsLoaded = signal(false);
  readonly toolBusy = signal(false);

  // Action binding execution (mutation gate)
  readonly execBinding = signal<OsaaActionBinding | null>(null);
  execInputs: Record<string, string> = {};
  execConfirm = '';
  execReason = '';
  readonly execBusy = signal(false);
  readonly execResult = signal<string>('');
  readonly execError = signal<string>('');

  /** UI 게이트 — 단순 데이터 로드 성공만으로는 열리지 않는다. 서버가 명시적으로 보고하는
   *  health.mutationEnabled === true(CONSTITUTION-0004 §4.2 fail-closed 서버 상태)이면서, tool manifest와
   *  action binding 로드도 모두 성공했을 때만 true다. 이 값은 UI 편의 게이트일 뿐이며 실제 강제는 항상
   *  서버(executeActionBinding / restartDeployment / scaleDeployment)가 다시 독립적으로 수행한다. */
  readonly mutationGateOpen = computed<boolean>(
    () => !this.gatewayDown() && this.health()?.mutationEnabled === true && !!this.toolManifest() && !!this.actionBindings(),
  );

  /** health가 로드되지 않았거나 게이트가 닫혀 있을 때 화면에 보여줄 사람이 읽을 수 있는 gate reason. */
  readonly mutationGateReasonText = computed<string>(() => {
    const h = this.health();
    if (!h) return 'health 정보 없음';
    if (h.mutationEnabled === true) return '';
    return h.mutationGateReason || 'mutation_disabled_until_his_ready';
  });

  async ngOnInit(): Promise<void> {
    window.addEventListener('error', this.onBrowserError);
    window.addEventListener('unhandledrejection', this.onUnhandledRejection);
    await Promise.all([this.loadHealth(), this.loadDialogueControl()]);
    await Promise.all([this.loadOperationalIntelligence(), this.loadEngineeringStatus(), this.loadEngineeringRequests(), this.loadLlmKeys(), this.loadLlmUsage(), this.loadAgentEvidence(), this.loadKnowledgeStats(), this.loadToolManifest(), this.loadActionBindings()]);
    this.timer = setInterval(() => { void this.loadHealth(true); void this.loadDialogueControl(true); void this.loadOperationalIntelligence(true); void this.loadEngineeringStatus(); void this.loadEngineeringRequests(true); }, 15000);
  }

  async loadEngineeringStatus(): Promise<void> {
    try {
      const response = await this.http.request('/api/osaa/remediations/status', { cache: 'no-store' });
      const body = await response.json().catch(() => ({})) as OsaaEngineeringStatus & { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      this.engineeringStatus.set(body);
      this.engineeringStatusError.set('');
    } catch (error) {
      this.engineeringStatus.set(null);
      this.engineeringStatusError.set(`Repair Runner 상태 조회 실패: ${String(error)}`);
    }
  }

  async loadEngineeringRequests(silent = false): Promise<void> {
    if (this.engineeringRequestsBusy()) return;
    this.engineeringRequestsBusy.set(true);
    if (!silent) this.engineeringRequestError.set('');
    try {
      const response = await this.http.request('/api/osaa/remediations/', { cache: 'no-store' });
      const body = await response.json().catch(() => ({})) as { remediations?: EngineeringRemediation[]; error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const requests = Array.isArray(body.remediations) ? body.remediations : [];
      this.engineeringRequests.set(requests);
      this.engineeringRequestError.set('');
      window.setTimeout(() => { void this.verifyCurrentEngineeringRequest(requests); }, 300);
    } catch (error) {
      if (!silent) this.engineeringRequestError.set(`Engineering Remediation 조회 실패: ${String(error)}`);
    } finally {
      this.engineeringRequestsBusy.set(false);
    }
  }

  async approveEngineering(request: EngineeringRemediation): Promise<void> {
    if (request.stage !== 'proposed' || !this.engineeringStatus()?.workerReady || this.engineeringActionBusy()) return;
    this.engineeringActionBusy.set(request.remediationRequestId);
    try {
      const detailResponse = await this.http.request(`/api/osaa/remediations/${encodeURIComponent(request.remediationRequestId)}`, { cache: 'no-store' });
      const detail = await detailResponse.json().catch(() => ({})) as EngineeringRemediation & { error?: string };
      if (!detailResponse.ok) throw new Error(detail.error || `상세 조회 HTTP ${detailResponse.status}`);
      if (detail.stage !== 'proposed' || !detail.requiredConfirmation) throw new Error('이 작업은 더 이상 승인 대기 상태가 아닙니다.');
      const response = await this.http.request(`/api/osaa/remediations/${encodeURIComponent(request.remediationRequestId)}/approvals/source`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: detail.requiredConfirmation }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `승인 HTTP ${response.status}`);
      this.msg.set({ type: 'success', text: '정확히 표시된 OSAA 작업을 승인했습니다. Repair Runner가 test · component-only 배포 · 화면 검증을 계속합니다.' });
      await Promise.all([this.loadEngineeringStatus(), this.loadEngineeringRequests(true), this.loadOperationalIntelligence(true)]);
    } catch (error) {
      this.msg.set({ type: 'danger', text: `Engineering Remediation 승인 실패: ${String(error)}` });
    } finally {
      this.engineeringActionBusy.set('');
    }
  }

  private async verifyCurrentEngineeringRequest(requests: EngineeringRemediation[]): Promise<void> {
    const request = requests.find((item) => item.stage === 'verifying'
      && item.verificationProfile === 'osaa-admin' && item.verificationRoute === '/manage/osaa');
    if (!request || window.location.pathname !== request.verificationRoute
      || this.browserVerificationAttempts.has(request.remediationRequestId)) return;

    const url = new URL(window.location.href);
    if (url.searchParams.get('osaa_verify') !== request.remediationRequestId) {
      url.searchParams.set('osaa_verify', request.remediationRequestId);
      window.history.replaceState(null, '', url);
      window.location.reload();
      return;
    }

    this.browserVerificationAttempts.add(request.remediationRequestId);
    try {
      const releaseResponse = await this.http.request('/api/platform/releases/status', { cache: 'no-store' });
      const release = await releaseResponse.json().catch(() => ({})) as {
        current?: { components?: Record<string, { sourceRevision?: string }> }; error?: string;
      };
      if (!releaseResponse.ok) {
        this.browserNetworkFailureCount += 1;
        throw new Error(release.error || `Platform Release HTTP ${releaseResponse.status}`);
      }
      const components = release.current?.components || {};
      const affected = request.affectedComponents.length ? request.affectedComponents : ['console'];
      const observedRevisions = [...new Set(affected.map((component) => String(components[component]?.sourceRevision || '')))].filter(Boolean);
      if (observedRevisions.length !== 1 || !/^[0-9a-f]{40}$/.test(observedRevisions[0])) {
        throw new Error(`영향 component(${affected.join(', ')})의 동일한 exact source revision을 확인할 수 없습니다.`);
      }
      const observedSourceRevision = observedRevisions[0];
      const response = await this.http.request(`/api/osaa/remediations/${encodeURIComponent(request.remediationRequestId)}/browser-verifications`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          verificationProfile: 'osaa-admin', verificationRoute: '/manage/osaa',
          observedSourceRevision, marker: 'os-admin-osaa',
          markerPresent: document.querySelector('os-admin-osaa') !== null,
          consoleErrorCount: this.browserConsoleErrorCount,
          networkFailureCount: this.browserNetworkFailureCount,
        }),
      });
      const body = await response.json().catch(() => ({})) as { accepted?: boolean; passed?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || `화면 검증 HTTP ${response.status}`);
      url.searchParams.delete('osaa_verify');
      window.history.replaceState(null, '', url);
      this.msg.set({ type: body.passed ? 'success' : 'danger', text: body.passed
        ? '배포된 OSAA 화면의 exact revision과 marker를 확인했습니다.'
        : 'OSAA 화면 postcondition이 실패했습니다. Repair Runner가 rollback 판정을 계속합니다.' });
      await this.loadEngineeringRequests(true);
    } catch (error) {
      this.browserVerificationAttempts.delete(request.remediationRequestId);
      this.engineeringRequestError.set(`OSAA 화면 검증 실패: ${String(error)}`);
    }
  }

  engineeringStageLabel(stage: string): string {
    const labels: Record<string, string> = {
      proposed: '승인 대기', approved: '승인됨', sandboxed: '격리 완료', patched: '패치 적용', testing: '테스트 중',
      ready_to_commit: '커밋 준비', committed: '커밋됨', building: '빌드 중', built: '빌드 완료', deploying: '배포 중',
      verifying: '화면 검증', succeeded: '완료', rolling_back: '복구 중', rolled_back: '복구 완료', failed: '실패',
      test_failed: '테스트 실패', build_failed: '빌드 실패', cancelled: '취소됨',
    };
    return labels[stage] || stage;
  }

  engineeringStageAction(stage: string): string {
    if (this.isEngineeringSuccess(stage)) return stage === 'succeeded' ? '검증 완료' : '원상 복구 확인';
    if (this.isEngineeringFailure(stage)) return '실패 증거 확인 필요';
    return 'Repair Runner 처리 중';
  }

  isEngineeringSuccess(stage: string): boolean { return ['succeeded', 'rolled_back'].includes(stage); }
  isEngineeringFailure(stage: string): boolean { return ['failed', 'test_failed', 'build_failed', 'cancelled'].includes(stage); }
  isEngineeringRunning(stage: string): boolean {
    return !['proposed', 'verifying', 'succeeded', 'rolled_back', 'failed', 'test_failed', 'build_failed', 'cancelled'].includes(stage);
  }
  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    window.removeEventListener('error', this.onBrowserError);
    window.removeEventListener('unhandledrejection', this.onUnhandledRejection);
  }

  async loadHealth(silent = false): Promise<void> {
    if (!silent) this.healthBusy.set(true);
    try {
      const r = await this.http.request('/api/osaa/health', { cache: 'no-store' });
      if (!r.ok) {
        this.gatewayDown.set(`health HTTP ${r.status}`);
        this.health.set(null);
        return;
      }
      this.gatewayDown.set('');
      this.health.set(await r.json());
      if (!silent) await this.loadControlPlaneStatus();
    } catch (e) {
      this.gatewayDown.set('조회 실패: ' + e);
      this.health.set(null);
    } finally {
      this.healthBusy.set(false);
    }
  }

  selectDialogueMode(mode: DialogueMode): void {
    if (!this.dialogueControlBusy()) this.selectedDialogueMode.set(mode);
  }

  async loadDialogueControl(silent = false): Promise<void> {
    try {
      const response = await this.http.request('/api/osaa/admin/dialogue-state', { cache: 'no-store' });
      const body = await response.json().catch(() => ({})) as OsaaDialogueStateControl & { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      this.dialogueControl.set(body);
      if (!this.dialogueControlBusy()) this.selectedDialogueMode.set(body.mode);
      this.dialogueControlError.set('');
    } catch (error) {
      if (!silent) this.dialogueControlError.set(`모드 제어 조회 실패: ${String(error)}`);
    }
  }

  async applyDialogueMode(): Promise<void> {
    if (this.dialogueControlBusy()) return;
    const target = this.selectedDialogueMode();
    this.dialogueControlBusy.set(true);
    this.dialogueControlError.set('');
    try {
      const response = await this.http.request('/api/osaa/admin/dialogue-state', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: target, reason: `관리자 OSAA Dialogue State Tracker 모드 변경: ${target}` }),
      });
      const body = await response.json().catch(() => ({})) as OsaaDialogueStateControl & { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      this.dialogueControl.set(body);
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        await Promise.all([this.loadDialogueControl(true), this.loadHealth(true)]);
        if (this.dialogueControl()?.rollout.ready && this.dialogueMode() === target) break;
      }
      if (!this.dialogueControl()?.rollout.ready || this.dialogueMode() !== target) {
        throw new Error('Gateway 전환이 제한 시간 안에 완료되지 않았습니다. 상태를 다시 확인하십시오.');
      }
      this.msg.set({ type: 'success', text: `OSAA Dialogue State Tracker를 ${target} 모드로 적용했습니다.` });
    } catch (error) {
      this.dialogueControlError.set(String(error));
      this.msg.set({ type: 'danger', text: `Dialogue State Tracker 모드 변경 실패: ${String(error)}` });
    } finally {
      this.dialogueControlBusy.set(false);
      await this.loadDialogueControl(true);
    }
  }

  private async loadControlPlaneStatus(): Promise<void> {
    try {
      const response = await this.http.request('/api/osaa/tools/control-plane/status', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        this.controlPlaneStatus.set(null);
        this.controlPlaneError.set(body.error || `HTTP ${response.status}`);
        return;
      }
      this.controlPlaneStatus.set(await response.json() as OsaaControlPlaneStatus);
      this.controlPlaneError.set('');
    } catch (error) {
      this.controlPlaneStatus.set(null);
      this.controlPlaneError.set(String(error));
    }
  }

  async loadOperationalIntelligence(silent = false): Promise<void> {
    if (!silent) this.operationalBusy.set(true);
    try {
      const [statusResponse, graphResponse, incidentResponse, operationResponse, metacognitionResponse] = await Promise.all([
        this.http.request('/api/osaa/operational/status', { cache: 'no-store' }),
        this.http.request('/api/osaa/graph/nodes?limit=250', { cache: 'no-store' }),
        this.http.request('/api/osaa/incidents?limit=100', { cache: 'no-store' }),
        this.http.request('/api/osaa/operations', { cache: 'no-store' }),
        this.http.request('/api/osaa/metacognition?limit=100', { cache: 'no-store' }),
      ]);
      if (!statusResponse.ok) {
        const body = await statusResponse.json().catch(() => ({})) as { error?: string; code?: string };
        this.operationalStatus.set(null); this.graphNodes.set([]); this.incidents.set([]);
        this.operationalError.set(body.error || `Operational Intelligence HTTP ${statusResponse.status}`);
      } else {
        this.operationalStatus.set(await statusResponse.json() as R2d2OperationalStatus);
        this.operationalError.set('');
        if (graphResponse.ok) this.graphNodes.set(((await graphResponse.json()) as { nodes?: R2d2GraphNode[] }).nodes || []);
        if (incidentResponse.ok) this.incidents.set(((await incidentResponse.json()) as { incidents?: R2d2Incident[] }).incidents || []);
      }
      if (operationResponse.ok) this.operations.set(((await operationResponse.json()) as { operations?: R2d2Operation[] }).operations || []);
      if (metacognitionResponse.ok) this.metacognition.set(await metacognitionResponse.json() as R2d2Metacognition);
    } catch (error) {
      if (!silent) this.operationalError.set(`Operational Intelligence 조회 실패: ${error}`);
    } finally { this.operationalBusy.set(false); }
  }

  async loadIncidentDetail(id: string): Promise<void> {
    const response = await this.http.request(`/api/osaa/incidents/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (response.ok) this.selectedIncident.set(await response.json() as R2d2IncidentDetail);
  }

  async loadOperationDetail(id: string): Promise<void> {
    const response = await this.http.request(`/api/osaa/operations/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (response.ok) this.selectedOperation.set(await response.json() as R2d2OperationDetail);
  }

  async approveOperation(operation: R2d2OperationDetail): Promise<void> {
    const expected = operation.approvalConfirmation || '';
    if (!expected) return;
    const confirmation = window.prompt(`아래 승인 문구를 정확히 입력하십시오.\n\n${expected}`, '');
    if (confirmation === null) return;
    this.operationApprovalBusy.set(true);
    try {
      const response = await this.http.request(`/api/osaa/operations/${encodeURIComponent(operation.operationId)}/approvals`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `승인 HTTP ${response.status}`);
      this.msg.set({ type: 'success', text: `R2D2 operation ${this.shortId(operation.operationId)} 승인 증거를 기록했습니다.` });
      await Promise.all([this.loadOperationDetail(operation.operationId), this.loadOperationalIntelligence(true)]);
    } catch (error) {
      this.msg.set({ type: 'danger', text: `R2D2 operation 승인 실패: ${error}` });
    } finally { this.operationApprovalBusy.set(false); }
  }

  // ---------- LLM provider keys ----------
  private emptyLlmForm(): LlmKeyForm {
    return {
      id: 'openai-main', provider: 'openai', displayName: '', apiKey: '',
      baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1', embeddingModel: 'text-embedding-3-large',
      enabled: true, reason: '',
    };
  }
  ensureLlmKeysLoaded(): void {
    if (!this.llmKeysLoaded()) void this.loadLlmKeys();
  }
  openCreateKey(): void {
    this.llmEditingId.set('');
    this.llmSecretVisible.set(false);
    this.llmForm = this.emptyLlmForm();
    this.llmPanelOpen.set(true);
  }
  openRotateKey(k: LlmKey): void {
    this.llmEditingId.set(k.id);
    this.llmSecretVisible.set(false);
    this.llmForm = {
      id: k.id, provider: k.provider || 'custom', displayName: k.displayName || '', apiKey: '',
      baseUrl: k.baseUrl || '', defaultModel: k.defaultModel || '', embeddingModel: k.embeddingModel || '',
      enabled: k.enabled, reason: '',
    };
    this.llmPanelOpen.set(true);
  }
  closeKeyPanel(): void {
    this.llmPanelOpen.set(false);
    this.llmEditingId.set('');
    this.llmSecretVisible.set(false);
    // apiKey는 패널을 닫을 때(성공/취소 모두) 즉시 비운다 — raw key 잔존 방지.
    this.llmForm = this.emptyLlmForm();
  }
  toggleLlmSecretVisibility(): void {
    if (this.llmSaving() || !this.llmForm.apiKey) return;
    this.llmSecretVisible.update((visible) => !visible);
  }
  onLlmApiKeyChange(value: string): void {
    if (!String(value || '')) this.llmSecretVisible.set(false);
  }
  onLlmProviderChange(provider: string): void {
    if (this.llmEditingId()) return;
    const normalized = String(provider || 'custom')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'custom';
    const defaults = ({
      openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1', embeddingModel: 'text-embedding-3-large' },
      deepseek: { baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash', embeddingModel: '' },
      anthropic: { baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-20250514', embeddingModel: '' },
      google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-pro', embeddingModel: '' },
      custom: { baseUrl: '', defaultModel: '', embeddingModel: '' },
    } as Record<string, Pick<LlmKeyForm, 'baseUrl' | 'defaultModel' | 'embeddingModel'>>)[normalized]
      || { baseUrl: '', defaultModel: '', embeddingModel: '' };
    this.llmForm = {
      ...this.llmForm,
      ...defaults,
      provider,
      id: `${normalized}-main`.slice(0, 48).replace(/-+$/g, ''),
    };
  }
  llmValidationLabel(status: string): string {
    return ({
      ready: 'Ready',
      invalid: 'Invalid key',
      'invalid-config': 'Invalid config',
      'model-missing': 'Model unavailable',
      'embedding-unavailable': 'Embedding unavailable',
      'embedding-invalid': 'Embedding invalid',
      unreachable: 'Unreachable',
      degraded: 'Rate limited',
      'provider-error': 'Provider error',
      unsupported: 'Unsupported',
      disabled: 'Disabled',
      untested: 'Not tested',
    } as Record<string, string>)[status] || status || 'Not tested';
  }
  async loadLlmKeys(): Promise<void> {
    this.llmBusy.set(true);
    this.msg.set(null);
    try {
      const r = await this.http.request('/api/osaa/admin/llm-keys', { cache: 'no-store' });
      this.llmKeysLoaded.set(true);
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.msg.set({ type: 'danger', text: accessError });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `LLM key load failed (HTTP ${r.status})` });
        return;
      }
      this.llmKeys.set((await r.json()).items || []);
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'LLM key load failed: ' + e });
    } finally {
      this.llmBusy.set(false);
    }
  }
  async saveLlmKey(): Promise<void> {
    if (!this.llmForm.id.trim() || this.llmForm.reason.trim().length < 8 || (!this.llmEditingId() && !this.llmForm.apiKey.trim())) {
      this.msg.set({ type: 'danger', text: 'ID, 8자 이상의 변경 사유, 신규 key의 API key가 필요합니다.' });
      return;
    }
    this.llmSaving.set(true);
    try {
      const r = await this.http.request('/api/osaa/admin/llm-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.llmForm),
      });
      const out = await r.json().catch(() => ({}) as any);
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.msg.set({ type: 'danger', text: accessError });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: out.error || `LLM key save failed (HTTP ${r.status})` });
        return;
      }
      this.closeKeyPanel();
      await this.loadLlmKeys();
      const validationStatus = String(out.validation?.status || out.item?.validationStatus || 'untested');
      const validationText = this.llmValidationLabel(validationStatus);
      const latency = Number(out.validation?.latencyMs || out.item?.validationLatencyMs || 0);
      this.msg.set({
        type: validationStatus === 'ready' ? 'success' : 'danger',
        text: `${out.created ? 'LLM key 저장' : 'LLM key 회전'} 완료 · Provider 검증: ${validationText}${latency ? ` (${latency}ms)` : ''}`,
      });
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'LLM key save failed: ' + e });
    } finally {
      // 성공/실패 어느 경로든 secret 입력값을 즉시 비운다(방어적 이중 처리).
      this.llmSecretVisible.set(false);
      this.llmForm = { ...this.llmForm, apiKey: '' };
      this.llmSaving.set(false);
    }
  }
  openDeleteKey(k: LlmKey): void {
    this.deleteTarget.set(k);
  }
  cancelDeleteKey(): void {
    this.deleteTarget.set(null);
  }
  async confirmDeleteKey(reason: string): Promise<void> {
    const k = this.deleteTarget();
    if (!k) return;
    this.llmBusy.set(true);
    try {
      const r = await this.http.request(
        `/api/osaa/admin/llm-keys/${encodeURIComponent(k.id)}?reason=${encodeURIComponent(reason)}`,
        { method: 'DELETE' },
      );
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.msg.set({ type: 'danger', text: accessError });
        return;
      }
      if (!r.ok) {
        const out = await r.json().catch(() => ({}) as any);
        this.msg.set({ type: 'danger', text: out.error || `LLM key delete failed (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: `LLM key ${k.id} deleted.` });
      this.deleteTarget.set(null);
      await this.loadLlmKeys();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'LLM key delete failed: ' + e });
    } finally {
      this.llmBusy.set(false);
    }
  }

  // ---------- Supabase LLM usage ledger ----------
  ensureUsageLoaded(): void {
    if (!this.usageLoaded()) void this.loadLlmUsage();
  }
  setUsageRange(days: number): void {
    if (![1, 7, 30, 90, 365].includes(days) || this.usageRangeDays === days) return;
    this.usageRangeDays = days;
    void this.loadLlmUsage();
  }
  async loadLlmUsage(): Promise<void> {
    this.usageBusy.set(true);
    this.usageError.set('');
    try {
      const r = await this.http.request(`/api/osaa/admin/usage?days=${this.usageRangeDays}`, { cache: 'no-store' });
      this.usageLoaded.set(true);
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.usageError.set(accessError);
        return;
      }
      if (!r.ok) {
        const out = await r.json().catch(() => ({}) as any);
        this.usageError.set(out.error || `LLM usage load failed (HTTP ${r.status})`);
        return;
      }
      this.usage.set(await r.json());
    } catch (e) {
      this.usageError.set('LLM usage load failed: ' + e);
    } finally {
      this.usageBusy.set(false);
    }
  }
  usageKey(keyId: string): LlmUsageKey | null {
    return this.usage()?.byKey.find((item) => item.keyId === keyId) || null;
  }
  llmKeyLabel(keyId: string): string {
    const key = this.llmKeys().find((item) => item.id === keyId);
    return key?.displayName || keyId;
  }
  formatTokenCount(value: number): string {
    return new Intl.NumberFormat('ko-KR').format(Math.max(0, Number(value) || 0));
  }
  formatCompactTokens(value: number): string {
    const amount = Math.max(0, Number(value) || 0);
    return new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(amount);
  }
  formatSuccessRate(value: number): string {
    return `${Math.max(0, Math.min(100, Number(value) || 0)).toFixed(1)}%`;
  }
  formatDateTime(value: string): string {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR', { hour12: false }) : value;
  }
  formatCompactDateTime(value: string): string {
    if (!value) return '-';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date);
  }
  shortDate(value: string): string {
    const parts = String(value || '').split('-');
    return parts.length === 3 ? `${parts[1]}.${parts[2]}` : value;
  }
  kstDateKey(value: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  usageGrassDayLabel(day: LlmUsageGrassDay): string {
    const date = new Date(`${day.date}T00:00:00.000Z`);
    const dateLabel = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
    }).format(date);
    if (!day.requests) return `${dateLabel} · 사용 없음`;
    return `${dateLabel} · ${this.formatTokenCount(day.requests)} requests · ${this.formatTokenCount(day.totalTokens)} tokens · 성공 ${this.formatSuccessRate(day.successRate)}`;
  }
  usageCostLabel(metric: LlmUsageMetric): string {
    if (!metric.pricedRequests || metric.estimatedCostUsd == null) return '미산정';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(metric.estimatedCostUsd);
  }
  usageCostCoverage(metric: LlmUsageMetric): string {
    if (!metric.requests) return '사용 기록 없음';
    if (!metric.pricedRequests) return 'Provider 가격 정책 미설정';
    return `${metric.pricedRequests}/${metric.requests} requests priced`;
  }

  // ---------- Correlated agent evidence ----------
  ensureEvidenceLoaded(): void {
    if (!this.evidenceLoaded()) void this.loadAgentEvidence();
  }
  setEvidenceRange(days: number): void {
    if (![1, 7, 30, 90, 365].includes(days) || this.evidenceRangeDays === days) return;
    this.evidenceRangeDays = days;
    void this.loadAgentEvidence();
  }
  async loadAgentEvidence(): Promise<void> {
    this.evidenceBusy.set(true);
    this.evidenceError.set('');
    try {
      const r = await this.http.request(`/api/osaa/admin/evidence?days=${this.evidenceRangeDays}&limit=25`, { cache: 'no-store' });
      this.evidenceLoaded.set(true);
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.evidenceError.set(accessError);
        return;
      }
      if (!r.ok) {
        const out = await r.json().catch(() => ({}) as any);
        this.evidenceError.set(out.error || `Agent evidence load failed (HTTP ${r.status})`);
        return;
      }
      this.evidence.set(await r.json());
    } catch (e) {
      this.evidenceError.set('Agent evidence load failed: ' + e);
    } finally {
      this.evidenceBusy.set(false);
    }
  }
  shortId(value: string): string {
    const text = String(value || '');
    return text.length > 12 ? `${text.slice(0, 8)}…` : text;
  }
  openRetentionPolicy(policy: EvidenceRetentionPolicy): void {
    this.retentionForm = {
      stream: policy.stream,
      retentionDays: policy.retentionDays,
      disposition: policy.disposition,
      legalHold: policy.legalHold,
      reason: '',
      confirm: '',
    };
    this.retentionPanelOpen.set(true);
  }
  closeRetentionPolicy(): void {
    if (this.evidenceSaving()) return;
    this.retentionPanelOpen.set(false);
    this.retentionForm = { stream: '', retentionDays: 365, disposition: 'retain', legalHold: false, reason: '', confirm: '' };
  }
  expectedRetentionConfirm(): string {
    return this.retentionForm.stream
      ? `update R2D2 evidence retention ${this.retentionForm.stream} to ${Number(this.retentionForm.retentionDays) || 0} days`
      : '';
  }
  canSaveRetentionPolicy(): boolean {
    const days = Number(this.retentionForm.retentionDays);
    return this.mutationGateOpen() && !this.evidenceSaving() && !!this.retentionForm.stream
      && Number.isInteger(days) && days >= 30 && days <= 3650
      && this.retentionForm.reason.trim().length >= 8
      && this.retentionForm.confirm.trim() === this.expectedRetentionConfirm();
  }
  async saveRetentionPolicy(): Promise<void> {
    if (!this.canSaveRetentionPolicy()) return;
    this.evidenceSaving.set(true);
    try {
      const r = await this.http.request('/api/osaa/admin/evidence/retention', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...this.retentionForm,
          retentionDays: Number(this.retentionForm.retentionDays),
          // `osaa` remains the server-side compatibility identifier; only the official display name is R2D2.
          confirm: this.retentionForm.confirm.replace(/^update R2D2 evidence retention /, 'update OSAA evidence retention '),
        }),
      });
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.msg.set({ type: 'danger', text: accessError });
        return;
      }
      if (!r.ok) {
        const out = await r.json().catch(() => ({}) as any);
        this.msg.set({ type: 'danger', text: out.error || `Evidence retention update failed (HTTP ${r.status})` });
        return;
      }
      const result = await r.json();
      this.msg.set({ type: 'success', text: `${result.policy?.stream || this.retentionForm.stream} 보존 정책을 저장했습니다. 증거 삭제는 수행되지 않았습니다.` });
      this.evidenceSaving.set(false);
      this.closeRetentionPolicy();
      await this.loadAgentEvidence();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Evidence retention update failed: ' + e });
    } finally {
      this.evidenceSaving.set(false);
    }
  }

  // ---------- Knowledge / Manual Registry ----------
  ensureKnowledgeLoaded(): void {
    if (!this.knowledgeLoaded()) void this.loadKnowledgeStats();
  }
  async loadKnowledgeStats(): Promise<void> {
    this.knowledgeBusy.set(true);
    this.knowledgeError.set('');
    try {
      const r = await this.http.request('/api/osaa/admin/knowledge/stats', { cache: 'no-store' });
      this.knowledgeLoaded.set(true);
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.knowledgeError.set(accessError);
        return;
      }
      if (!r.ok) {
        this.knowledgeError.set(`Knowledge stats load failed (HTTP ${r.status})`);
        return;
      }
      this.knowledgeStats.set(await r.json());
    } catch (e) {
      this.knowledgeError.set('Knowledge stats load failed: ' + e);
    } finally {
      this.knowledgeBusy.set(false);
    }
  }
  async seedBundledManuals(): Promise<void> {
    await this.knowledgeAction('/api/osaa/admin/knowledge/manual-seed/bundled', {}, 'Bundled manuals seeded.');
  }
  async reembedKnowledge(): Promise<void> {
    await this.knowledgeAction('/api/osaa/admin/knowledge/reembed', { strict: false }, 'Knowledge re-embedded.');
  }
  private async knowledgeAction(url: string, body: unknown, success: string): Promise<void> {
    this.knowledgeBusy.set(true);
    try {
      const r = await this.http.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.msg.set({ type: 'danger', text: accessError });
        return;
      }
      if (!r.ok) {
        const out = await r.json().catch(() => ({}) as any);
        this.msg.set({ type: 'danger', text: out.error || `Knowledge operation failed (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: success });
      await this.loadKnowledgeStats();
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Knowledge operation failed: ' + e });
    } finally {
      this.knowledgeBusy.set(false);
    }
  }
  async testLlmKey(k: LlmKey): Promise<void> {
    if (this.llmTestingId()) return;
    this.llmTestingId.set(k.id);
    this.msg.set(null);
    try {
      const r = await this.http.request(`/api/osaa/admin/llm-keys/${encodeURIComponent(k.id)}/test`, { method: 'POST' });
      const out = await r.json().catch(() => ({}) as any);
      const accessError = this.adminAccessMessage(r.status);
      if (accessError) {
        this.msg.set({ type: 'danger', text: accessError });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: out.error || `LLM key validation failed (HTTP ${r.status})` });
        return;
      }
      await this.loadLlmKeys();
      const status = String(out.validation?.status || 'untested');
      const latency = Number(out.validation?.latencyMs || 0);
      this.msg.set({
        type: status === 'ready' ? 'success' : 'danger',
        text: `Provider 검증: ${this.llmValidationLabel(status)}${latency ? ` (${latency}ms)` : ''} · ${out.validation?.message || ''}`,
      });
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'LLM key validation failed: ' + e });
    } finally {
      this.llmTestingId.set('');
    }
  }

  private adminAccessMessage(status: number): string {
    if (status === 401) return 'R2D2가 현재 로그인 세션을 확인하지 못했습니다. 세션을 갱신한 뒤 다시 시도하세요.';
    if (status === 403) return 'R2D2 관리자 역할(console-admins)이 필요합니다.';
    return '';
  }

  // ---------- Tool Registry / Action Bindings ----------
  ensureToolsLoaded(): void {
    if (!this.toolsLoaded()) {
      this.toolsLoaded.set(true);
      void this.loadToolManifest();
      void this.loadActionBindings();
    }
  }
  async loadToolManifest(): Promise<void> {
    this.toolBusy.set(true);
    try {
      const r = await this.http.request('/api/osaa/tools/manifest', { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'R2D2 permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `Tool manifest load failed (HTTP ${r.status})` });
        return;
      }
      this.toolManifest.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Tool manifest load failed: ' + e });
    } finally {
      this.toolBusy.set(false);
    }
  }
  async loadActionBindings(): Promise<void> {
    this.toolBusy.set(true);
    try {
      const r = await this.http.request('/api/osaa/tools/action-bindings', { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'R2D2 permission is required.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `Action bindings load failed (HTTP ${r.status})` });
        return;
      }
      this.actionBindings.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: 'Action bindings load failed: ' + e });
    } finally {
      this.toolBusy.set(false);
    }
  }

  // ---------- Execute action binding (mutation gate) ----------
  execFieldKeys(b: OsaaActionBinding): string[] {
    return Object.keys(b.requiredInputs?.fields || {}).filter((key) => key !== 'confirm' && key !== 'reason');
  }
  openExecute(b: OsaaActionBinding): void {
    if (b.valid === false) return;
    const inputs: Record<string, string> = {};
    for (const key of this.execFieldKeys(b)) {
      if (key === 'namespace') inputs[key] = b.targetHints?.namespace || '';
      else if (key === 'name' || key === 'deployment') inputs[key] = b.targetHints?.deployment || '';
      else inputs[key] = '';
    }
    this.execInputs = inputs;
    this.execConfirm = '';
    this.execReason = '';
    this.execResult.set('');
    this.execError.set('');
    this.execBinding.set(b);
  }
  closeExecute(): void {
    this.execBinding.set(null);
    this.execInputs = {};
    this.execConfirm = '';
    this.execReason = '';
    this.execResult.set('');
    this.execError.set('');
  }
  /** 서버(bindingConfirmationExpected)와 동일한 치환 규칙을 클라이언트에서 미리 계산해 안내용으로 보여준다.
   *  최종 검증은 항상 서버가 다시 수행한다 — 이 값은 UI 안내일 뿐이다. */
  expectedConfirmText(): string {
    const b = this.execBinding();
    if (!b || b.confirmation === 'none') return '';
    let expected = b.confirmationTemplate || `execute binding ${b.id}`;
    const namespace = this.execInputs['namespace'] || b.targetHints?.namespace || '';
    const deployment = this.execInputs['name'] || this.execInputs['deployment'] || b.targetHints?.deployment || '';
    const replicas = this.execInputs['replicas'] ?? '';
    const action = (this.execInputs['action'] || '').toLowerCase();
    const revisionSuffix = action === 'rollback' ? ` to revision ${this.execInputs['revision'] || ''}` : '';
    expected = expected
      .replace(/<namespace>/g, namespace)
      .replace(/<deployment>/g, deployment)
      .replace(/<replicas>/g, String(replicas))
      .replace(/<kind>/g, (this.execInputs['kind'] || '').toLowerCase())
      .replace(/<name>/g, this.execInputs['name'] || '')
      .replace(/<container>/g, this.execInputs['container'] || '')
      .replace(/<image>/g, this.execInputs['image'] || '')
      .replace(/<suspend>/g, this.execInputs['suspend'] || '')
      .replace(/<id>/g, this.execInputs['id'] || '')
      .replace(/<action>/g, action)
      .replace(/<revision>/g, this.execInputs['revision'] || '')
      .replace(/<revisionSuffix>/g, revisionSuffix)
      .replace(/<username>/g, this.execInputs['username'] || '')
      .replace(/<userId>/g, this.execInputs['userId'] || '')
      .replace(/<role>/g, this.execInputs['role'] || '')
      .replace(/<operation>/g, (this.execInputs['operation'] || '').toLowerCase())
      .replace(/<verb>/g, this.execInputs['enabled'] === 'true' ? 'enable' : (this.execInputs['enabled'] === 'false' ? 'disable' : ''))
      .replace(/<stream>/g, this.execInputs['stream'] || '')
      .replace(/<retentionDays>/g, this.execInputs['retentionDays'] || '');
    return expected.trim();
  }
  /** 실행 버튼 활성화 게이트 — exact confirmation string + reason이 모두 충족되고,
   *  mutation(비-read) 바인딩이면 mutationGateOpen()도 열려 있어야 한다. */
  canSubmitExecute(): boolean {
    const b = this.execBinding();
    if (!b || this.execBusy()) return false;
    if (b.riskLevel !== 'read' && !this.mutationGateOpen()) return false;
    if (!this.execReason.trim()) return false;
    if (b.confirmation !== 'none') {
      const expected = this.expectedConfirmText();
      if (!expected || this.execConfirm.trim() !== expected) return false;
    }
    return true;
  }
  private buildExecuteInputs(b: OsaaActionBinding): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const tool = this.toolManifest()?.tools.find((item) => item.id === b.toolId);
    for (const key of this.execFieldKeys(b)) {
      const raw = (this.execInputs[key] ?? '').trim();
      if (!raw) continue;
      const type = tool?.inputSchema?.properties?.[key]?.type;
      if (type === 'integer' || type === 'number' || ['replicas', 'limit', 'revision', 'retentionDays'].includes(key)) out[key] = Number(raw);
      else if (type === 'boolean' || ['enabled', 'suspend', 'legalHold'].includes(key)) out[key] = raw.toLowerCase() === 'true';
      else if (type === 'array' || key === 'roles') out[key] = raw.split(',').map((value) => value.trim()).filter(Boolean);
      else if (type === 'object' || key === 'manifest') {
        try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
      } else out[key] = raw;
    }
    return out;
  }
  async executeBinding(): Promise<void> {
    const b = this.execBinding();
    // 미충족(게이트 닫힘 / confirmation 불일치 / 사유 없음) 상태에서는 절대 fetch하지 않는다.
    if (!b || !this.canSubmitExecute()) return;
    this.execBusy.set(true);
    this.execError.set('');
    try {
      const body = {
        bindingId: b.id,
        inputs: this.buildExecuteInputs(b),
        confirm: b.confirmation === 'none' ? '' : this.execConfirm.trim(),
        reason: this.execReason.trim(),
      };
      const r = await this.http.request('/api/osaa/actions/bindings/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}) as any);
      if (r.status === 401 || r.status === 403) {
        this.execError.set(out.error || 'Admin permission is required for this action.');
        return;
      }
      if (!r.ok) {
        this.execError.set(out.error || `Execution failed (HTTP ${r.status})`);
        return;
      }
      this.execResult.set(out.message || JSON.stringify(out, null, 2));
      this.msg.set({ type: 'success', text: `Binding executed: ${b.id}` });
    } catch (e) {
      this.execError.set('Execution failed: ' + e);
    } finally {
      this.execBusy.set(false);
    }
  }
}
