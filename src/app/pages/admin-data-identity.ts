import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import ArrowRight16 from '@carbon/icons/es/arrow--right/16';
import CheckmarkFilled16 from '@carbon/icons/es/checkmark--filled/16';
import WarningAltFilled16 from '@carbon/icons/es/warning--alt--filled/16';
import DataBase16 from '@carbon/icons/es/data--base/16';
import Renew16 from '@carbon/icons/es/renew/16';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { CarbonIcon } from '../os/carbon-icon';
import { OsCellDef, OsColumn, OsDatagrid } from '../os/os-datagrid';
import { OsPageHeader } from '../os/os-page-header';

interface SupabaseComponent { key: 'auth' | 'data' | 'storage'; name: string; responsibility: string; ready: boolean; detail: string; }
interface SupabaseBucket { id: string; name: string; public: boolean; file_size_limit: number | null; }
interface RecoveryCheck { assertion: string; expected: string; observed: string; verdict: string; }
interface RecoveryUnit { state: string; declaredState?: string; verifiedAt: string | null; assertions: string[]; checks?: RecoveryCheck[]; evidenceQuality?: string; }
interface RecoveryEvidenceRow {
  id: string;
  domain: string;
  domainState: string;
  verifiedAt: string | null;
  domainStart: boolean;
  assertion: string;
  expected: string;
  observed: string;
  verdict: string;
}
interface Integration {
  consumerId: string; displayName: string; status: string; schemas: string[]; buckets: string[];
  observability: { phase: string; binding: string | null; observedAt: string | null } | null;
}
interface SupabaseStatus {
  meta: { source: string; version: string; checkedAt: string };
  components: SupabaseComponent[]; operators: number; roles: { id: string; code: string; description: string }[];
  auditEvents: number; buckets: SupabaseBucket[];
  database: { authority: string; accessModel: string; rls: { state: string; evidence: string } };
  auth: { authority: string; sessionModel: string; elevatedChange: string };
  integrations: Integration[];
  recovery: { available: boolean; reason?: string; generatedAt?: string | null; supabase?: RecoveryUnit; storage?: RecoveryUnit; gitea?: RecoveryUnit; legacyDecommission?: { approved: boolean; completedAt: string | null } };
}

/**
 * Self-hosted Supabase is the Console's sole Data & Identity authority.
 * This page shows its actual control-plane contract and never substitutes a
 * another storage stack, Prometheus series, or a browser-held privileged credential.
 */
