import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import CheckmarkFilled16 from '@carbon/icons/es/checkmark--filled/16';
import WarningAltFilled16 from '@carbon/icons/es/warning--alt--filled/16';
import Pending16 from '@carbon/icons/es/pending/16';
import DataBase16 from '@carbon/icons/es/data--base/16';
import Commit16 from '@carbon/icons/es/commit/16';
import FlowData16 from '@carbon/icons/es/flow--data/16';
import DocumentSecurity16 from '@carbon/icons/es/document--security/16';
import Renew16 from '@carbon/icons/es/renew/16';
import { HttpService } from '../core/http.service';
import { CarbonIcon } from '../os/carbon-icon';
import { OsPageHeader } from '../os/os-page-header';

type ControlTab = 'operations' | 'evidence' | 'journey';
type EvidenceFilter = 'all' | 'supabase' | 'gitea' | 'runtime';
type Verdict = 'Verified' | 'Attention required' | 'Failed' | 'Not configured' | 'Awaiting consumer';

interface RecoveryCheck { assertion: string; expected: string; observed: string; verdict: string; }
interface RecoveryUnit {
  state: string; declaredState?: string; verifiedAt: string | null; assertions: string[];
  checks?: RecoveryCheck[]; evidenceQuality?: string;
}
interface SupabaseComponent { key: string; name: string; responsibility: string; ready: boolean; detail: string; }
interface SupabaseStatus {
  meta: { source: string; version: string; checkedAt: string };
  components: SupabaseComponent[]; operators: number; roles: { id: string; code: string; description: string }[];
  auditEvents: number; buckets: { id: string; name: string; public: boolean; file_size_limit: number | null }[];
  database: { authority: string; accessModel: string; rls: { state: string; evidence: string } };
  auth: { authority: string; sessionModel: string; elevatedChange: string };
  integrations: { consumerId: string; displayName: string; status: string; schemas: string[]; buckets: string[]; observability: { phase: string; binding: string | null; observedAt: string | null } | null }[];
  recovery: { available: boolean; reason?: string; generatedAt?: string | null; supabase?: RecoveryUnit; storage?: RecoveryUnit; gitea?: RecoveryUnit };
}
interface Approval { approver_id: string; status: string; created_at: string; completed_at: string | null; error_code: string | null; }
interface ChangeRequest {
  request_id: string; action: string; target: string; reason: string; status: string; git_repo: string | null; git_ref: string | null; git_commit_sha: string | null; k8s_operation_id: string | null; created_at: string; completed_at: string | null;
  execution: { branch: string; pull_number: number | null; pull_url: string | null; desired_revision: string | null; merge_revision: string | null; reconciler: string; reconciler_status: string; drift_status: string; attempt_count: number; last_error: string | null; updated_at: string } | null;
  outbox: { status: string; attempts: number; next_attempt_at: string | null; last_error: string | null; updated_at: string } | null;
  approvals: Approval[];
}
interface ChangeControlState {
  meta: { source: string; checkedAt: string; organization: string; tokenConfigured: boolean };
  configured: boolean; ready: boolean; version: string; repositoryCount: number | null;
  repositories: { name: string; private: boolean; archived: boolean; empty: boolean; defaultBranch: string; updatedAt: string | null; sizeKiB: number }[];
  contracts: { consumer_id: string; display_name: string; reconciler: string; status: string; desired_revision: string | null; applied_revision: string | null; observability: { phase: string; binding_name: string | null; observed_at: string | null } | null }[];
  receipts: { delivery_id: string; event_type: string; repository: string | null; request_id: string | null; signature_valid: boolean; disposition: string; error_code: string | null; received_at: string }[];
  changes: ChangeRequest[]; byStatus: Record<string, number>; reason: string; managementReady: boolean;
  supplyChain: { repository: string; defaultBranch: string; protected: boolean; requiredApprovals: number; directPushEnabled: boolean; signedCommitsRequired: boolean; blockRejectedReviews: boolean } | null;
  recovery?: { available: boolean; reason?: string; generatedAt?: string | null; gitea?: RecoveryUnit };
}
interface EvidenceRow {
  id: string; authority: EvidenceFilter; source: string; assertion: string; expected: string; observed: string;
  time: string | null; verdict: Verdict; detail: string; correlation: string;
}
interface JourneyStep { column: string; source: 'Supabase' | 'Gitea' | 'Kubernetes'; label: string; evidence: string; time: string | null; state: 'done' | 'current' | 'waiting' | 'failed'; }

/**
 * Cross-authority operations workspace. Supabase and Gitea remain separate
 * sources of truth; this view correlates their read-only status without
 * manufacturing HIS telemetry or treating an unobserved change as complete.
 */
