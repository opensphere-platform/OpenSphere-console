import { Component, OnInit, OnDestroy, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { AuthService } from '../core/auth.service';
import { HttpService } from '../core/http.service';

interface MonComponent { key: string; name: string; role: string; installed: boolean; ready: boolean; detail: string; }
interface Coverage { key: string; name: string; namespace: string; serviceMonitor: boolean; metrics: boolean; note: string; }
interface SM { namespace: string; name: string; app: string; }
interface ObsState {
  namespace: string; nsExists: boolean; installed: boolean; ready: boolean;
  components: MonComponent[]; crdReady: boolean; serviceMonitors: SM[]; coverage: Coverage[];
  links: { grafana: string; prometheus: string };
}
interface Target { job: string; instance: string; health: string; lastError: string; scrapeUrl: string; }
interface TargetsResp { reachable: boolean; hint?: string; active?: Target[]; }
interface ChartSeries { label: string; points: string; color: string; }
interface ChartData { series: ChartSeries[]; last: string; }
interface PromRange { metric: Record<string, string>; values: [number, string][]; }
interface StatDef { key: string; title: string; expr: string; kind: string; }
interface ExprDef { expr: string; label?: string; }
interface ChartDef { key: string; title: string; exprs: ExprDef[]; unit?: string; }
interface MetricSection { title: string; stats: StatDef[]; charts: ChartDef[]; }

/**
 * Observability — 공유 관측 스택(prometheus-stack) 정보 뷰. **셸 네이티브** 페이지(Backbone과 형제).
 * 콘솔은 관측 스택의 소유자가 아니라 **대상/소비자**(수평 cross-cutting). 읽기 전용 — 설치/변경 없음.
 * 백엔드 = dupa-registry-controller(/api/admin/observability/{status,targets}, admin 게이트). docs/OBSERVABILITY-ARCHITECTURE.md.
 */
@Component({
  selector: 'os-admin-observability',
  imports: [ClarityModule, BackendUnavailable, OsPageHeader],
  template: `
    <div class="os-page">
      <os-page-header title="Observability" tag="Core·Admin · 공유 관측 스택(정보 뷰)" />
      @if (down(); as d) {
      <os-backend-unavailable
        feature="Observability"
        backend="dupa-registry-controller (/api/admin/observability)"
        hint="dupa-registry-controller 배포 · ClusterRole(servicemonitors get/list) 적용 시 복구됩니다."
        [detail]="d"
      />
    } @else {
      <p class="os-sub">
        공유 관측 인프라 <code>prometheus-stack</code> — 콘솔은 <strong>소유자가 아니라 관측 대상/소비자</strong>입니다(수평 cross-cutting). 설계: <code>docs/OBSERVABILITY-ARCHITECTURE.md</code>.
        @if (state(); as s) { · ns <code>{{ s.namespace }}</code> · {{ s.installed ? '설치됨' : '미설치(ship-but-optional)' }} · {{ s.ready ? '정상' : '준비중' }} }
      </p>

      <clr-tabs>
        <!-- 탭1: 스택 상태 -->
        <clr-tab>
          <button clrTabLink>스택 상태</button>
          <clr-tab-content>
            <div class="os-actions"><button class="btn btn-sm btn-outline" [disabled]="busy()" (click)="refresh()">새로고침</button> @if (busy()) { <span class="spinner spinner-inline"></span> }</div>
            @if (state() && !state()!.nsExists) {
              <clr-alert clrAlertType="warning" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">ns <code>monitoring</code> 미존재 — 관측 스택 미설치. <code>tools/local-dev/install-monitoring.sh</code> (ship-but-optional).</span></clr-alert-item></clr-alert>
            }
            <clr-datagrid>
              <clr-dg-column>구성요소</clr-dg-column>
              <clr-dg-column>역할</clr-dg-column>
              <clr-dg-column>상태</clr-dg-column>
              @for (c of components(); track c.key) {
                <clr-dg-row>
                  <clr-dg-cell><strong>{{ c.name }}</strong></clr-dg-cell>
                  <clr-dg-cell>{{ c.role }}</clr-dg-cell>
                  <clr-dg-cell>
                    @if (c.ready) { <span class="label label-success">{{ c.detail }}</span> }
                    @else if (c.installed) { <span class="label label-warning">{{ c.detail }}</span> }
                    @else { <span class="label">미설치</span> }
                  </clr-dg-cell>
                </clr-dg-row>
              }
              <clr-dg-placeholder>상태 조회 중…</clr-dg-placeholder>
            </clr-datagrid>
            @if (state(); as s) {
              <div class="os-card">
                <div class="os-card-h">딥링크 (in-cluster)</div>
                <p class="os-sub">Grafana: <code>{{ s.links.grafana || '미발견' }}</code> · Prometheus: <code>{{ s.links.prometheus || '미발견' }}</code></p>
                <p class="os-sub">브라우저 접근은 ingress 또는 port-forward가 필요합니다(콘솔은 직접 임베드하지 않음 — CSP/인증은 후속).</p>
              </div>
            }
          </clr-tab-content>
        </clr-tab>

        <!-- 탭2: 계측 커버리지 -->
        <clr-tab>
          <button clrTabLink>계측 커버리지</button>
          <clr-tab-content>
            <p class="os-sub">컴포넌트별 <code>/metrics</code> + ServiceMonitor 유무. 계측층은 <strong>각 컴포넌트 소유</strong>(설계 §3). Backbone 미계측 = 갭.</p>
            @if (state() && !state()!.crdReady) {
              <clr-alert clrAlertType="warning" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">ServiceMonitor CRD(<code>monitoring.coreos.com</code>) 미설치 — 계측 미발견.</span></clr-alert-item></clr-alert>
            }
            <clr-datagrid>
              <clr-dg-column>컴포넌트</clr-dg-column>
              <clr-dg-column>Namespace</clr-dg-column>
              <clr-dg-column>ServiceMonitor</clr-dg-column>
              <clr-dg-column>비고</clr-dg-column>
              @for (c of coverage(); track c.key) {
                <clr-dg-row>
                  <clr-dg-cell>{{ c.name }}</clr-dg-cell>
                  <clr-dg-cell class="os-mono">{{ c.namespace }}</clr-dg-cell>
                  <clr-dg-cell>@if (c.serviceMonitor) { <span class="label label-success">scrape</span> } @else { <span class="label label-warning">없음</span> }</clr-dg-cell>
                  <clr-dg-cell class="os-mono">{{ c.note }}</clr-dg-cell>
                </clr-dg-row>
              }
              <clr-dg-placeholder>대상 없음</clr-dg-placeholder>
            </clr-datagrid>
          </clr-tab-content>
        </clr-tab>

        <!-- 탭3: Scrape 타겟 (Prometheus active targets) -->
        <clr-tab>
          <button clrTabLink (click)="loadTargets()">Scrape 타겟</button>
          <clr-tab-content>
            <p class="os-sub">Prometheus <code>/api/v1/targets</code>(active) — 실제 scrape 헬스. in-cluster 직결(읽기).</p>
            @if (targets(); as t) {
              @if (!t.reachable) { <p class="os-sub">Prometheus 조회 불가: {{ t.hint }}</p> }
              @else {
                <clr-datagrid>
                  <clr-dg-column>Job</clr-dg-column>
                  <clr-dg-column>Instance</clr-dg-column>
                  <clr-dg-column>Health</clr-dg-column>
                  <clr-dg-column>Last error</clr-dg-column>
                  @for (tg of t.active || []; track tg.scrapeUrl) {
                    <clr-dg-row>
                      <clr-dg-cell>{{ tg.job }}</clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ tg.instance }}</clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-success]="tg.health === 'up'" [class.label-danger]="tg.health === 'down'" [class.label-warning]="tg.health !== 'up' && tg.health !== 'down'">{{ tg.health }}</span></clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ tg.lastError }}</clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>활성 타겟 없음</clr-dg-placeholder>
                </clr-datagrid>
              }
            } @else { <p class="os-sub">불러오는 중…</p> }
          </clr-tab-content>
        </clr-tab>

        <!-- 탭4: 메트릭 — 콘솔이 Prometheus를 직접 조회해 값/그래프를 콘솔 안에서 렌더(외부 Grafana 비의존, 의존성0 SVG). -->
        <clr-tab>
          <button clrTabLink (click)="loadMetrics()">메트릭</button>
          <clr-tab-content>
            <div class="os-actions"><button class="btn btn-sm btn-outline" (click)="reloadMetrics()">새로고침</button> <span class="os-sub" style="margin:0">최근 1시간 · 콘솔이 Prometheus 직접 조회·렌더(query_range 프록시)</span></div>
            @if (metricsHint(); as h) { <p class="os-sub">{{ h }}</p> }
            @for (sec of metricSections; track sec.title) {
              <div class="m-section-h">{{ sec.title }}</div>
              <div class="m-stats">
                @for (p of sec.stats; track p.key) {
                  <div class="m-stat"><div class="m-stat-t">{{ p.title }}</div><div class="m-stat-v">{{ statText(p.key, p.kind) }}</div></div>
                }
              </div>
              <div class="m-charts">
                @for (p of sec.charts; track p.key) {
                  <div class="os-card m-chart">
                    <div class="os-card-h">{{ p.title }} @if (charts()[p.key]; as ch) { <span class="m-last">최신 {{ ch.last }}</span> }</div>
                    <div class="m-body">
                      @if (charts()[p.key]; as ch) {
                        @if (ch.series.length) {
                          <svg viewBox="0 0 600 120" preserveAspectRatio="none" class="m-svg">
                            @for (s of ch.series; track s.label) { <polyline [attr.points]="s.points" [attr.stroke]="s.color" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke" /> }
                          </svg>
                          <div class="m-legend">@for (s of ch.series; track s.label) { <span class="m-leg"><i [style.background]="s.color"></i>{{ s.label }}</span> }</div>
                        } @else { <p class="os-sub">데이터 없음</p> }
                      } @else { <p class="os-sub">불러오는 중…</p> }
                    </div>
                  </div>
                }
              </div>
            }
          </clr-tab-content>
        </clr-tab>
      </clr-tabs>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub { color: var(--os-muted); font-size: 0.7rem; margin: 0.3rem 0 0.8rem; }
      .os-mono { font-family: monospace; font-size: 0.62rem; color: var(--os-muted); }
      .os-actions { display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0 1rem; }
      .label { margin: 0 0.25rem 0.25rem 0; }
      /* 서비스 섹션 헤더 — 페이지 위계 구분. */
      .m-section-h { font-size: 0.85rem; font-weight: 600; color: var(--os-ink); margin: 1.2rem 0 0.4rem; padding-bottom: 0.2rem; border-bottom: 2px solid var(--os-accent); display: inline-block; }
      /* stat 타일 — 전역 .os-card 토큰(#fff/#e6e8ec/4px)과 동일 규율의 소형 KPI 타일. */
      .m-stats { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 0.3rem 0 1rem; }
      .m-stat { background: #fff; border: 1px solid #e6e8ec; border-radius: 4px; padding: 0.4rem 0.8rem; min-width: 7rem; }
      .m-stat-t { font-size: 0.6rem; color: var(--os-muted); }
      .m-stat-v { font-size: 1.1rem; font-weight: 600; color: var(--os-ink); }
      /* 차트 패널 = 전역 .os-card/.os-card-h 재사용(그리드라 margin 상쇄) + 본문 패딩. */
      .m-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 0.8rem; }
      .m-chart { margin: 0; }
      .m-body { padding: 0.4rem 0.6rem; }
      .m-last { font-size: 0.6rem; color: var(--os-muted); font-weight: 400; }
      .m-svg { width: 100%; height: 120px; display: block; background: var(--os-surface-1); }
      .m-legend { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 0.2rem; }
      .m-leg { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.58rem; color: var(--os-muted); }
      .m-leg i { width: 0.7rem; height: 0.2rem; display: inline-block; border-radius: 1px; }
    `,
  ],
})
export class AdminObservability implements OnInit, OnDestroy {
  readonly state = signal<ObsState | null>(null);
  readonly components = computed<MonComponent[]>(() => this.state()?.components ?? []);
  readonly coverage = computed<Coverage[]>(() => this.state()?.coverage ?? []);
  readonly targets = signal<TargetsResp | null>(null);
  readonly down = signal<string>('');
  readonly busy = signal<boolean>(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  // 메트릭 탭 — 콘솔이 Prometheus 직접 조회·렌더(외부 Grafana 비의존). 서비스별 섹션 + 다중 expr 차트.
  readonly metricSections: MetricSection[] = [
    {
      title: 'PostgreSQL',
      stats: [
        { key: 'pg_up', title: 'up', expr: 'max(pg_up)', kind: 'updown' },
        { key: 'pg_conn', title: '연결수', expr: 'sum(pg_stat_activity_count)', kind: 'num' },
        { key: 'pg_dbs', title: 'DB 수', expr: 'count(pg_database_size_bytes)', kind: 'num' },
        { key: 'pg_maxconn', title: '최대 연결', expr: 'max(pg_settings_max_connections)', kind: 'num' },
        { key: 'pg_locks', title: '락', expr: 'sum(pg_locks_count)', kind: 'num' },
        { key: 'pg_size', title: '총 DB 크기', expr: 'sum(pg_database_size_bytes)', kind: 'bytes' },
      ],
      charts: [
        { key: 'pg_conn_state', title: '연결수 (상태별)', exprs: [{ expr: 'sum(pg_stat_activity_count) by (state)' }] },
        { key: 'pg_cache', title: 'Cache hit ratio (%)', unit: 'pct', exprs: [{ expr: '100 * sum(rate(pg_stat_database_blks_hit[5m])) / clamp_min(sum(rate(pg_stat_database_blks_hit[5m])) + sum(rate(pg_stat_database_blks_read[5m])), 1)', label: 'hit%' }] },
        { key: 'pg_xact', title: 'Commit / Rollback (/s)', exprs: [{ expr: 'sum(rate(pg_stat_database_xact_commit[5m]))', label: 'commit' }, { expr: 'sum(rate(pg_stat_database_xact_rollback[5m]))', label: 'rollback' }] },
        { key: 'pg_tup', title: 'Tuple ops (/s)', exprs: [{ expr: 'sum(rate(pg_stat_database_tup_inserted[5m]))', label: 'insert' }, { expr: 'sum(rate(pg_stat_database_tup_updated[5m]))', label: 'update' }, { expr: 'sum(rate(pg_stat_database_tup_deleted[5m]))', label: 'delete' }, { expr: 'sum(rate(pg_stat_database_tup_fetched[5m]))', label: 'fetch' }] },
        { key: 'pg_dbsize', title: 'DB 크기 (DB별)', unit: 'bytes', exprs: [{ expr: 'pg_database_size_bytes' }] },
        { key: 'pg_lockmode', title: '락 (mode별)', exprs: [{ expr: 'sum(pg_locks_count) by (mode)' }] },
        { key: 'pg_deadlock', title: 'Deadlocks (/s)', exprs: [{ expr: 'sum(rate(pg_stat_database_deadlocks[5m]))', label: 'deadlocks' }] },
        { key: 'pg_temp', title: 'Temp bytes (/s)', unit: 'bytes', exprs: [{ expr: 'sum(rate(pg_stat_database_temp_bytes[5m]))', label: 'temp' }] },
      ],
    },
    {
      title: 'Gitea',
      stats: [
        { key: 'gt_up', title: 'up', expr: 'max(up{job="backbone-gitea"})', kind: 'updown' },
        { key: 'gt_repos', title: 'repos', expr: 'max(gitea_repositories)', kind: 'num' },
        { key: 'gt_users', title: 'users', expr: 'max(gitea_users)', kind: 'num' },
        { key: 'gt_orgs', title: 'orgs', expr: 'max(gitea_organizations)', kind: 'num' },
        { key: 'gt_issues_open', title: 'issues open', expr: 'max(gitea_issues_open)', kind: 'num' },
        { key: 'gt_releases', title: 'releases', expr: 'max(gitea_releases)', kind: 'num' },
      ],
      charts: [
        { key: 'gt_entities', title: '엔티티 수', exprs: [{ expr: 'max(gitea_repositories)', label: 'repos' }, { expr: 'max(gitea_users)', label: 'users' }, { expr: 'max(gitea_organizations)', label: 'orgs' }, { expr: 'max(gitea_teams)', label: 'teams' }] },
        { key: 'gt_issues', title: '이슈 (open/closed)', exprs: [{ expr: 'max(gitea_issues_open)', label: 'open' }, { expr: 'max(gitea_issues_closed)', label: 'closed' }] },
        { key: 'gt_access', title: 'Accesses (/s)', exprs: [{ expr: 'rate(gitea_accesses[5m])', label: 'accesses' }] },
        { key: 'gt_mem', title: '메모리 RSS', unit: 'bytes', exprs: [{ expr: 'process_resident_memory_bytes{job="backbone-gitea"}', label: 'rss' }] },
      ],
    },
    {
      title: 'RustFS',
      stats: [
        { key: 'rf_up', title: 'up', expr: 'max(rustfs_up)', kind: 'updown' },
        { key: 'rf_bytes', title: '총용량', expr: 'max(rustfs_bytes_total)', kind: 'bytes' },
        { key: 'rf_objects', title: '오브젝트', expr: 'max(rustfs_objects_total)', kind: 'num' },
        { key: 'rf_buckets', title: 'buckets', expr: 'max(rustfs_buckets)', kind: 'num' },
      ],
      charts: [
        { key: 'rf_trend', title: '총 사용량 추이', unit: 'bytes', exprs: [{ expr: 'max(rustfs_bytes_total)', label: 'total' }] },
        { key: 'rf_bucket_bytes', title: '버킷별 사용량', unit: 'bytes', exprs: [{ expr: 'rustfs_bucket_bytes' }] },
        { key: 'rf_bucket_obj', title: '버킷별 오브젝트수', exprs: [{ expr: 'rustfs_bucket_objects' }] },
      ],
    },
  ];
  // 차트 시리즈 색 — 첫 색 = --os-accent(sphere-blue #4c6fff), 이후 Carbon categorical 팔레트.
  // SVG stroke 표현속성은 var() 미해석이라 토큰 값과 동기화된 구체 hex로 둔다.
  private readonly palette = ['#4c6fff', '#24a148', '#ff832b', '#a56eff', '#009d9a', '#fa4d56'];
  readonly statValues = signal<Record<string, number | null>>({});
  readonly charts = signal<Record<string, ChartData>>({});
  readonly metricsHint = signal<string>('');
  private metricsLoaded = false;

  private auth = inject(AuthService);
  private http = inject(HttpService);
  private authGet(): RequestInit {
    return { cache: 'no-store', headers: { authorization: 'Bearer ' + (this.auth.token() || '') } };
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => this.refresh(true), 10000);
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.busy.set(true);
    try {
      const r = await this.http.request('/api/admin/observability/status', this.authGet());
      if (r.status === 401 || r.status === 403) { if (!silent) this.down.set('관리자 권한이 필요합니다 (opensphere-console-admins).'); return; }
      if (!r.ok) { this.down.set(`status HTTP ${r.status}`); return; }
      this.down.set('');
      this.state.set(await r.json());
    } catch (e) { this.down.set('조회 실패: ' + e); }
    finally { this.busy.set(false); }
  }