@Component({
  selector: 'os-admin-data-identity',
  imports: [ClarityModule, BackendUnavailable, CarbonIcon, OsPageHeader, OsDatagrid, OsCellDef],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page control-detail-page data-identity-page">
      <os-page-header title="Data & Identity" tag="Supabase · Console authority" />
      @if (down(); as detail) {
        <os-backend-unavailable feature="Supabase Data & Identity" backend="opensphere-console-backend (/api/identity/supabase/status)"
          hint="Supabase Auth·PostgREST·Storage 상태를 복구한 뒤 다시 확인하세요. Console은 Supabase를 단일 Data & Identity 권위로 사용합니다." [detail]="detail" />
      } @else if (status(); as current) {
        <div class="page-lead"><p>Self-hosted Supabase가 Console의 인증, 권한, 상태 데이터, 감사 및 객체 저장 권위입니다. Gitea는 선언형 변경의 Git 정본이며 Supabase를 대체하지 않습니다.</p><div class="page-meta"><span>마지막 확인</span><strong>{{ formatDate(current.meta.checkedAt) }}</strong><button class="icon-button" type="button" aria-label="Supabase 상태 새로고침" [disabled]="busy()" (click)="refresh()"><os-cicon [icon]="icons.renew" [size]="16" /></button></div></div>
        @if (message(); as item) { <clr-alert [clrAlertType]="item.type" [clrAlertClosable]="true" (clrAlertClosedChange)="message.set(null)"><clr-alert-item><span class="alert-text">{{ item.text }}</span></clr-alert-item></clr-alert> }

        <section class="status-rail" aria-label="Supabase 운영 상태">
          <div class="rail-cell"><span>Supabase services</span><strong [class.ok]="ready()" [class.warn]="!ready()"><os-cicon [icon]="ready() ? icons.check : icons.warning" [size]="14" />{{ ready() ? 'Ready' : 'Attention' }}</strong><small>{{ readyCount(current) }}/{{ current.components.length }} runtime probes</small></div>
          <div class="rail-cell"><span>Active identities</span><strong>{{ current.operators }}</strong><small>Console operators</small></div>
          <div class="rail-cell"><span>Role contracts</span><strong>{{ current.roles.length }}</strong><small>RLS evaluated roles</small></div>
          <div class="rail-cell"><span>Audit events</span><strong>{{ current.auditEvents }}</strong><small>현재 조회 범위</small></div>
          <div class="rail-cell"><span>Storage buckets</span><strong>{{ current.buckets.length }}</strong><small>{{ privateBuckets(current) }} private</small></div>
          <div class="rail-cell"><span>Recovery evidence</span><strong [class]="recoveryStatusClass(current)"><os-cicon [icon]="recoveryVerdict(current) === 'Verified' ? icons.check : icons.warning" [size]="14" />{{ recoveryVerdict(current) }}</strong><small>{{ formatDate(current.recovery.generatedAt || null) }}</small></div>
        </section>

        <nav class="workspace-tabs" role="tablist" aria-label="Data & Identity 작업영역">
          <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'overview'" [class.active]="activeTab() === 'overview'" (click)="activeTab.set('overview')"><span>01</span>Overview<small>권위와 서비스 상태</small></button>
          <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'database'" [class.active]="activeTab() === 'database'" (click)="activeTab.set('database')"><span>02</span>Database<small>Postgres · RLS</small></button>
          <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'auth'" [class.active]="activeTab() === 'auth'" (click)="activeTab.set('auth')"><span>03</span>Auth &amp; Access<small>세션과 역할</small></button>
          <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'api'" [class.active]="activeTab() === 'api'" (click)="activeTab.set('api')"><span>04</span>API<small>PostgREST 계약</small></button>
          <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'storage'" [class.active]="activeTab() === 'storage'" (click)="activeTab.set('storage')"><span>05</span>Storage<small>버킷과 보존</small></button>
          <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'security'" [class.active]="activeTab() === 'security'" (click)="activeTab.set('security')"><span>06</span>Security &amp; DR<small>복구·정책 증거</small></button>
          <button type="button" role="tab" [attr.aria-selected]="activeTab() === 'integrations'" [class.active]="activeTab() === 'integrations'" (click)="activeTab.set('integrations')"><span>07</span>Integrations<small>소비자 바인딩</small></button>
        </nav>

        @if (activeTab() === 'overview') {
          <section class="domain-workspace" role="tabpanel" aria-label="Overview"><div class="overview-surface">
              <div class="architecture"><span>Console</span><os-cicon [icon]="icons.arrow" [size]="14" /><span>Supabase Auth</span><os-cicon [icon]="icons.arrow" [size]="14" /><span>PostgREST + RLS</span><os-cicon [icon]="icons.arrow" [size]="14" /><span>Storage + Audit</span><os-cicon [icon]="icons.arrow" [size]="14" /><span>Gitea change history</span></div>
              <os-datagrid [columns]="componentColumns" [rows]="current.components" empty="Supabase 상태 조회 중…">
                <ng-template osCell="name" let-component><strong>{{ component.name }}</strong></ng-template>
                <ng-template osCell="status" let-component><span class="label" [class.label-success]="component.ready" [class.label-warning]="!component.ready">{{ component.ready ? 'Ready' : 'Unavailable' }}</span></ng-template>
                <ng-template osCell="detail" let-component><span class="os-mono">{{ component.detail }}</span></ng-template>
              </os-datagrid>
              <div class="visibility-grid" aria-label="Supabase 가시성 범위"><section><span>Identity boundary</span><strong>{{ current.auth.authority }}</strong><small>{{ current.auth.sessionModel }}</small></section><section><span>Database boundary</span><strong>{{ current.database.authority }}</strong><small>{{ current.database.rls.state }} · {{ current.database.rls.evidence }}</small></section><section><span>Consumer coverage</span><strong>{{ current.integrations.length }} contracts</strong><small>{{ boundIntegrations(current) }} HIS bindings · 나머지는 NotConfigured</small></section></div>
              <p class="os-sub">상태 데이터는 Supabase에서, 선언형 변경 원문·diff·review·commit은 Gitea에서 조회합니다. Kubernetes는 두 시스템의 실제 반영 결과만 보고합니다.</p>
            </div></section>
        }

        @if (activeTab() === 'database') {
          <section class="domain-workspace" role="tabpanel" aria-label="Database">
              <section class="os-card"><div class="os-card-h">{{ current.database.authority }}</div><p>{{ current.database.accessModel }}</p><div class="property"><span>RLS</span><strong class="label label-success">{{ current.database.rls.state }}</strong><small>{{ current.database.rls.evidence }}</small></div></section>
              <p class="os-sub">Console은 PostgREST projection과 RPC 계약만 사용합니다. 서비스 역할 키·데이터베이스 비밀번호·복구 vault 위치는 이 화면이나 브라우저에 노출하지 않습니다.</p>
          </section>
        }

        @if (activeTab() === 'auth') {
          <section class="domain-workspace" role="tabpanel" aria-label="Auth & Access">
              <section class="os-card"><div class="os-card-h">{{ current.auth.authority }}</div><p>{{ current.auth.sessionModel }}</p><div class="property"><span>고위험 변경</span><strong>{{ current.auth.elevatedChange }}</strong></div></section>
              <h2>Console 역할</h2><os-datagrid [columns]="roleColumns" [rows]="current.roles" empty="역할을 불러오는 중…"></os-datagrid>
              <p class="os-sub">권한은 JWT에 임의로 넣지 않습니다. 매 요청에서 <code>console.operator_role</code>와 RLS 정책으로 평가됩니다.</p>
          </section>
        }

        @if (activeTab() === 'api') {
          <section class="domain-workspace" role="tabpanel" aria-label="API">
              <section class="os-card"><div class="os-card-h">Console API boundary</div><p>브라우저는 Console Backend를 통해 Supabase 계약을 사용합니다. Back-end 전용 DB 역할과 Gitea 서비스 토큰은 브라우저·OAA·SubShell에 전달되지 않습니다.</p><div class="property"><span>Data API</span><strong>PostgREST + RLS</strong><small>직접 database superuser 경로 없음</small></div><div class="property"><span>Governed change</span><strong>Console → Gitea PR → reconciler receipt</strong><small>승인·서명·웹훅·outbox 상관관계 보존</small></div></section>
          </section>
        }

        @if (activeTab() === 'storage') {
          <section class="domain-workspace" role="tabpanel" aria-label="Storage">
              <h2>Supabase Storage buckets</h2>
              <os-datagrid [columns]="bucketColumns" [rows]="current.buckets" empty="Storage bucket을 불러오는 중…"><ng-template osCell="public" let-bucket><span class="label" [class.label-warning]="bucket.public" [class.label-success]="!bucket.public">{{ bucket.public ? 'public' : 'private' }}</span></ng-template><ng-template osCell="limit" let-bucket><span class="os-mono">{{ sizeLimit(bucket.file_size_limit) }}</span></ng-template></os-datagrid>
              <p class="os-sub">객체는 bucket 정책으로 경계가 강제됩니다. 변경 선언 원문은 Storage가 아닌 Gitea repository에 보존됩니다.</p>
          </section>
        }

        @if (activeTab() === 'security') {
          <section class="domain-workspace" role="tabpanel" aria-label="Security & DR">
              @if (current.recovery.available) {
                <div class="recovery-overview">
                  @for (unit of recoveryRows(current); track unit.name) { <section><span>{{ unit.name }}</span><strong [class]="recoveryUnitClass(unit.value)">{{ recoveryUnitVerdict(unit.value) }}</strong><small>{{ formatDate(unit.value.verifiedAt) }}</small></section> }
                </div>
                <section class="recovery-evidence" aria-labelledby="recovery-evidence-title">
                  <header>
                    <div><span>Recovery evidence</span><strong id="recovery-evidence-title">Restore assertions</strong></div>
                    <small>{{ recoveryRows(current).length }} domains · {{ recoveryEvidenceRows(current).length }} assertions</small>
                  </header>
                  <div class="evidence-scroll">
                    <div class="evidence-table" role="table" aria-label="Supabase, Storage 및 Gitea 복구 검증 결과">
                      <div class="evidence-head" role="row">
                        <span role="columnheader">Domain</span><span role="columnheader">Assertion</span><span role="columnheader">Expected</span><span role="columnheader">Observed</span><span role="columnheader">Verdict</span>
                      </div>
                      <div class="evidence-body" role="rowgroup">
                        @for (row of recoveryEvidenceRows(current); track row.id) {
                          <div class="evidence-row" [class.domain-start]="row.domainStart" role="row">
                            <div class="evidence-domain" role="cell">
                              @if (row.domainStart) {
                                <strong>{{ row.domain }}</strong>
                                <small [class]="row.domainState === 'Verified' ? 'ok' : 'warn'">{{ row.domainState }} · {{ formatDate(row.verifiedAt) }}</small>
                              }
                            </div>
                            <strong role="cell">{{ row.assertion }}</strong>
                            <span role="cell">{{ row.expected }}</span>
                            <span role="cell">{{ row.observed }}</span>
                            <span class="evidence-verdict" [class.ok]="row.verdict === 'Verified'" [class.warn]="row.verdict !== 'Verified'" role="cell"><os-cicon [icon]="row.verdict === 'Verified' ? icons.check : icons.warning" [size]="14" />{{ row.verdict }}</span>
                          </div>
                        }
                      </div>
                    </div>
                  </div>
                  <footer><span>Legacy cleanup</span><strong>{{ current.recovery.legacyDecommission?.approved ? 'Approved · ' + formatDate(current.recovery.legacyDecommission?.completedAt) : 'Not recorded' }}</strong></footer>
                </section>
              } @else { <clr-alert clrAlertType="warning" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">복구 증거를 읽을 수 없습니다: {{ current.recovery.reason || 'unknown' }}</span></clr-alert-item></clr-alert> }
          </section>
        }

        @if (activeTab() === 'integrations') {
          <section class="domain-workspace" role="tabpanel" aria-label="Integrations">
              <os-datagrid [columns]="integrationColumns" [rows]="current.integrations" empty="등록된 Console consumer contract가 없습니다.">
                <ng-template osCell="consumer" let-item><strong>{{ item.displayName || item.consumerId }}</strong><small class="os-mono">{{ item.consumerId }}</small></ng-template>
                <ng-template osCell="data" let-item><span>{{ join(item.schemas) || '—' }}</span><small>{{ join(item.buckets) || 'Storage 미사용' }}</small></ng-template>
                <ng-template osCell="binding" let-item><span class="label" [class.label-success]="item.observability?.phase === 'Bound'" [class.label-warning]="item.observability?.phase !== 'Bound'">{{ item.observability?.phase || 'NotConfigured' }}</span><small>{{ item.observability?.binding || 'HIS Binding 없음' }}</small></ng-template>
              </os-datagrid>
              <p class="os-sub">HIS Binding이 <strong>Bound</strong>일 때만 telemetry freshness를 Console에 표시합니다. Binding이 없으면 Console이 Prometheus를 새로 만들거나 metric을 추정하지 않고 <strong>NotConfigured</strong>으로 반응합니다.</p>
          </section>
        }
      }
    </div>
  `,
  styles: [`
    .visibility-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:.75rem 0;border:1px solid var(--os-hairline);background:var(--os-canvas)}.visibility-grid section{display:grid;gap:.22rem;padding:.75rem;border-right:1px solid var(--os-hairline)}.visibility-grid section:last-child{border-right:0}.visibility-grid span,.visibility-grid small{color:var(--os-ink-muted);font-size:.6rem}.visibility-grid strong{font-size:.72rem}.recovery-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:.75rem 0 .6rem;border:1px solid var(--os-hairline);background:var(--os-canvas)}.recovery-overview section{display:grid;gap:.16rem;padding:.62rem .72rem;border-right:1px solid var(--os-hairline)}.recovery-overview section:last-child{border-right:0}.recovery-overview span,.recovery-overview small{color:var(--os-ink-muted);font-size:.58rem}.recovery-overview strong{font-size:.72rem}.recovery-evidence{border:1px solid var(--os-hairline);background:var(--os-canvas)}.recovery-evidence>header{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:3.1rem;padding:.55rem .72rem;border-bottom:1px solid var(--os-hairline);background:var(--os-surface-1)}.recovery-evidence>header>div{display:grid;gap:.08rem}.recovery-evidence>header span,.recovery-evidence>header small{color:var(--os-ink-muted);font-size:.56rem}.recovery-evidence>header strong{color:var(--os-ink);font-size:.78rem;font-weight:600}.evidence-scroll{overflow-x:auto}.evidence-table{min-width:62rem}.evidence-head,.evidence-row{display:grid;grid-template-columns:minmax(11rem,1.05fr) minmax(14rem,1.45fr) minmax(6rem,.55fr) minmax(6rem,.55fr) minmax(10rem,.85fr)}.evidence-head{min-height:1.9rem;border-bottom:1px solid var(--os-hairline);background:var(--os-surface-1);color:var(--os-ink-muted);font-size:.56rem;font-weight:600}.evidence-head span,.evidence-row>[role='cell']{display:flex;align-items:center;min-width:0;padding:.35rem .62rem;border-right:1px solid var(--os-hairline)}.evidence-head span:last-child,.evidence-row>[role='cell']:last-child{border-right:0}.evidence-row{min-height:2.3rem;border-bottom:1px solid var(--os-hairline);font-size:.63rem}.evidence-row:last-child{border-bottom:0}.evidence-row.domain-start{border-top:1px solid #c7ccd4}.evidence-body .evidence-row:first-child{border-top:0}.evidence-row>strong{font-weight:600;overflow-wrap:anywhere}.evidence-domain{display:grid!important;align-content:center!important;gap:.08rem;background:var(--os-surface-1)}.evidence-domain strong{font-size:.63rem}.evidence-domain small{overflow:hidden;font-size:.53rem;text-overflow:ellipsis;white-space:nowrap}.evidence-verdict{gap:.28rem;font-weight:600;white-space:nowrap}.recovery-evidence>footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:2.15rem;padding:.4rem .72rem;border-top:1px solid var(--os-hairline);background:var(--os-surface-1);font-size:.58rem}.recovery-evidence>footer span{color:var(--os-ink-muted)}.recovery-evidence>footer strong{font-size:.6rem}.status-label{display:inline-flex;align-items:center;gap:.25rem}.ok{color:var(--os-success)!important}.warn{color:#a15c00!important}.danger{color:var(--os-danger)!important}
    .os-sub { color:var(--os-ink-muted); font-size:.72rem; margin:.3rem 0 .9rem; } .os-mono { font-family:monospace; font-size:.64rem; color:var(--os-ink-muted); }
    .summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.75rem; margin:.8rem 0 1rem; } .summary-grid section { display:grid; gap:.25rem; padding:1rem; border:1px solid var(--os-border); background:var(--os-surface-raised); } .summary-grid span,.summary-grid small,small { color:var(--os-muted); font-size:.64rem; } .summary-grid strong { color:var(--os-accent); font-size:1.05rem; overflow-wrap:anywhere; }
    .architecture { display:flex; flex-wrap:wrap; gap:.45rem; align-items:center; margin:.8rem 0; padding:.8rem 1rem; background:var(--os-surface-raised); border:1px solid var(--os-border); font-size:.75rem; } .architecture span { padding:.28rem .5rem; background:#e8f0ff; color:#164a9b; border-radius:.2rem; font-weight:600; } .architecture b { color:var(--os-muted); }
    .os-card { margin:.85rem 0; padding:.8rem 1rem; border:1px solid var(--os-border); background:var(--os-surface-raised); } .os-card-h { margin:-.8rem -1rem .7rem; padding:.55rem .8rem; border-bottom:1px solid var(--os-border); font-weight:600; font-size:.8rem; } .os-card p { font-size:.75rem; margin:.45rem 0; } .property { display:grid; grid-template-columns:9rem minmax(0,1fr); gap:.35rem .75rem; margin:.6rem 0; font-size:.72rem; } .property small { grid-column:2; } h2 { margin:1rem 0 .5rem; font-size:.9rem; } ul { margin:.35rem 0; padding-left:1.2rem; } li { margin:.25rem 0; } clr-dg-cell { display:grid; gap:.18rem; }
    @media (max-width:64rem) { .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } } @media (max-width:48rem) { .summary-grid,.visibility-grid,.recovery-overview { grid-template-columns:1fr; }.visibility-grid section,.recovery-overview section{border-right:0;border-bottom:1px solid var(--os-hairline)}.recovery-overview section:last-child{border-bottom:0}.property { grid-template-columns:1fr; } .property small { grid-column:1; }.recovery-evidence>header{align-items:flex-start}.recovery-evidence>header small{text-align:right} }
  `],
})
export class AdminDataIdentity implements OnInit, OnDestroy {
  readonly icons = { arrow: ArrowRight16, check: CheckmarkFilled16, warning: WarningAltFilled16, database: DataBase16, renew: Renew16 };
  readonly activeTab = signal<'overview' | 'database' | 'auth' | 'api' | 'storage' | 'security' | 'integrations'>('overview');
  readonly componentColumns: OsColumn[] = [{ key: 'name', label: 'Supabase 서비스' }, { key: 'responsibility', label: 'Console 책임' }, { key: 'status', label: '상태' }, { key: 'detail', label: '증거' }];
  readonly roleColumns: OsColumn[] = [{ key: 'code', label: '역할' }, { key: 'description', label: '설명' }];
  readonly bucketColumns: OsColumn[] = [{ key: 'name', label: 'Bucket' }, { key: 'public', label: '공개 범위' }, { key: 'limit', label: '파일 한도' }];
  readonly integrationColumns: OsColumn[] = [{ key: 'consumer', label: 'Consumer' }, { key: 'status', label: '계약 상태' }, { key: 'data', label: 'Supabase 경계' }, { key: 'binding', label: 'HIS Binding' }];
  readonly status = signal<SupabaseStatus | null>(null); readonly down = signal(''); readonly busy = signal(false); readonly message = signal<{ type: 'danger' | 'info'; text: string } | null>(null);
  readonly ready = computed(() => this.status()?.components.every((component) => component.ready) ?? false);
  private readonly http = inject(HttpService); private timer: ReturnType<typeof setInterval> | null = null;
  async ngOnInit(): Promise<void> { await this.refresh(); this.timer = setInterval(() => void this.refresh(true), 15_000); }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }
  readyCount(value: SupabaseStatus): number { return value.components.filter((component) => component.ready).length; }
  privateBuckets(value: SupabaseStatus): number { return value.buckets.filter((bucket) => !bucket.public).length; }
  boundIntegrations(value: SupabaseStatus): number { return value.integrations.filter((item) => item.observability?.phase === 'Bound').length; }
  sizeLimit(bytes: number | null): string { return !bytes ? 'unlimited' : `${Math.round(bytes / 1024 / 1024)} MiB`; }
  join(value: string[] | null | undefined): string { return (value || []).join(', '); }
  formatDate(value: string | null | undefined): string { if (!value) return '검증 시각 없음'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) + ' KST'; }
  recoveryUnitVerdict(unit: RecoveryUnit): string { if (/attention|insufficient|failed|unknown/i.test(unit.state)) return 'Attention required'; if (unit.checks?.some((check) => check.verdict !== 'Verified')) return 'Attention required'; if (unit.assertions.some((assertion) => /^(restored object files|users|repositories)=0$/i.test(assertion.trim()))) return 'Attention required'; return unit.state === 'Verified' ? 'Verified' : unit.state; }
  recoveryUnitClass(unit: RecoveryUnit): string { const verdict = this.recoveryUnitVerdict(unit); return verdict === 'Verified' ? 'status-label ok' : (/failed/i.test(verdict) ? 'status-label danger' : 'status-label warn'); }
  recoveryVerdict(value: SupabaseStatus): string { if (!value.recovery.available) return 'Attention required'; return this.recoveryRows(value).every((row) => this.recoveryUnitVerdict(row.value) === 'Verified') ? 'Verified' : 'Attention required'; }
  recoveryStatusClass(value: SupabaseStatus): string { return this.recoveryVerdict(value) === 'Verified' ? 'status-label ok' : 'status-label warn'; }
  recoveryRows(value: SupabaseStatus): { name: string; value: RecoveryUnit }[] { const recovery = value.recovery; return [{ name: 'Supabase database', value: recovery.supabase || { state: 'Unknown', verifiedAt: null, assertions: [] } }, { name: 'Storage', value: recovery.storage || { state: 'Unknown', verifiedAt: null, assertions: [] } }, { name: 'Gitea change authority', value: recovery.gitea || { state: 'Unknown', verifiedAt: null, assertions: [] } }]; }
  recoveryEvidenceRows(value: SupabaseStatus): RecoveryEvidenceRow[] {
    return this.recoveryRows(value).flatMap(({ name, value: unit }) => {
      const checks: RecoveryCheck[] = unit.checks?.length
        ? unit.checks
        : unit.assertions.length
          ? unit.assertions.map((assertion) => ({ assertion, expected: 'Recorded evidence', observed: 'Recorded', verdict: this.recoveryUnitVerdict(unit) }))
          : [{ assertion: 'Recovery assertion recorded', expected: 'Recorded evidence', observed: 'None', verdict: 'Insufficient evidence' }];
      return checks.map((check, index) => ({
        id: `${name}:${check.assertion}:${index}`,
        domain: name,
        domainState: this.recoveryUnitVerdict(unit),
        verifiedAt: unit.verifiedAt,
        domainStart: index === 0,
        assertion: check.assertion,
        expected: check.expected,
        observed: check.observed,
        verdict: check.verdict === 'Verified' ? 'Verified' : 'Insufficient evidence',
      }));
    });
  }
  async refresh(silent = false): Promise<void> { if (!silent) this.busy.set(true); try { const response = await this.http.request('/api/identity/supabase/status', { cache: 'no-store' }); if (response.status === 401) { this.message.set({ type: 'danger', text: 'Console 세션을 다시 확인하세요.' }); return; } if (response.status === 403) { this.message.set({ type: 'danger', text: 'Supabase 기반 관리 상태는 console-admins 역할만 볼 수 있습니다.' }); return; } if (!response.ok) { this.down.set(`Supabase status HTTP ${response.status}`); return; } this.status.set(await response.json() as SupabaseStatus); this.down.set(''); } catch (error) { this.down.set(`Supabase 상태 조회 실패: ${String(error)}`); } finally { if (!silent) this.busy.set(false); } }
}