@Component({
  selector: 'os-admin-platform-control',
  imports: [ClarityModule, RouterLink, CarbonIcon, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page platform-control">
      <os-page-header title="Platform Control Plane" tag="Supabase + Gitea · Operations & evidence" />
      <div class="page-lead">
        <p>데이터 권위, 선언형 변경과 실제 반영 증거를 한 맥락에서 확인합니다. 각 시스템의 경계를 유지하며 근거가 없는 상태를 완료로 표시하지 않습니다.</p>
        <div class="page-meta"><span>마지막 확인</span><strong>{{ formatDate(lastChecked()) }}</strong><button class="icon-button" type="button" aria-label="상태 새로고침" [disabled]="busy()" (click)="refresh()"><os-cicon [icon]="icons.renew" [size]="16" /></button></div>
      </div>

      @if (supabaseDown() || giteaDown()) {
        <div class="source-alerts" role="status">
          @if (supabaseDown()) { <p><strong>Supabase status unavailable</strong><span>{{ supabaseDown() }}</span></p> }
          @if (giteaDown()) { <p><strong>Gitea status unavailable</strong><span>{{ giteaDown() }}</span></p> }
        </div>
      }

      <section class="status-rail" aria-label="플랫폼 운영 상태">
        <div class="rail-cell"><span>Console status</span><strong [class]="statusClass(overallVerdict())"><os-cicon [icon]="overallVerdict() === 'Healthy' ? icons.check : icons.warning" [size]="14" />{{ overallVerdict() }}</strong><small>{{ readyServiceCount() }}/{{ serviceCount() }} core probes</small></div>
        <div class="rail-cell"><span>Audit events</span><strong>{{ supabase()?.auditEvents ?? '—' }}</strong><small>Supabase 보존 범위</small></div>
        <div class="rail-cell"><span>Governed changes</span><strong>{{ inFlight() }}</strong><small>intent · authorized · committed</small></div>
        <div class="rail-cell"><span>Runtime drift</span><strong [class]="statusClass(driftVerdict())">{{ driftVerdict() }}</strong><small>Kubernetes observed truth</small></div>
        <div class="rail-cell"><span>Recovery evidence</span><strong [class]="statusClass(recoveryVerdict())"><os-cicon [icon]="recoveryVerdict() === 'Verified' ? icons.check : icons.warning" [size]="14" />{{ recoveryVerdict() }}</strong><small>{{ recoverySummary() }}</small></div>
        <div class="rail-cell"><span>HIS Binding</span><strong [class]="statusClass(hisBinding())">{{ hisBinding() }}</strong><small>HIS 소유 telemetry</small></div>
      </section>

      <nav class="workspace-tabs" role="tablist" aria-label="Platform Control 관점">
        <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'operations'" [class.active]="activeTab() === 'operations'" (click)="activeTab.set('operations')"><span>01</span>Operations<small>전체 상태와 위험</small></button>
        <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'evidence'" [class.active]="activeTab() === 'evidence'" (click)="activeTab.set('evidence')"><span>02</span>Evidence<small>검증과 출처</small></button>
        <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'journey'" [class.active]="activeTab() === 'journey'" (click)="activeTab.set('journey')"><span>03</span>Change Journey<small>요청에서 관측까지</small></button>
      </nav>

      @if (activeTab() === 'operations') {
        <div class="operations-layout" role="tabpanel">
          <div class="authority-columns">
            <section class="authority-panel">
              <header><div><os-cicon [icon]="icons.database" [size]="18" /><span><strong>Data & Identity · Supabase</strong><small>Console data authority</small></span></div><a routerLink="/manage/data-identity">상세 관리</a></header>
              @if (supabase(); as data) {
                <div class="compact-grid">
                  @for (service of data.components; track service.key) {
                    <div class="service-row"><span>{{ service.name }}</span><strong [class]="statusClass(service.ready ? 'Ready' : 'Unavailable')">{{ service.ready ? 'Ready' : 'Unavailable' }}</strong><small>{{ service.detail }}</small></div>
                  }
                </div>
                <div class="section-band">Data inventory</div>
                <dl class="metric-list">
                  <div><dt>Active identities</dt><dd>{{ data.operators }}</dd><small>{{ data.roles.length }} Console roles</small></div>
                  <div><dt>Audit events</dt><dd>{{ data.auditEvents }}</dd><small>현재 조회 범위</small></div>
                  <div><dt>Storage buckets</dt><dd>{{ data.buckets.length }}</dd><small>{{ privateBucketCount(data) }} private</small></div>
                  <div><dt>RLS</dt><dd>{{ data.database.rls.state }}</dd><small>PostgREST boundary</small></div>
                </dl>
                <div class="section-band">Backup & recovery</div>
                <div class="recovery-line"><span>Latest evidence</span><strong [class]="statusClass(recoveryVerdict())">{{ recoveryVerdict() }}</strong><small>{{ formatDate(data.recovery.generatedAt || null) }}</small><button type="button" (click)="openRecoveryEvidence()">Review evidence</button></div>
              } @else { <div class="panel-empty">Supabase 상태를 읽을 수 없습니다.</div> }
            </section>

            <section class="authority-panel">
              <header><div><os-cicon [icon]="icons.commit" [size]="18" /><span><strong>Declarative Change · Gitea</strong><small>Desired-state authority</small></span></div><a routerLink="/manage/change-control">상세 관리</a></header>
              @if (gitea(); as changeState) {
                <dl class="property-list">
                  <div><dt>Repository</dt><dd>{{ changeState.supplyChain?.repository || 'inventory unavailable' }}</dd></div>
                  <div><dt>Protected branch</dt><dd>{{ changeState.supplyChain?.defaultBranch || '—' }} · <span [class]="statusClass(changeState.supplyChain?.protected ? 'Protected' : 'Missing')">{{ changeState.supplyChain?.protected ? 'Protected' : 'Missing' }}</span></dd></div>
                  <div><dt>Signed commits</dt><dd [class]="statusClass(changeState.supplyChain?.signedCommitsRequired ? 'Required' : 'Missing')">{{ changeState.supplyChain?.signedCommitsRequired ? 'Required' : 'Not enforced' }}</dd></div>
                  <div><dt>Direct push</dt><dd [class]="statusClass(changeState.supplyChain?.directPushEnabled ? 'Allowed' : 'Denied')">{{ changeState.supplyChain?.directPushEnabled ? 'Allowed' : 'Denied' }}</dd></div>
                </dl>
                <div class="change-metrics">
                  <div><span>PR / intent</span><strong>{{ inFlight() }}</strong><small>open lifecycle</small></div>
                  <div><span>Approvals</span><strong>{{ approvalCount(changeState) }}</strong><small>recorded</small></div>
                  <div><span>Outbox</span><strong>{{ pendingOutbox(changeState) }}</strong><small>pending</small></div>
                  <div><span>Reconcile</span><strong>{{ changeState.byStatus['applied'] || 0 }}</strong><small>{{ changeState.byStatus['failed'] || 0 }} failed</small></div>
                </div>
                <div class="section-band">Current state</div>
                <dl class="property-list current-state">
                  <div><dt>Repository health</dt><dd [class]="statusClass(changeState.ready ? 'Healthy' : 'Unavailable')">{{ changeState.ready ? 'Healthy' : 'Unavailable' }}</dd></div>
                  <div><dt>Management path</dt><dd [class]="statusClass(changeState.managementReady ? 'Ready' : 'Attention required')">{{ changeState.managementReady ? 'Ready' : 'Attention required' }}</dd></div>
                  <div><dt>Last observed change</dt><dd>{{ latestChangeLabel(changeState) }}</dd></div>
                </dl>
              } @else { <div class="panel-empty">Gitea 상태를 읽을 수 없습니다.</div> }
            </section>
          </div>

          <aside class="risk-inspector" aria-label="위험 및 증거 인스펙터">
            <header><os-cicon [icon]="icons.security" [size]="18" /><strong>Risk & evidence</strong></header>
            @if (primaryRisk(); as risk) {
              <div class="risk-callout" [class.risk-danger]="risk.tone === 'danger'">
                <span>Current risk</span><strong><os-cicon [icon]="icons.warning" [size]="16" />{{ risk.title }}</strong><p>{{ risk.detail }}</p><button class="btn btn-primary btn-sm" type="button" (click)="risk.action()">{{ risk.actionLabel }}</button>
              </div>
            }
            <div class="inspector-section"><h3>Sources of truth</h3><dl><div><dt>Data & identity</dt><dd>Supabase</dd></div><div><dt>Change declaration</dt><dd>Gitea</dd></div><div><dt>Runtime truth</dt><dd>Kubernetes observed state</dd></div></dl></div>
            <div class="inspector-section"><h3>Connection state</h3><dl><div><dt>Supabase</dt><dd [class]="statusClass(supabase() ? 'Connected' : 'Unavailable')">{{ supabase() ? 'Connected' : 'Unavailable' }}</dd></div><div><dt>Gitea</dt><dd [class]="statusClass(gitea()?.ready ? 'Connected' : 'Unavailable')">{{ gitea()?.ready ? 'Connected' : 'Unavailable' }}</dd></div><div><dt>HIS Binding</dt><dd [class]="statusClass(hisBinding())">{{ hisBinding() }}</dd></div></dl></div>
          </aside>

          <section class="timeline-panel">
            <header><div><os-cicon [icon]="icons.flow" [size]="18" /><span><strong>Recent governed activity</strong><small>Supabase request → Gitea evidence → Kubernetes receipt</small></span></div><button type="button" (click)="activeTab.set('journey')">Open journey</button></header>
            <div class="table-scroll"><table><thead><tr><th>Time</th><th>Request</th><th>Target</th><th>Gitea PR / commit</th><th>Outbox</th><th>Reconcile / observed</th><th>Status</th></tr></thead><tbody>
              @for (change of recentChanges(); track change.request_id) { <tr><td>{{ relativeTime(change.created_at) }}</td><td><code>{{ shortId(change.request_id) }}</code></td><td><strong>{{ change.action }}</strong><small>{{ change.target }}</small></td><td>{{ change.execution?.pull_number ? 'PR #' + change.execution?.pull_number : 'Awaiting PR' }}<small>{{ shortId(change.execution?.merge_revision || change.execution?.desired_revision || '') || '—' }}</small></td><td>{{ change.outbox?.status || 'Not queued' }}<small>attempts {{ change.outbox?.attempts || 0 }}</small></td><td>{{ change.execution?.reconciler_status || 'Awaiting consumer' }}<small>{{ change.k8s_operation_id || 'receipt 없음' }}</small></td><td><span [class]="statusClass(changeVerdict(change))">{{ changeVerdict(change) }}</span></td></tr> }
              @empty { <tr><td colspan="7"><div class="table-empty"><strong>Governed change가 아직 없습니다.</strong><span>변경이 생성되면 request ID를 기준으로 Supabase 감사, Gitea PR/commit과 Kubernetes receipt가 이곳에 연결됩니다.</span><a routerLink="/manage/change-control">첫 선언형 변경 만들기</a></div></td></tr> }
            </tbody></table></div>
          </section>
        </div>
      }

      @if (activeTab() === 'evidence') {
        <div class="evidence-workspace" role="tabpanel">
          <aside class="evidence-nav">
            <header><strong>Authority</strong><small>{{ filteredEvidence().length }} evidence items</small></header>
            @for (filter of evidenceFilters; track filter.key) { <button type="button" [class.active]="evidenceFilter() === filter.key" (click)="setEvidenceFilter(filter.key)"><span><os-cicon [icon]="filter.icon" [size]="16" />{{ filter.label }}</span><strong>{{ evidenceCount(filter.key) }}</strong></button> }
            <div class="state-legend"><strong>State legend</strong><span class="ok">Verified</span><span class="warn">Attention required</span><span class="danger">Failed</span><span class="neutral">Not configured</span><span class="waiting">Awaiting consumer</span></div>
          </aside>

          <section class="evidence-canvas">
            <header><div><span>Selected scope</span><strong>{{ evidenceFilterLabel() }}</strong></div><div class="evidence-summary"><span>Coverage<strong>{{ verifiedEvidenceCount() }}/{{ evidenceRows().length }}</strong></span><span>Attention<strong>{{ attentionEvidenceCount() }}</strong></span><span>Freshness<strong>{{ relativeTime(lastChecked()) }}</strong></span></div><button class="btn btn-outline btn-sm" type="button" (click)="refresh()">Run evidence review</button></header>
            <div class="table-scroll"><table class="evidence-table"><thead><tr><th>Evidence ID</th><th>Source</th><th>Assertion</th><th>Expected</th><th>Observed</th><th>Time</th><th>Verdict</th></tr></thead><tbody>
              @for (row of filteredEvidence(); track row.id) { <tr [class.selected]="selectedEvidence()?.id === row.id"><td><button type="button" (click)="selectedEvidenceId.set(row.id)"><code>{{ shortId(row.id) }}</code></button></td><td>{{ row.source }}</td><td><strong>{{ row.assertion }}</strong><small>{{ row.detail }}</small></td><td>{{ row.expected }}</td><td [class]="statusClass(row.verdict)">{{ row.observed }}</td><td>{{ formatTime(row.time) }}</td><td><span [class]="statusClass(row.verdict)">{{ row.verdict }}</span></td></tr> }
              @empty { <tr><td colspan="7"><div class="table-empty"><strong>이 범위에 기록된 증거가 없습니다.</strong><span>빈 상태는 Verified가 아닙니다. 연결 또는 검증 작업을 완료한 뒤 다시 확인하세요.</span></div></td></tr> }
            </tbody></table></div>
          </section>

          <aside class="evidence-inspector">
            <header><os-cicon [icon]="icons.evidence" [size]="18" /><strong>Selected evidence</strong></header>
            @if (selectedEvidence(); as item) {
              <div class="evidence-verdict"><code>{{ item.id }}</code><strong [class]="statusClass(item.verdict)">{{ item.verdict }}</strong></div>
              <dl class="detail-list"><div><dt>Authority</dt><dd>{{ item.source }}</dd></div><div><dt>Assertion</dt><dd>{{ item.assertion }}</dd></div><div><dt>Expected</dt><dd>{{ item.expected }}</dd></div><div><dt>Observed</dt><dd>{{ item.observed }}</dd></div><div><dt>Checked</dt><dd>{{ formatDate(item.time) }}</dd></div><div><dt>Correlation</dt><dd><code>{{ item.correlation || 'not available' }}</code></dd></div></dl>
              <div class="provenance"><h3>Provenance</h3><div><span>1</span><p><strong>Supabase audit event</strong><small>{{ item.authority === 'supabase' ? 'source evidence' : 'correlation record' }}</small></p></div><div><span>2</span><p><strong>Gitea PR / commit</strong><small>{{ item.authority === 'gitea' ? 'source evidence' : 'when governed change exists' }}</small></p></div><div><span>3</span><p><strong>Kubernetes receipt</strong><small>{{ item.authority === 'runtime' ? 'observed' : 'not asserted by this evidence' }}</small></p></div></div>
              <div class="next-step"><strong>Recommended next step</strong><p>{{ evidenceNextStep(item) }}</p></div>
            } @else { <div class="panel-empty">검토할 증거를 선택하세요.</div> }
          </aside>
        </div>
      }

      @if (activeTab() === 'journey') {
        <div class="journey-workspace" role="tabpanel">
          <section class="next-action"><div><os-cicon [icon]="icons.pending" [size]="18" /><span><small>Next governed action</small><strong>{{ journeyNextAction() }}</strong></span></div><p>{{ journeyNextDetail() }}</p><a routerLink="/manage/change-control" class="btn btn-primary btn-sm">Change Control 열기</a></section>
          <div class="journey-main">
            <section class="journey-board">
              <header><div><span>Correlation ID</span><code>{{ selectedChange()?.request_id || 'no active request' }}</code></div><div><span>Elapsed</span><strong>{{ selectedChange() ? relativeTime(selectedChange()?.created_at || null) : '—' }}</strong></div><span [class]="statusClass(selectedChange() ? changeVerdict(selectedChange()!) : 'Awaiting first change')">{{ selectedChange() ? changeVerdict(selectedChange()!) : 'Awaiting first change' }}</span></header>
              <div class="stage-head">@for (stage of stageLabels; track stage) { <span>{{ stage }}</span> }</div>
              @for (lane of journeyLanes; track lane) {
                <div class="journey-lane"><div class="lane-label"><strong>{{ lane }}</strong><small>{{ laneDescription(lane) }}</small></div><div class="lane-track">
                  @for (step of journeySteps(); track step.column) { @if (step.source === lane) { <article [style.grid-column]="step.column" [class]="'journey-step ' + step.state"><os-cicon [icon]="step.state === 'done' ? icons.check : (step.state === 'failed' ? icons.warning : icons.pending)" [size]="15" /><span><strong>{{ step.label }}</strong><small>{{ step.evidence }}</small></span></article> } }
                </div></div>
              }
              <footer><span><os-cicon [icon]="icons.check" [size]="14" />Verified step</span><span><os-cicon [icon]="icons.pending" [size]="14" />Current / waiting</span><span><os-cicon [icon]="icons.warning" [size]="14" />Failed or attention</span></footer>
            </section>
            <aside class="journey-inspector">
              <header><strong>Request & policy</strong></header>
              @if (selectedChange(); as selected) {
                <dl class="detail-list"><div><dt>Request</dt><dd><code>{{ shortId(selected.request_id) }}</code></dd></div><div><dt>Target</dt><dd>{{ selected.action }} · {{ selected.target }}</dd></div><div><dt>Repository</dt><dd>{{ selected.git_repo || gitea()?.supplyChain?.repository || '—' }}</dd></div><div><dt>PR</dt><dd>{{ selected.execution?.pull_number ? '#' + selected.execution?.pull_number : 'Awaiting PR' }}</dd></div><div><dt>Signature</dt><dd [class]="statusClass(gitea()?.supplyChain?.signedCommitsRequired ? 'Required' : 'Missing')">{{ gitea()?.supplyChain?.signedCommitsRequired ? 'Required' : 'Not enforced' }}</dd></div><div><dt>Approval</dt><dd>{{ selected.approvals.length }}/{{ gitea()?.supplyChain?.requiredApprovals || 1 }}</dd></div><div><dt>Outbox</dt><dd>{{ selected.outbox?.status || 'Not queued' }}</dd></div><div><dt>Reconciler</dt><dd>{{ selected.execution?.reconciler_status || 'Awaiting consumer' }}</dd></div></dl>
              } @else { <div class="panel-empty">첫 선언형 변경이 생성되면 요청부터 observed state까지의 증거를 표시합니다.</div> }
              <div class="policy-gates"><h3>Policy gates</h3><span>Protected main<strong>{{ gitea()?.supplyChain?.protected ? 'Enforced' : 'Missing' }}</strong></span><span>Direct push<strong>{{ gitea()?.supplyChain?.directPushEnabled ? 'Allowed' : 'Denied' }}</strong></span><span>Signed commits<strong>{{ gitea()?.supplyChain?.signedCommitsRequired ? 'Required' : 'Missing' }}</strong></span><span>Approvals<strong>{{ gitea()?.supplyChain?.requiredApprovals ?? '—' }}</strong></span></div>
            </aside>
          </div>
          <section class="journey-list"><header><strong>Recent change requests</strong><small>행을 선택하면 위 여정과 증거가 함께 갱신됩니다.</small></header><div class="table-scroll"><table><thead><tr><th>Request / time</th><th>Status</th><th>Target</th><th>PR / commit</th><th>Approval</th><th>Outbox</th><th>Reconcile / observed</th><th>Drift</th></tr></thead><tbody>
            @for (change of recentChanges(); track change.request_id) { <tr [class.selected]="selectedChange()?.request_id === change.request_id"><td><button type="button" (click)="selectedChangeId.set(change.request_id)"><code>{{ shortId(change.request_id) }}</code></button><small>{{ formatDate(change.created_at) }}</small></td><td><span [class]="statusClass(changeVerdict(change))">{{ changeVerdict(change) }}</span></td><td>{{ change.target }}</td><td>{{ change.execution?.pull_number ? '#' + change.execution?.pull_number : '—' }}<small>{{ shortId(change.execution?.merge_revision || '') || 'no merge' }}</small></td><td>{{ change.approvals.length }}/{{ gitea()?.supplyChain?.requiredApprovals || 1 }}</td><td>{{ change.outbox?.status || 'Not queued' }}</td><td>{{ change.execution?.reconciler_status || 'Awaiting consumer' }}<small>{{ change.k8s_operation_id || 'receipt 없음' }}</small></td><td>{{ change.execution?.drift_status || 'Unknown' }}</td></tr> }
            @empty { <tr><td colspan="8"><div class="table-empty"><strong>추적할 변경 요청이 없습니다.</strong><span>빈 상태는 오류가 아니지만 변경 체인이 검증되었다는 뜻도 아닙니다.</span></div></td></tr> }
          </tbody></table></div></section>
        </div>
      }
    </div>
  `,
  styles: [],
})
export class AdminPlatformControl implements OnInit, OnDestroy {
  readonly icons = { check: CheckmarkFilled16, warning: WarningAltFilled16, pending: Pending16, database: DataBase16, commit: Commit16, flow: FlowData16, evidence: DocumentSecurity16, security: DocumentSecurity16, renew: Renew16 };
  readonly activeTab = signal<ControlTab>('operations');
  readonly evidenceFilter = signal<EvidenceFilter>('all');
  readonly selectedEvidenceId = signal('');
  readonly selectedChangeId = signal('');
  readonly supabase = signal<SupabaseStatus | null>(null);
  readonly gitea = signal<ChangeControlState | null>(null);
  readonly supabaseDown = signal('');
  readonly giteaDown = signal('');
  readonly busy = signal(false);
  readonly evidenceFilters = [
    { key: 'all' as const, label: 'All evidence', icon: DocumentSecurity16 },
    { key: 'supabase' as const, label: 'Supabase', icon: DataBase16 },
    { key: 'gitea' as const, label: 'Gitea', icon: Commit16 },
    { key: 'runtime' as const, label: 'Runtime / HIS', icon: FlowData16 },
  ];
  readonly stageLabels = ['Request', 'Audit', 'Signed PR', 'Approval', 'Merge', 'Outbox', 'Observed'];
  readonly journeyLanes: JourneyStep['source'][] = ['Supabase', 'Gitea', 'Kubernetes'];

  readonly lastChecked = computed(() => this.latestTime(this.supabase()?.meta.checkedAt, this.gitea()?.meta.checkedAt));
  readonly serviceCount = computed(() => (this.supabase()?.components.length || 0) + (this.gitea() ? 1 : 0));
  readonly readyServiceCount = computed(() => (this.supabase()?.components.filter((item) => item.ready).length || 0) + (this.gitea()?.ready ? 1 : 0));
  readonly inFlight = computed(() => { const value = this.gitea(); return value ? (value.byStatus['intent'] || 0) + (value.byStatus['authorized'] || 0) + (value.byStatus['committed'] || 0) : 0; });
  readonly overallVerdict = computed(() => !this.supabase() || !this.gitea()?.ready ? 'Attention' : (this.readyServiceCount() === this.serviceCount() ? 'Healthy' : 'Attention'));
  readonly recentChanges = computed(() => (this.gitea()?.changes || []).slice(0, 8));
  readonly evidenceRows = computed(() => this.buildEvidenceRows());
  readonly filteredEvidence = computed(() => this.evidenceFilter() === 'all' ? this.evidenceRows() : this.evidenceRows().filter((item) => item.authority === this.evidenceFilter()));
  readonly selectedEvidence = computed(() => {
    const rows = this.filteredEvidence();
    return rows.find((item) => item.id === this.selectedEvidenceId())
      || rows.find((item) => item.verdict !== 'Verified')
      || rows[0]
      || null;
  });
  readonly verifiedEvidenceCount = computed(() => this.evidenceRows().filter((item) => item.verdict === 'Verified').length);
  readonly attentionEvidenceCount = computed(() => this.evidenceRows().filter((item) => item.verdict !== 'Verified').length);
  readonly selectedChange = computed(() => this.recentChanges().find((item) => item.request_id === this.selectedChangeId()) || this.recentChanges()[0] || null);
  readonly journeySteps = computed(() => this.buildJourneySteps(this.selectedChange()));

  private readonly http = inject(HttpService);
  private timer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> { await this.refresh(); this.timer = setInterval(() => void this.refresh(true), 15_000); }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.busy.set(true);
    const load = async <T>(path: string): Promise<T> => { const response = await this.http.request(path, { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<T>; };
    const [supabase, gitea] = await Promise.allSettled([load<SupabaseStatus>('/api/identity/supabase/status'), load<ChangeControlState>('/api/platform/gitea/status')]);
    if (supabase.status === 'fulfilled') { this.supabase.set(supabase.value); this.supabaseDown.set(''); } else { this.supabaseDown.set(String(supabase.reason)); }
    if (gitea.status === 'fulfilled') { this.gitea.set(gitea.value); this.giteaDown.set(''); } else { this.giteaDown.set(String(gitea.reason)); }
    this.busy.set(false);
  }

  statusClass(value: string | null | undefined): string {
    const normalized = String(value || '').toLowerCase();
    if (/failed|unavailable|missing|allowed/.test(normalized)) return 'status-label danger';
    if (/attention|insufficient|incomplete/.test(normalized)) return 'status-label warn';
    if (/awaiting|pending|committed|authorized/.test(normalized)) return 'status-label waiting';
    if (/notconfigured|not configured|unknown|not queued|no evidence/.test(normalized)) return 'status-label neutral';
    return 'status-label ok';
  }
  privateBucketCount(value: SupabaseStatus): number { return value.buckets.filter((bucket) => !bucket.public).length; }
  approvalCount(value: ChangeControlState): number { return value.changes.reduce((total, change) => total + change.approvals.filter((approval) => approval.status === 'approved').length, 0); }
  pendingOutbox(value: ChangeControlState): number { return value.changes.filter((change) => change.outbox && !/sent|delivered|completed/i.test(change.outbox.status)).length; }
  shortId(value: string | null | undefined): string { return String(value || '').slice(0, 12); }
  formatDate(value: string | null | undefined): string { if (!value) return '확인 기록 없음'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date) + ' KST'; }
  formatTime(value: string | null | undefined): string { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
  relativeTime(value: string | null | undefined): string { if (!value) return '기록 없음'; const time = new Date(value).getTime(); if (Number.isNaN(time)) return String(value); const minutes = Math.max(0, Math.round((Date.now() - time) / 60000)); if (minutes < 1) return '방금'; if (minutes < 60) return `${minutes}분 전`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}시간 전`; return `${Math.floor(hours / 24)}일 전`; }
  private latestTime(...values: (string | null | undefined)[]): string | null { const valid = values.filter(Boolean).map((value) => new Date(String(value)).getTime()).filter(Number.isFinite); return valid.length ? new Date(Math.max(...valid)).toISOString() : null; }

  recoveryVerdict(): Verdict {
    const data = this.supabase(); if (!data?.recovery.available) return 'Attention required';
    const units = [data.recovery.supabase, data.recovery.storage, data.recovery.gitea].filter(Boolean) as RecoveryUnit[];
    if (!units.length || units.some((unit) => this.unitNeedsAttention(unit))) return 'Attention required';
    return 'Verified';
  }
  recoverySummary(): string { const rows = this.evidenceRows().filter((item) => /Recovery|restore/i.test(item.source + item.assertion)); const attention = rows.filter((item) => item.verdict !== 'Verified').length; return attention ? `${attention} checks need review` : (rows.length ? `${rows.length} checks verified` : 'evidence 없음'); }
  private unitNeedsAttention(unit: RecoveryUnit): boolean { if (/attention|insufficient|failed|unknown/i.test(unit.state)) return true; if (unit.checks?.some((check) => check.verdict !== 'Verified')) return true; return unit.assertions.some((assertion) => /^(restored object files|users|repositories)=0$/i.test(assertion.trim())); }
  driftVerdict(): string { const changes = this.gitea()?.changes || []; if (changes.some((item) => /drift|failed/i.test(item.execution?.drift_status || '') || item.status === 'failed')) return 'Attention'; if (!changes.length) return 'No evidence'; return changes.every((item) => /none|clean|in_sync|no.?drift/i.test(item.execution?.drift_status || '')) ? 'None' : 'Unknown'; }
  hisBinding(): string { const bindings = this.supabase()?.integrations.map((item) => item.observability?.phase).filter(Boolean) || []; return bindings.some((item) => item === 'Bound') ? 'Bound' : 'NotConfigured'; }
  latestChangeLabel(value: ChangeControlState): string { const latest = value.changes[0]; return latest ? `${this.shortId(latest.request_id)} · ${this.changeVerdict(latest)}` : 'No governed change yet'; }
  changeVerdict(change: ChangeRequest): Verdict { if (change.status === 'failed' || change.execution?.last_error || change.outbox?.last_error) return 'Failed'; if (change.status === 'applied' && change.k8s_operation_id) return 'Verified'; if (['committed', 'authorized'].includes(change.status) || /await|pending|queued/i.test(change.execution?.reconciler_status || change.outbox?.status || '')) return 'Awaiting consumer'; return change.status === 'intent' ? 'Attention required' : 'Awaiting consumer'; }

  primaryRisk(): { tone: 'warning' | 'danger'; title: string; detail: string; actionLabel: string; action: () => void } {
    if (this.recoveryVerdict() !== 'Verified') return { tone: 'warning', title: 'Recovery evidence incomplete', detail: this.recoverySummary() + '. 복원 결과와 기대값을 확인해야 합니다.', actionLabel: 'Review evidence', action: () => this.openRecoveryEvidence() };
    if (!this.gitea()?.managementReady) return { tone: 'danger', title: 'Gitea management path unavailable', detail: this.gitea()?.reason || '변경 생성·승인 경로를 사용할 수 없습니다.', actionLabel: 'Open journey', action: () => this.activeTab.set('journey') };
    if (this.hisBinding() !== 'Bound') return { tone: 'warning', title: 'HIS Binding not configured', detail: 'Console은 telemetry를 추정하거나 Prometheus를 생성하지 않습니다.', actionLabel: 'Review binding', action: () => this.activeTab.set('evidence') };
    return { tone: 'warning', title: 'No active platform risk', detail: '현재 읽은 증거 범위에서 즉시 조치가 필요한 항목이 없습니다.', actionLabel: 'Review evidence', action: () => this.activeTab.set('evidence') };
  }
  openRecoveryEvidence(): void { this.evidenceFilter.set('supabase'); this.activeTab.set('evidence'); const row = this.evidenceRows().find((item) => item.verdict !== 'Verified' && /restore|Recovery/i.test(item.source + item.assertion)); if (row) this.selectedEvidenceId.set(row.id); }

  setEvidenceFilter(filter: EvidenceFilter): void { this.evidenceFilter.set(filter); this.selectedEvidenceId.set(''); }
  evidenceCount(filter: EvidenceFilter): number { return filter === 'all' ? this.evidenceRows().length : this.evidenceRows().filter((item) => item.authority === filter).length; }
  evidenceFilterLabel(): string { return this.evidenceFilters.find((item) => item.key === this.evidenceFilter())?.label || 'All evidence'; }
  evidenceNextStep(item: EvidenceRow): string { if (item.verdict === 'Verified') return '근거와 출처를 확인했습니다. 다음 정기 검증 시점까지 보존합니다.'; if (item.verdict === 'Not configured') return '소유 시스템에서 Binding을 제공할 때까지 NotConfigured 상태를 유지합니다.'; if (item.verdict === 'Awaiting consumer') return 'consumer reconciler 등록과 receipt 전달 상태를 확인하세요.'; return `${item.source}에서 ${item.assertion}의 기대값(${item.expected})과 관측값(${item.observed}) 차이를 확인하세요.`; }

  private buildEvidenceRows(): EvidenceRow[] {
    const rows: EvidenceRow[] = [];
    const recovery = this.supabase()?.recovery;
    const units: { key: string; authority: EvidenceFilter; source: string; value?: RecoveryUnit }[] = [
      { key: 'sb-db', authority: 'supabase', source: 'Supabase DB Recovery', value: recovery?.supabase },
      { key: 'sb-storage', authority: 'supabase', source: 'Supabase Storage Recovery', value: recovery?.storage },
      { key: 'gitea-dr', authority: 'gitea', source: 'Gitea Recovery', value: recovery?.gitea },
    ];
    for (const unit of units) {
      const checks = unit.value?.checks || this.assertionChecks(unit.value?.assertions || []);
      checks.forEach((check, index) => rows.push({ id: `${unit.key}-${index + 1}`, authority: unit.authority, source: unit.source, assertion: check.assertion, expected: check.expected, observed: check.observed, time: unit.value?.verifiedAt || recovery?.generatedAt || null, verdict: this.checkVerdict(check, unit.value), detail: `declared ${unit.value?.declaredState || unit.value?.state || 'Unknown'}`, correlation: '' }));
    }
    const policy = this.gitea()?.supplyChain;
    const checkedAt = this.gitea()?.meta.checkedAt || null;
    if (policy) {
      const policyRows: [string, string, string, boolean][] = [
        ['protected-main', 'Protected branch', 'true', policy.protected], ['direct-push', 'Direct push denied', 'true', !policy.directPushEnabled], ['signed-commits', 'Signed commits required', 'true', policy.signedCommitsRequired], ['review-gate', 'Rejected review blocks merge', 'true', policy.blockRejectedReviews],
      ];
      policyRows.forEach(([id, assertion, expected, pass]) => rows.push({ id: `gitea-${id}`, authority: 'gitea', source: 'Gitea Supply Chain', assertion, expected, observed: String(pass), time: checkedAt, verdict: pass ? 'Verified' : 'Failed', detail: `${policy.repository} · ${policy.defaultBranch}`, correlation: '' }));
    }
    for (const contract of this.gitea()?.contracts || []) {
      const phase = contract.observability?.phase || 'NotConfigured';
      rows.push({ id: `runtime-${contract.consumer_id}`, authority: 'runtime', source: 'HIS Binding', assertion: `${contract.display_name || contract.consumer_id} telemetry binding`, expected: 'Bound when HIS provides telemetry', observed: phase, time: contract.observability?.observed_at || null, verdict: phase === 'Bound' ? 'Verified' : 'Not configured', detail: contract.observability?.binding_name || 'Console does not create Prometheus', correlation: contract.consumer_id });
    }
    for (const change of (this.gitea()?.changes || []).slice(0, 10)) {
      rows.push({ id: `change-${change.request_id}`, authority: change.status === 'applied' ? 'runtime' : 'gitea', source: change.status === 'applied' ? 'Kubernetes Receipt' : 'Gitea Change Journey', assertion: `${change.action} ${change.target}`, expected: 'observed receipt', observed: change.execution?.reconciler_status || change.status, time: change.completed_at || change.execution?.updated_at || change.created_at, verdict: this.changeVerdict(change), detail: change.execution?.pull_number ? `PR #${change.execution.pull_number}` : 'PR not created', correlation: change.request_id });
    }
    return rows;
  }
  private assertionChecks(assertions: string[]): RecoveryCheck[] { return assertions.map((assertion) => { const match = assertion.match(/^(.+?)=(.*)$/); const key = match?.[1]?.trim() || assertion; const observed = match?.[2]?.trim() || 'recorded'; const requiresPositive = /^(auth\.users|console\.operator|audit\.event|restored object files|users|repositories)$/i.test(key); const insufficient = requiresPositive && Number(observed) <= 0; return { assertion: key, expected: requiresPositive ? '>=1' : 'recorded', observed, verdict: insufficient ? 'InsufficientEvidence' : 'Verified' }; }); }
  private checkVerdict(check: RecoveryCheck, unit?: RecoveryUnit): Verdict { if (check.verdict === 'Failed') return 'Failed'; if (check.verdict !== 'Verified' || (unit && this.unitNeedsAttention(unit) && !unit.checks?.length)) return 'Attention required'; return 'Verified'; }

  journeyNextAction(): string { const selected = this.selectedChange(); if (!selected) return 'Create the first governed change'; const verdict = this.changeVerdict(selected); if (verdict === 'Failed') return 'Resolve the failed delivery or reconcile step'; if (verdict === 'Awaiting consumer') return 'Register or verify the consumer reconciler'; if (verdict === 'Attention required') return 'Complete the Gitea review and approval gate'; return 'Review observed state and close the evidence loop'; }
  journeyNextDetail(): string { const selected = this.selectedChange(); if (!selected) return '변경을 생성하면 Supabase intent, Gitea PR·서명·승인, outbox와 Kubernetes receipt가 하나의 상관관계로 추적됩니다.'; return this.changeVerdict(selected) === 'Awaiting consumer' ? '서명과 merge가 완료돼도 consumer receipt가 없으면 적용 완료가 아닙니다.' : '현재 단계의 원본 증거와 다음 정책 게이트를 확인하세요.'; }
  laneDescription(lane: JourneyStep['source']): string { return lane === 'Supabase' ? 'data & audit authority' : lane === 'Gitea' ? 'declaration authority' : 'observed runtime truth'; }
  private buildJourneySteps(change: ChangeRequest | null): JourneyStep[] {
    if (!change) return [
      { column: '1', source: 'Supabase', label: 'No request', evidence: 'intent not created', time: null, state: 'current' },
      { column: '3', source: 'Gitea', label: 'Awaiting PR', evidence: 'no declaration', time: null, state: 'waiting' },
      { column: '7', source: 'Kubernetes', label: 'No receipt', evidence: 'not observed', time: null, state: 'waiting' },
    ];
    const approved = change.approvals.some((item) => item.status === 'approved');
    const merged = Boolean(change.execution?.merge_revision || change.git_commit_sha);
    const outboxDone = /sent|delivered|completed/i.test(change.outbox?.status || '');
    const failed = this.changeVerdict(change) === 'Failed';
    return [
      { column: '1', source: 'Supabase', label: 'Request created', evidence: this.shortId(change.request_id), time: change.created_at, state: 'done' },
      { column: '2', source: 'Supabase', label: 'Audit stored', evidence: 'intent correlated', time: change.created_at, state: 'done' },
      { column: '3', source: 'Gitea', label: change.execution?.pull_number ? `Signed PR #${change.execution.pull_number}` : 'Awaiting PR', evidence: this.shortId(change.execution?.desired_revision || ''), time: change.execution?.updated_at || null, state: change.execution?.pull_number ? 'done' : 'current' },
      { column: '4', source: 'Gitea', label: approved ? 'Second approval' : 'Awaiting approval', evidence: `${change.approvals.length}/${this.gitea()?.supplyChain?.requiredApprovals || 1}`, time: change.approvals.at(-1)?.completed_at || null, state: approved ? 'done' : (failed ? 'failed' : 'waiting') },
      { column: '5', source: 'Gitea', label: merged ? 'Merge signed' : 'Awaiting merge', evidence: this.shortId(change.execution?.merge_revision || ''), time: change.execution?.updated_at || null, state: merged ? 'done' : 'waiting' },
      { column: '6', source: 'Kubernetes', label: outboxDone ? 'Webhook delivered' : (change.outbox?.status || 'Outbox not queued'), evidence: `attempts ${change.outbox?.attempts || 0}`, time: change.outbox?.updated_at || null, state: failed ? 'failed' : (outboxDone ? 'done' : 'waiting') },
      { column: '7', source: 'Kubernetes', label: change.status === 'applied' && change.k8s_operation_id ? 'Observed' : (change.execution?.reconciler_status || 'Awaiting consumer'), evidence: change.k8s_operation_id || 'receipt 없음', time: change.completed_at, state: failed ? 'failed' : (change.status === 'applied' && change.k8s_operation_id ? 'done' : 'current') },
    ];
  }
}
