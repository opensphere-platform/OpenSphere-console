import { Component, OnInit, OnDestroy, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { FormsModule } from '@angular/forms';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';
import { OsActionDialog } from '../os/os-action-dialog';
import { HttpService } from '../core/http.service';

interface OaaHealth {
  service: string;
  version: string;
  namespace: string;
  ok?: boolean;
  /** CONSTITUTION-0004 §4.2 서버측 fail-closed mutation gate 상태. true일 때만 Kubernetes mutation/action
   *  tool이 서버에서 제공된다(exactly 'true'인 OAA_MUTATION_ENABLED). UI 확인만으로는 gate를 열 수 없다. */
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
}
interface AgentControlReadiness {
  apiVersion: string;
  fullyOperational: boolean;
  blockers: string[];
  missingCapabilities: { observability: string[]; hisOwner: string[]; cephOwner: string[]; recoveryOwner?: string[] };
  platformSupport: { ready: boolean; phase: string };
}
interface OaaControlPlaneStatus {
  checkedAt: string;
  ready: boolean;
  fullyOperational: boolean;
  unavailable: string[];
  agentControl: AgentControlReadiness;
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
interface OaaTool {
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
interface OaaToolManifest {
  schema: string;
  service: string;
  version: string;
  generatedAt: string;
  allowedNamespaces: string[];
  scaleMax: number;
  tools: OaaTool[];
  storage?: string;
}
interface OaaActionBinding {
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
interface OaaActionBindingManifest {
  schema: string;
  service: string;
  version: string;
  generatedAt: string;
  bindings: OaaActionBinding[];
  invalidBindings: { id: string; toolId: string }[];
  storage?: string;
}

/**
 * /manage/oaa — OAA(OpenSphere AI Agent) Gateway 관리 표면. **셸 네이티브** 전용 페이지(CONSTITUTION-0004 §4.2/§4.4).
 * OAA Core는 Main Shell native capability이고 OAA Gateway는 Supabase consumer인 별도 서버 workload다 — 여기서는
 * Gateway health, LLM provider key custody, Knowledge/Manual Registry, Tool Registry/Action Bindings만 다룬다.
 * Data & Identity 페이지에는 절대 다시 흡수하지 않는다(§8 감사 판정).
 *
 * 모든 호출은 same-origin `/api/oaa/*` + HttpService(내부적으로 AuthService.token()을 Bearer로 첨부, cross-origin 차단).
 * LLM API key는 여기서 절대 localStorage/sessionStorage/log/DOM 목록에 저장하지 않는다 — 생성/회전 성공(또는 실패) 직후
 * 폼의 apiKey 필드를 즉시 비우고, 목록에는 서버가 계산한 fingerprint만 보여준다.
 *
 * mutation(쓰기) 바인딩 실행은 정확한 confirmation 문자열 + 사유(reason) 둘 다 로컬에서 먼저 검증하고,
 * 서버가 보고하는 health.mutationEnabled === true이면서 tool manifest/action binding 로드가 모두
 * 성공하지 않았으면(mutationGateOpen=false) 서버로 실행 요청을 보내지 않는다. 이는 UI 편의 게이트일 뿐이다 —
 * 실제 강제는 opensphere-console-oaa-gateway 서버가 Cluster Manager Activated + HIS Preflight Ready 이전에는
 * OAA_MUTATION_ENABLED가 정확히 'true'가 아닌 한 모든 Kubernetes mutation/action tool을 tool manifest/action
 * binding 응답에서 제거하고 실행 요청을 403(mutation_disabled_until_his_ready)으로 fail-closed 처리하는
 * 방식으로 이미 수행한다(CONSTITUTION-0004 §4.2). 이 페이지는 그 서버 정책을 대체하지 않는다.
 */
@Component({
  selector: 'os-admin-oaa',
  imports: [ClarityModule, FormsModule, BackendUnavailable, OsPageHeader, OsPanel, OsActionDialog],
  template: `
    <div class="os-page">
      <os-page-header title="OAA Gateway" tag="Core·Admin · OpenSphere AI Agent 관리 표면" />
      @if (gatewayDown(); as d) {
        <os-backend-unavailable
          feature="OAA Gateway"
          backend="opensphere-console-oaa-gateway (/api/oaa)"
          hint="opensphere-console-oaa-gateway 배포 · Supabase PostgreSQL/pgvector 연결 시 복구됩니다. 미배포여도 콘솔 로그인/관리/Manual은 영향받지 않습니다."
          [detail]="d"
        />
      } @else {
        <p class="os-sub">
          OAA Core는 Main Shell native capability이고, OAA Gateway는 보안·격리를 위한 별도 Supabase consumer workload입니다
          (<code>CONSTITUTION-0004 §4.2</code>). Provider key 미배포 시 채팅은 <strong>Degraded</strong>일 수 있으나 콘솔 관리는 항상 동작합니다.
          @if (health(); as h) { · <code>{{ h.service }}</code> v{{ h.version }} · ns <code>{{ h.namespace }}</code> }
        </p>

        <section class="manage-status-rail" aria-label="OAA 운영 상태">
          <div><span>Gateway</span><strong [class.ok]="!!health()">{{ health() ? 'Reachable' : 'Unavailable' }}</strong><small>{{ health()?.service || 'health unavailable' }}</small></div>
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
          <!-- 탭1: Gateway health/readiness -->
          <clr-tab>
            <button clrTabLink>Gateway</button>
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
                    <span class="os-mono">{{ h.service }} · v{{ h.version }} · ns {{ h.namespace }}</span>
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
                <p class="os-sub">Mutation gate는 서버가 보고하는 <code>health.mutationEnabled === true</code>(CONSTITUTION-0004 §4.2 fail-closed)이고 tool manifest · action binding 로드가 모두 성공했을 때만 열립니다. Cluster Manager Activated + HIS Preflight Ready 이전에는 서버가 Kubernetes mutation/action tool을 제공하지 않으므로 이 UI 표시와 무관하게 실행은 항상 403으로 차단됩니다.</p>
              </div>

              @if (controlPlaneStatus(); as control) {
                <div class="os-card oaa-control-readiness">
                  <div class="os-card-h"><span>Complete Agent readiness</span><strong [class.ok]="control.fullyOperational" [class.warn]="!control.fullyOperational">{{ control.fullyOperational ? 'Fully operational' : 'Degraded' }}</strong></div>
                  <p class="os-sub">Owner API 도달 여부와 별개로 지식·실시간 projection·승인 mutation·Platform Support·HIS·Ceph capability를 모두 검증합니다. 마지막 확인 {{ formatDateTime(control.checkedAt) }}</p>
                  @if (control.agentControl.blockers.length) {
                    <div class="oaa-blocker-list" aria-label="OAA 완전 운영 차단 사유">
                      @for (blocker of control.agentControl.blockers; track blocker) { <code>{{ blocker }}</code> }
                    </div>
                  }
                  <div class="oaa-capability-gaps">
                    <span>Observability missing <strong>{{ control.agentControl.missingCapabilities.observability.join(', ') || 'none' }}</strong></span>
                    <span>HIS owner missing <strong>{{ control.agentControl.missingCapabilities.hisOwner.join(', ') || 'none' }}</strong></span>
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
                  <clr-alert-item><span class="alert-text">Degraded: 등록된 LLM provider key가 없습니다 — OAA 채팅만 저하되고 콘솔 관리 기능에는 영향이 없습니다.</span></clr-alert-item>
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
                      <div class="oaa-validation-detail">{{ k.validationLatencyMs ? (k.validationLatencyMs + 'ms') : '' }}{{ k.validatedAt ? (' · ' + k.validatedAt) : '' }}</div>
                    </clr-dg-cell>
                    <clr-dg-cell>
                      @if (usageKey(k.id); as keyUsage) {
                        <div class="oaa-key-usage">
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
              <div class="os-actions oaa-usage-actions">
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 1" [class.btn-outline]="usageRangeDays !== 1" (click)="setUsageRange(1)">24시간</button>
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 7" [class.btn-outline]="usageRangeDays !== 7" (click)="setUsageRange(7)">7일</button>
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 30" [class.btn-outline]="usageRangeDays !== 30" (click)="setUsageRange(30)">30일</button>
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 90" [class.btn-outline]="usageRangeDays !== 90" (click)="setUsageRange(90)">90일</button>
                <button class="btn btn-sm" [class.btn-primary]="usageRangeDays === 365" [class.btn-outline]="usageRangeDays !== 365" (click)="setUsageRange(365)">1년</button>
                <button class="btn btn-sm btn-outline" [disabled]="usageBusy()" (click)="loadLlmUsage()">새로고침</button>
                @if (usageBusy()) { <span class="spinner spinner-inline"></span> }
                @if (usage(); as currentUsage) { <span class="oaa-usage-generated">Supabase 기준 · {{ formatDateTime(currentUsage.generatedAt) }}</span> }
              </div>

              @if (usageError()) {
                <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ usageError() }}</span></clr-alert-item></clr-alert>
              } @else if (usage(); as currentUsage) {
                <section class="oaa-usage-window-grid" aria-label="LLM 사용량 기간 비교">
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

                <section class="manage-status-rail oaa-usage-summary" aria-label="선택 기간 LLM 사용량 요약">
                  <div><span>Requests</span><strong>{{ formatTokenCount(currentUsage.summary.requests) }}</strong><small>{{ currentUsage.rangeDays }}일 조회 범위</small></div>
                  <div><span>Input tokens</span><strong>{{ formatTokenCount(currentUsage.summary.inputTokens) }}</strong><small>cached {{ formatTokenCount(currentUsage.summary.cachedInputTokens) }}</small></div>
                  <div><span>Output tokens</span><strong>{{ formatTokenCount(currentUsage.summary.outputTokens) }}</strong><small>reasoning {{ formatTokenCount(currentUsage.summary.reasoningTokens) }}</small></div>
                  <div><span>Total tokens</span><strong>{{ formatTokenCount(currentUsage.summary.totalTokens) }}</strong><small>provider reported</small></div>
                  <div><span>Success</span><strong [class.ok]="currentUsage.summary.successRate >= 99" [class.warn]="currentUsage.summary.successRate < 99">{{ formatSuccessRate(currentUsage.summary.successRate) }}</strong><small>{{ currentUsage.summary.failedRequests }} failed</small></div>
                  <div><span>p95 latency</span><strong>{{ currentUsage.summary.p95LatencyMs == null ? '-' : (formatTokenCount(currentUsage.summary.p95LatencyMs) + 'ms') }}</strong><small>provider round trip</small></div>
                  <div><span>Estimated cost</span><strong>{{ usageCostLabel(currentUsage.summary) }}</strong><small>{{ usageCostCoverage(currentUsage.summary) }}</small></div>
                </section>

                <div class="oaa-usage-layout">
                  <section class="os-card oaa-usage-card oaa-grass-card">
                    <div class="os-card-h">사용 빈도 <span>일별 요청 횟수 · KST</span></div>
                    @if (usageGrass(); as grass) {
                      <div class="oaa-grass-chart" aria-label="일별 LLM 사용 빈도">
                        <div class="oaa-grass-axis" aria-hidden="true">
                          <span></span><span>월</span><span></span><span>수</span><span></span><span>금</span><span></span>
                        </div>
                        <div class="oaa-grass-scroll">
                          <div class="oaa-grass-months" aria-hidden="true">
                            @for (week of grass.weeks; track week.key) { <span>{{ week.monthLabel }}</span> }
                          </div>
                          <div class="oaa-grass-weeks">
                            @for (week of grass.weeks; track week.key) {
                              <div class="oaa-grass-week">
                                @for (day of week.days; track day.date) {
                                  @if (day.inRange) {
                                    <span
                                      class="oaa-grass-cell"
                                      [attr.data-level]="day.level"
                                      [attr.title]="usageGrassDayLabel(day)"
                                      [attr.aria-label]="usageGrassDayLabel(day)"
                                      role="img"
                                      tabindex="0"
                                    ></span>
                                  } @else {
                                    <span class="oaa-grass-cell outside-range" aria-hidden="true"></span>
                                  }
                                }
                              </div>
                            }
                          </div>
                        </div>
                      </div>
                      <div class="oaa-grass-footer">
                        <span><strong>{{ grass.activeDays }}</strong>/{{ currentUsage.rangeDays }}일 활동 · 하루 최대 <strong>{{ formatTokenCount(grass.peakRequests) }}</strong> requests</span>
                        <span class="oaa-grass-legend" aria-label="사용 빈도 범례">
                          <small>적음</small>
                          @for (level of usageGrassLevels; track level) { <i class="oaa-grass-cell" [attr.data-level]="level"></i> }
                          <small>많음</small>
                        </span>
                      </div>
                    }
                  </section>
                  <section class="os-card oaa-usage-card">
                    <div class="os-card-h">Consumer sources <span>Console · subShell 투명성</span></div>
                    <div class="oaa-usage-source-list">
                      @for (source of currentUsage.bySource; track source.source) {
                        <div><span><strong>{{ source.source }}</strong><small>{{ source.requests }} requests</small></span><b>{{ formatTokenCount(source.totalTokens) }}</b></div>
                      } @empty { <p class="os-sub">사용 기록이 없습니다.</p> }
                    </div>
                  </section>
                </div>

                <h3 class="oaa-usage-heading">Key별 사용량</h3>
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

                <div class="oaa-usage-layout oaa-usage-tables">
                  <section>
                    <h3 class="oaa-usage-heading">모델·작업별</h3>
                    <div class="oaa-usage-source-list">
                      @for (model of currentUsage.byModel; track model.provider + '/' + model.model + '/' + model.operation) {
                        <div><span><strong>{{ model.provider }} / {{ model.model }}</strong><small>{{ model.operation }} · {{ model.requests }} requests</small></span><b>{{ formatTokenCount(model.totalTokens) }}</b></div>
                      } @empty { <p class="os-sub">모델 사용 기록이 없습니다.</p> }
                    </div>
                  </section>
                  <section>
                    <h3 class="oaa-usage-heading">최근 요청</h3>
                    <div class="oaa-usage-recent">
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
              <div class="os-actions oaa-usage-actions">
                @for (days of [1, 7, 30, 90, 365]; track days) {
                  <button class="btn btn-sm" [class.btn-primary]="evidenceRangeDays === days" [class.btn-outline]="evidenceRangeDays !== days" (click)="setEvidenceRange(days)">{{ days === 1 ? '24시간' : (days === 365 ? '1년' : days + '일') }}</button>
                }
                <button class="btn btn-sm btn-outline" [disabled]="evidenceBusy()" (click)="loadAgentEvidence()">새로고침</button>
                @if (evidenceBusy()) { <span class="spinner spinner-inline"></span> }
                @if (evidence(); as currentEvidence) { <span class="oaa-usage-generated">Supabase 증적 기준 · {{ formatDateTime(currentEvidence.generatedAt) }}</span> }
              </div>

              @if (evidenceError()) {
                <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ evidenceError() }}</span></clr-alert-item></clr-alert>
              } @else if (evidence(); as currentEvidence) {
                <clr-alert clrAlertType="info" [clrAlertClosable]="false">
                  <clr-alert-item><span class="alert-text">프롬프트·응답·credential·raw log는 저장하지 않습니다. Run ID 아래에 digest와 최소 metadata만 연결합니다. 삭제 API는 없으며 export receipt와 검토된 owner maintenance가 필요합니다.</span></clr-alert-item>
                </clr-alert>
                <section class="manage-status-rail oaa-evidence-summary" aria-label="Agent 증적 요약">
                  <div><span>Runs</span><strong>{{ formatTokenCount(currentEvidence.summary.runs) }}</strong><small>{{ currentEvidence.rangeDays }}일</small></div>
                  <div><span>Completed</span><strong class="ok">{{ formatTokenCount(currentEvidence.summary.completed) }}</strong><small>정상 종료</small></div>
                  <div><span>Failed</span><strong [class.warn]="currentEvidence.summary.failed > 0">{{ formatTokenCount(currentEvidence.summary.failed) }}</strong><small>실패</small></div>
                  <div><span>Running</span><strong>{{ formatTokenCount(currentEvidence.summary.running) }}</strong><small>진행 중</small></div>
                  <div><span>Tool calls</span><strong>{{ formatTokenCount(currentEvidence.summary.toolCalls) }}</strong><small>run correlation</small></div>
                </section>

                <h3 class="oaa-usage-heading">보존·Legal hold 정책</h3>
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

                <h3 class="oaa-usage-heading">Run → retrieval / tool / provider correlation</h3>
                <clr-accordion [clrAccordionMultiPanel]="true" class="oaa-evidence-runs">
                  @for (run of currentEvidence.runs; track run.runId) {
                    <clr-accordion-panel>
                      <clr-accordion-title>
                        <span class="oaa-evidence-run-title"><span class="label" [class.label-success]="run.status === 'completed'" [class.label-danger]="run.status === 'failed'" [class.label-warning]="run.status === 'running'">{{ run.status }}</span><code>{{ shortId(run.runId) }}</code><strong>{{ run.provider }} / {{ run.model }}</strong><span>{{ run.actorLabel }}</span><time>{{ formatDateTime(run.startedAt) }}</time></span>
                      </clr-accordion-title>
                      <clr-accordion-content *clrIfExpanded>
                        <div class="oaa-evidence-run-meta"><code>run {{ run.runId }}</code><code>request {{ run.requestDigest }}</code><span>{{ run.steps.length }} steps · {{ run.retrievals.length }} retrieval hits · {{ run.tools.length }} tool evidence · {{ run.providerCalls.length }} provider calls</span></div>
                        <div class="oaa-evidence-grid">
                          <section><h4>Retrieval revisions</h4>
                            @for (item of run.retrievals; track item.requestId + '-' + item.rank) { <div class="oaa-evidence-item"><span>#{{ item.rank }} · {{ item.title || item.sourceId }}</span><code>{{ item.documentRevision || '-' }}</code><small>score {{ item.score.toFixed(3) }}</small></div> }
                            @empty { <p class="os-sub">retrieval 없음</p> }
                          </section>
                          <section><h4>Tool evidence</h4>
                            @for (item of run.tools; track item.requestId) { <div class="oaa-evidence-item"><span>{{ item.toolId }}</span><code>{{ item.target }}</code><small>{{ item.status }} · {{ item.permissionCode }}</small></div> }
                            @empty { <p class="os-sub">tool 호출 없음</p> }
                          </section>
                          <section><h4>Provider calls</h4>
                            @for (item of run.providerCalls; track item.requestId) { <div class="oaa-evidence-item"><span>{{ item.operation }} · {{ item.status }}</span><code>{{ item.provider }}/{{ item.model }}</code><small>{{ formatTokenCount(item.totalTokens) }} tokens · {{ item.latencyMs == null ? '-' : item.latencyMs + 'ms' }}</small></div> }
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
        <os-panel [open]="llmPanelOpen()" [title]="llmEditingId() ? 'LLM Key 회전 — ' + llmEditingId() : 'LLM Key 추가'" subtitle="OAA Gateway · Kubernetes Secret custody" (closed)="closeKeyPanel()">
          <div class="oaa-key-intro">
            <strong>Provider credential</strong>
            <p>API key는 게이트웨이가 Kubernetes Secret으로만 보관합니다. 이 화면은 raw key를 저장·재표시하지 않으며, 저장 직후 입력값을 비웁니다.</p>
          </div>
          <form clrForm clrLayout="vertical" class="clr-form-full-width oaa-key-form" autocomplete="off">
            <div class="oaa-form-section">
              <strong>Provider configuration</strong>
              <span>식별자와 provider endpoint</span>
            </div>
            <div class="oaa-generated-id" aria-label="설정 ID">
              <span class="oaa-generated-id-label">설정 ID <small>(자동 생성 · API key 아님)</small></span>
              <code>{{ llmForm.id }}</code>
              <span class="oaa-generated-id-helper">Provider 선택에 따라 생성되며 Gateway와 감사 로그에서만 사용합니다.</span>
            </div>
            <clr-select-container>
              <label>Provider</label>
              <select clrSelect [(ngModel)]="llmForm.provider" (ngModelChange)="onLlmProviderChange($event)" name="oaa-key-provider" [disabled]="llmSaving()">
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
              <input clrInput [(ngModel)]="llmForm.displayName" name="oaa-key-display" placeholder="OpenAI Main" [disabled]="llmSaving()" maxlength="120" />
            </clr-input-container>
            <clr-input-container>
              <label>Base URL</label>
              <input clrInput [(ngModel)]="llmForm.baseUrl" name="oaa-key-baseurl" placeholder="https://api.openai.com/v1" [disabled]="llmSaving()" maxlength="200" />
            </clr-input-container>
            <div class="oaa-form-section">
              <strong>Model routing</strong>
              <span>기본 응답 모델과 knowledge embedding 모델</span>
            </div>
            <clr-input-container>
              <label>Default model</label>
              <input clrInput [(ngModel)]="llmForm.defaultModel" name="oaa-key-model" placeholder="gpt-4.1" [disabled]="llmSaving()" maxlength="128" />
            </clr-input-container>
            <clr-input-container>
              <label>Embedding model (선택)</label>
              <input clrInput [(ngModel)]="llmForm.embeddingModel" name="oaa-key-embed" placeholder="text-embedding-3-large" [disabled]="llmSaving()" maxlength="128" />
            </clr-input-container>
            <div class="oaa-form-section">
              <strong>Credential & governance</strong>
              <span>비밀 값과 운영 변경 증거</span>
            </div>
            <div class="oaa-field-wide oaa-secret-control">
              <label class="clr-control-label" for="oaa-key-secret">API key{{ llmEditingId() ? ' (비우면 메타데이터만 갱신)' : '' }}</label>
              <div class="oaa-secret-input-shell">
                <input
                  id="oaa-key-secret"
                  class="clr-input"
                  [type]="llmSecretVisible() ? 'text' : 'password'"
                  autocomplete="new-password"
                  [(ngModel)]="llmForm.apiKey"
                  (ngModelChange)="onLlmApiKeyChange($event)"
                  name="oaa-key-secret"
                  placeholder="sk-..."
                  [disabled]="llmSaving()"
                  maxlength="256"
                  aria-describedby="oaa-key-secret-help"
                />
                <button
                  type="button"
                  class="oaa-secret-toggle"
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
              <span id="oaa-key-secret-help" class="clr-subtext">눈동자를 누르면 입력값을 확인할 수 있습니다. 원문은 저장 후 다시 조회할 수 없습니다.</span>
            </div>
            <clr-checkbox-container>
              <clr-checkbox-wrapper>
                <input type="checkbox" clrCheckbox [(ngModel)]="llmForm.enabled" name="oaa-key-enabled" [disabled]="llmSaving()" />
                <label>Enabled</label>
              </clr-checkbox-wrapper>
            </clr-checkbox-container>
            <clr-input-container class="oaa-field-wide">
              <label>사유 (필수)</label>
              <input clrInput [(ngModel)]="llmForm.reason" name="oaa-key-reason" placeholder="초기 설정 / 회전 사유" [disabled]="llmSaving()" maxlength="200" />
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
            <clr-alert-item><span class="alert-text">이 설정은 보존·legal hold·export 필요 조건을 관리합니다. 정책 변경 자체는 증거를 삭제하지 않으며, OAA에는 purge API가 없습니다.</span></clr-alert-item>
          </clr-alert>
          <form clrForm clrLayout="vertical" class="clr-form-full-width oaa-retention-form">
            <div class="oaa-generated-id"><span class="oaa-generated-id-label">Evidence stream</span><code>{{ retentionForm.stream }}</code></div>
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
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .gw-body { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; padding: 0.6rem 0.9rem; }
      .oaa-control-readiness .os-card-h { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
      .oaa-blocker-list { display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 0 0.9rem 0.7rem; }
      .oaa-blocker-list code { border: 1px solid #e0a046; background: #fff7e6; color: #7a4300; padding: 0.2rem 0.35rem; font-size: 0.58rem; }
      .oaa-capability-gaps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--os-hairline); }
      .oaa-capability-gaps span { display: grid; gap: 0.15rem; min-width: 0; padding: 0.55rem 0.7rem; border-right: 1px solid var(--os-hairline); color: var(--os-ink-muted); font-size: 0.56rem; }
      .oaa-capability-gaps span:last-child { border-right: 0; }
      .oaa-capability-gaps strong { color: var(--os-ink); overflow-wrap: anywhere; font-size: 0.61rem; }
      .stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.6rem; margin-bottom: 0.55rem; }
      .stat-grid div { border: 1px solid #e1e5ea; border-radius: 4px; padding: 0.55rem 0.65rem; background: #f8fafc; }
      .stat-grid span { display: block; color: var(--os-muted); font-size: 0.62rem; }
      .stat-grid strong { display: block; margin-top: 0.15rem; font-size: 1rem; color: #1b2733; }
      .panel-actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
      .oaa-key-intro { margin: 0 0 1rem; padding: 0 0 0.8rem; border-bottom: 1px solid var(--os-hairline); }
      .oaa-key-intro strong { display: block; color: var(--os-ink); font-size: 0.78rem; }
      .oaa-key-intro p { max-width: 62rem; margin: 0.25rem 0 0; color: var(--os-muted); font-size: 0.68rem; line-height: 1.5; }
      .oaa-key-form { --os-panel-form-max: 68rem; width: 100%; max-width: 68rem; display: grid; grid-template-columns: repeat(2, minmax(16rem, 1fr)); column-gap: 1.4rem; row-gap: 0; padding: 0; }
      .oaa-key-form clr-input-container,
      .oaa-key-form clr-select-container,
      .oaa-key-form clr-checkbox-container { min-width: 0; display: block; }
      .oaa-generated-id { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 0.28rem; margin-top: 0.7rem; padding: 0.55rem 0.65rem; border: 1px solid var(--os-hairline); border-radius: 3px; background: #f7f9fa; }
      .oaa-generated-id-label { color: var(--os-ink); font-size: 0.65rem; font-weight: 600; }
      .oaa-generated-id-label small { color: var(--os-muted); font-size: 0.58rem; font-weight: 400; }
      .oaa-generated-id code { color: #1f4f75; font-size: 0.72rem; font-weight: 600; }
      .oaa-generated-id-helper { color: var(--os-muted); font-size: 0.58rem; line-height: 1.4; }
      .oaa-key-form .oaa-field-wide,
      .oaa-form-section { grid-column: 1 / -1; }
      .oaa-form-section { display: flex; align-items: baseline; gap: 0.45rem; margin: 1rem 0 -0.15rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--os-hairline); }
      .oaa-form-section:first-child { margin-top: 0; }
      .oaa-form-section strong { color: var(--os-ink); font-size: 0.72rem; }
      .oaa-form-section span { color: var(--os-muted); font-size: 0.62rem; }
      :host ::ng-deep .oaa-key-form .clr-form-control { margin-top: 0.7rem; }
      :host ::ng-deep .oaa-key-form .clr-control-container,
      :host ::ng-deep .oaa-key-form .clr-input-wrapper,
      :host ::ng-deep .oaa-key-form .clr-select-wrapper { width: 100%; }
      :host ::ng-deep .oaa-key-form input.clr-input,
      :host ::ng-deep .oaa-key-form select.clr-select { width: 100%; max-width: none; }
      .oaa-secret-control { min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.7rem; }
      .oaa-secret-input-shell { position: relative; width: 100%; }
      .oaa-secret-input-shell input.clr-input { width: 100%; max-width: none; min-height: 1.8rem; padding-right: 2.35rem; }
      .oaa-secret-control .clr-subtext { display: block; color: var(--os-muted); font-size: 0.58rem; line-height: 1.4; }
      .oaa-secret-toggle { position: absolute; z-index: 1; top: 50%; right: 0.12rem; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; width: 1.8rem; height: 1.65rem; padding: 0; border: 0; border-radius: 3px; background: #fff; color: #4f6475; cursor: pointer; }
      .oaa-secret-toggle:hover:not(:disabled) { background: #eef2f5; color: #1f66b3; }
      .oaa-secret-toggle:focus-visible { outline: 2px solid #2f7ed8; outline-offset: 1px; }
      .oaa-secret-toggle:disabled { color: #9baab5; cursor: not-allowed; opacity: 0.65; }
      .oaa-secret-toggle svg { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
      .oaa-validation-detail { margin-top: 0.18rem; color: var(--os-muted); font-family: var(--os-font-mono); font-size: 0.55rem; white-space: nowrap; }
      :host ::ng-deep .oaa-key-form .clr-checkbox-wrapper { margin-top: 0.7rem; }
      :host ::ng-deep .oaa-key-form + .panel-actions { margin-top: 1rem; }
      .oaa-retention-form { --os-panel-form-max: 42rem; width: 100%; max-width: 42rem; }
      :host ::ng-deep .oaa-retention-form .clr-control-container,
      :host ::ng-deep .oaa-retention-form .clr-input-wrapper,
      :host ::ng-deep .oaa-retention-form .clr-select-wrapper { width: 100%; }
      :host ::ng-deep .oaa-retention-form input.clr-input,
      :host ::ng-deep .oaa-retention-form select.clr-select { width: 100%; max-width: none; }
      .exec-result { margin: 0.7rem 0 0; max-height: 16rem; overflow: auto; border: 1px solid #e1e5ea; border-radius: 4px; background: #0f2230; color: #d7e6ee; padding: 0.7rem; font-size: 0.66rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      @media (max-width: 980px) { .stat-grid { grid-template-columns: 1fr 1fr; } }
      @media (max-width: 760px) {
        .oaa-key-form { grid-template-columns: 1fr; }
        .oaa-key-form .oaa-field-wide,
        .oaa-form-section { grid-column: 1; }
        .oaa-form-section { align-items: flex-start; flex-direction: column; gap: 0.1rem; }
        .oaa-capability-gaps { grid-template-columns: 1fr; }
        .oaa-capability-gaps span { border-right: 0; border-bottom: 1px solid var(--os-hairline); }
        .oaa-capability-gaps span:last-child { border-bottom: 0; }
      }
    `,
  ],
})
export class AdminOaa implements OnInit, OnDestroy {
  private http = inject(HttpService);

  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);

  // Gateway health/readiness
  readonly health = signal<OaaHealth | null>(null);
  readonly gatewayDown = signal<string>('');
  readonly healthBusy = signal(false);
  readonly controlPlaneStatus = signal<OaaControlPlaneStatus | null>(null);
  readonly controlPlaneError = signal('');
  private timer: ReturnType<typeof setInterval> | null = null;

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
  readonly toolManifest = signal<OaaToolManifest | null>(null);
  readonly actionBindings = signal<OaaActionBindingManifest | null>(null);
  readonly toolsLoaded = signal(false);
  readonly toolBusy = signal(false);

  // Action binding execution (mutation gate)
  readonly execBinding = signal<OaaActionBinding | null>(null);
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
    await this.loadHealth();
    await Promise.all([this.loadLlmKeys(), this.loadLlmUsage(), this.loadAgentEvidence(), this.loadKnowledgeStats(), this.loadToolManifest(), this.loadActionBindings()]);
    this.timer = setInterval(() => this.loadHealth(true), 15000);
  }
  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async loadHealth(silent = false): Promise<void> {
    if (!silent) this.healthBusy.set(true);
    try {
      const r = await this.http.request('/api/oaa/health', { cache: 'no-store' });
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

  private async loadControlPlaneStatus(): Promise<void> {
    try {
      const response = await this.http.request('/api/oaa/tools/control-plane/status', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        this.controlPlaneStatus.set(null);
        this.controlPlaneError.set(body.error || `HTTP ${response.status}`);
        return;
      }
      this.controlPlaneStatus.set(await response.json() as OaaControlPlaneStatus);
      this.controlPlaneError.set('');
    } catch (error) {
      this.controlPlaneStatus.set(null);
      this.controlPlaneError.set(String(error));
    }
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
      const r = await this.http.request('/api/oaa/admin/llm-keys', { cache: 'no-store' });
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
      const r = await this.http.request('/api/oaa/admin/llm-keys', {
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
        `/api/oaa/admin/llm-keys/${encodeURIComponent(k.id)}?reason=${encodeURIComponent(reason)}`,
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
      const r = await this.http.request(`/api/oaa/admin/usage?days=${this.usageRangeDays}`, { cache: 'no-store' });
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
      const r = await this.http.request(`/api/oaa/admin/evidence?days=${this.evidenceRangeDays}&limit=25`, { cache: 'no-store' });
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
      ? `update OAA evidence retention ${this.retentionForm.stream} to ${Number(this.retentionForm.retentionDays) || 0} days`
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
      const r = await this.http.request('/api/oaa/admin/evidence/retention', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...this.retentionForm, retentionDays: Number(this.retentionForm.retentionDays) }),
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
      const r = await this.http.request('/api/oaa/admin/knowledge/stats', { cache: 'no-store' });
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
    await this.knowledgeAction('/api/oaa/admin/knowledge/manual-seed/bundled', {}, 'Bundled manuals seeded.');
  }
  async reembedKnowledge(): Promise<void> {
    await this.knowledgeAction('/api/oaa/admin/knowledge/reembed', { strict: false }, 'Knowledge re-embedded.');
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
      const r = await this.http.request(`/api/oaa/admin/llm-keys/${encodeURIComponent(k.id)}/test`, { method: 'POST' });
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
    if (status === 401) return 'OAA Gateway가 현재 로그인 세션을 확인하지 못했습니다. 세션을 갱신한 뒤 다시 시도하세요.';
    if (status === 403) return 'OAA Gateway 관리자 역할(console-admins)이 필요합니다.';
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
      const r = await this.http.request('/api/oaa/tools/manifest', { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway permission is required.' });
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
      const r = await this.http.request('/api/oaa/tools/action-bindings', { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: 'OAA Gateway permission is required.' });
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
  execFieldKeys(b: OaaActionBinding): string[] {
    return Object.keys(b.requiredInputs?.fields || {}).filter((key) => key !== 'confirm' && key !== 'reason');
  }
  openExecute(b: OaaActionBinding): void {
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
  private buildExecuteInputs(b: OaaActionBinding): Record<string, unknown> {
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
      const r = await this.http.request('/api/oaa/actions/bindings/execute', {
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