  async loadTargets(): Promise<void> {
    if (this.targets()) return;
    try {
      const r = await this.http.request('/api/admin/observability/targets', this.authGet());
      if (r.ok) this.targets.set(await r.json());
      else this.targets.set({ reachable: false, hint: `HTTP ${r.status}` });
    } catch (e) { this.targets.set({ reachable: false, hint: String(e) }); }
  }

  async loadMetrics(): Promise<void> { if (this.metricsLoaded) return; this.metricsLoaded = true; await this.fetchMetrics(); }
  async reloadMetrics(): Promise<void> { await this.fetchMetrics(); }

  private allStats(): StatDef[] { return this.metricSections.flatMap((s) => s.stats); }
  private allCharts(): ChartDef[] { return this.metricSections.flatMap((s) => s.charts); }

  private async fetchMetrics(): Promise<void> {
    this.metricsHint.set('');
    // instant stats
    const sv: Record<string, number | null> = {};
    await Promise.all(this.allStats().map(async (p) => {
      try {
        const r = await this.http.request('/api/admin/observability/query?expr=' + encodeURIComponent(p.expr), this.authGet());
        const j = await r.json();
        const raw = j.ok ? j.result?.[0]?.value?.[1] : null;
        sv[p.key] = raw != null ? Number(raw) : null;
        if (!j.ok && !this.metricsHint()) this.metricsHint.set('Prometheus 조회 불가: ' + (j.hint || ''));
      } catch { sv[p.key] = null; }
    }));
    this.statValues.set(sv);
    // range charts — 패널당 다중 expr → 라벨 부여 후 시리즈 병합.
    const ch: Record<string, ChartData> = {};
    await Promise.all(this.allCharts().map(async (p) => {
      try {
        const sets = await Promise.all(p.exprs.map(async (e) => {
          const r = await this.http.request('/api/admin/observability/query_range?expr=' + encodeURIComponent(e.expr) + '&minutes=60&step=60', this.authGet());
          const j = await r.json();
          const result: PromRange[] = j.ok ? j.result : [];
          return result.map((s) => ({ label: this.seriesLabel(e.label, s.metric), values: s.values }));
        }));
        ch[p.key] = this.buildChart(sets.flat(), p.unit);
      } catch { ch[p.key] = { series: [], last: '' }; }
    }));
    this.charts.set(ch);
  }

  private seriesLabel(exprLabel: string | undefined, metric: Record<string, string>): string {
    const dyn = Object.entries(metric || {}).filter(([k]) => k !== '__name__').map(([, v]) => v).join(',');
    if (exprLabel && dyn) return `${exprLabel}·${dyn}`;
    return exprLabel || dyn || 'value';
  }

  /** 라벨 부여 시리즈 → SVG polyline points(600x120). 전 series 공통 스케일, unit별 최신값 포맷. */
  private buildChart(series: { label: string; values: [number, string][] }[], unit?: string): ChartData {
    const W = 600, H = 120, pad = 4;
    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const s of series) for (const [t, vs] of s.values || []) {
      const v = Number(vs); if (!isFinite(v)) continue;
      if (t < tMin) tMin = t; if (t > tMax) tMax = t; if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    if (!isFinite(tMin) || tMax === tMin) return { series: [], last: '' };
    const vRange = vMax - vMin || 1;
    const out: ChartSeries[] = series.map((s, i) => {
      const points = (s.values || []).map(([t, vs]) => {
        const v = Number(vs);
        const x = pad + ((t - tMin) / (tMax - tMin)) * (W - 2 * pad);
        const y = H - pad - ((v - vMin) / vRange) * (H - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return { label: s.label, points, color: this.palette[i % this.palette.length] };
    });
    const lasts = series.map((s) => Number((s.values || []).slice(-1)[0]?.[1])).filter((n) => isFinite(n));
    const ln = lasts.length ? Math.max(...lasts) : NaN;
    const last = !isFinite(ln) ? '' : unit === 'bytes' ? this.fmtBytes(ln) : unit === 'pct' ? ln.toFixed(1) + '%' : String(Math.round(ln * 100) / 100);
    return { series: out, last };
  }

  statText(key: string, kind: string): string {
    const v = this.statValues()[key];
    if (v == null) return '—';
    if (kind === 'updown') return v >= 1 ? 'UP' : 'DOWN';
    if (kind === 'bytes') return this.fmtBytes(v);
    return String(Math.round(v * 100) / 100);
  }
  private fmtBytes(n: number): string {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
}
