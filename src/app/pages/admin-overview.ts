import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import {
  ChartTabularData,
  ChartTheme,
  DonutChartComponent,
  DonutChartOptions,
  LegendPositions,
  LineChartComponent,
  LineChartOptions,
  ScaleTypes,
} from '@carbon/charts-angular';
import { HttpService } from '../core/http.service';
import { OsPageHeader } from '../os/os-page-header';

type OverviewState = 'Healthy' | 'Degraded' | 'Unavailable' | 'Stale' | 'NotConfigured';
type NodeState = 'Healthy' | 'Degraded' | 'Unavailable';

interface BbssOverview {
  generatedAt: string;
  overall: {
    state: string;
    runtimeAvailability: string;
    resilience: string;
    applicationTelemetry: string;
  };
  summary: { services: number; healthy: number; attention: number; unavailable: number };
  services: Array<{ id: string; name: string; state: string }>;
}

interface OverviewNode {
  controlCenterId: string;
  hostId: string;
  displayName: string;
  hostname: string | null;
  state: NodeState;
  reasons: string[];
  reportState: string;
  snapshotAgeSeconds: number | null;
  collectedAt: string | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  failedUnitCount: number | null;
  degradedKeys: string[];
  metric: {
    configured: boolean;
    bound: boolean;
    state: string;
    latestAgeSeconds: number | null;
  };
}

interface AdminOverviewStatus {
  schemaVersion: 'rcc.admin.overview/v1';
  generatedAt: string;
  thresholds: {
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
  };
  fleet: {
    observed: number;
    healthy: number;
    attention: number;
    offline: number;
    healthyPercent: number | null;
    truncated: boolean;
    limit: number;
  };
  nodes: OverviewNode[];
  trend: {
    source: string;
    range: '24h';
    state: OverviewState;
    detail: string;
    resolutionSeconds: number | null;
    gapCount: number;
    boundHostCount: number;
    observedHostCount: number;
    fleetHostCount: number;
    truncated: boolean;
    points: Array<{
      timestamp: string;
      cpuPercent: number | null;
      memoryPercent: number | null;
      contributingHosts: number;
      gapBefore: boolean;
    }>;
  };
  sources: {
    hostAuthority: { state: OverviewState; detail: string };
    beszel: { state: OverviewState; detail: string };
  };
}

/**
 * `/manage` live index.
 *
 * Current fleet availability is derived from the latest signed host snapshots
 * in Supabase. The 24-hour resource trend is read from Beszel through the RCC
 * backend's verified readonly account. Missing evidence remains missing; the
 * page never substitutes a sample value or a synthetic zero.
 */
@Component({
  selector: 'os-admin-overview',
  imports: [RouterLink, ClarityModule, DonutChartComponent, LineChartComponent, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="os-page manage-overview">
      <os-page-header title="개요" tag="Host authority · Live">
        <p>RCC가 실제로 수신한 호스트 상태와 Beszel 24시간 시계열을 한 화면에서 요약합니다.</p>
      </os-page-header>

      <div class="page-lead">
        <div>
          <strong>운영 데이터</strong>
          <p>
            노드 가용성은 서명된 RCC Agent 스냅샷, 자원 추이는 Beszel readonly 시계열을 사용합니다.
          </p>
        </div>
        <div class="page-meta">
          <span>자동 갱신 30초</span>
          <strong>{{ overview() ? formatDate(overview()!.generatedAt) : '조회 중' }}</strong>
          <button
            class="btn btn-sm btn-outline"
            type="button"
            [disabled]="busy()"
            (click)="refresh()"
          >
            새로고침
          </button>
        </div>
      </div>

      @if (bbss(); as current) {
        <section class="bbss-live" aria-labelledby="bbss-overview-title">
          <div class="bbss-live-header">
            <div>
              <span>LIVE FOUNDATION</span>
              <h2 id="bbss-overview-title">Backbone Service Stack</h2>
              <p>Supabase · Gitea · Beszel 현재 가용성</p>
            </div>
            <span [class]="bbssStateClass(current.overall.state)">{{
              stateLabel(current.overall.state)
            }}</span>
          </div>
          <div class="bbss-live-grid">
            <div>
              <span>현재 가용성</span
              ><strong [class]="bbssTone(current.overall.runtimeAvailability)">{{
                stateLabel(current.overall.runtimeAvailability)
              }}</strong>
            </div>
            <div>
              <span>정상 서비스</span
              ><strong>{{ current.summary.healthy }}/{{ current.summary.services }}</strong>
            </div>
            <div>
              <span>운영 복원력</span
              ><strong [class]="bbssTone(current.overall.resilience)">{{
                stateLabel(current.overall.resilience)
              }}</strong>
            </div>
            <div>
              <span>업무 시계열</span
              ><strong [class]="bbssTone(current.overall.applicationTelemetry)">{{
                stateLabel(current.overall.applicationTelemetry)
              }}</strong>
            </div>
          </div>
          <div class="bbss-live-footer">
            <div class="bbss-service-states">
              @for (service of current.services; track service.id) {
                <span
                  ><i [class]="bbssDot(service.state)" aria-hidden="true"></i>{{ service.name }} ·
                  {{ stateLabel(service.state) }}</span
                >
              }
            </div>
            <a class="btn btn-sm btn-primary" routerLink="/manage/bbss">BBSS 가용성 열기</a>
          </div>
        </section>
      } @else if (bbssError()) {
        <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
          <clr-alert-item
            ><span class="alert-text"
              >BBSS 실시간 요약을 불러오지 못했습니다.
              <a routerLink="/manage/bbss">상세 상태 확인</a></span
            ></clr-alert-item
          >
        </clr-alert>
      }

      @if (overviewError()) {
        <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              {{ overviewError() }}
              @if (overview()) {
                마지막으로 성공한 실제 데이터를 유지합니다.
              }
            </span>
          </clr-alert-item>
        </clr-alert>
      }

      @if (overview(); as current) {
        <section class="source-strip" aria-label="운영 데이터 원천">
          <div>
            <span
              [class]="sourceDot(current.sources.hostAuthority.state)"
              aria-hidden="true"
            ></span>
            <p><strong>호스트 권위</strong>{{ current.sources.hostAuthority.detail }}</p>
          </div>
          <div>
            <span [class]="sourceDot(current.sources.beszel.state)" aria-hidden="true"></span>
            <p><strong>Beszel 시계열</strong>{{ current.sources.beszel.detail }}</p>
          </div>
        </section>

        <section class="summary-grid" aria-label="실제 노드 상태 요약">
          <article class="summary-card">
            <span>관측 노드</span>
            <strong>{{ current.fleet.observed }}{{ current.fleet.truncated ? '+' : '' }}</strong>
            <small>Supabase host authority 등록 대상</small>
          </article>
          <article class="summary-card">
            <span>정상</span>
            <strong class="status-ok">{{ current.fleet.healthy }}</strong>
            <small>Fresh · {{ formatPercent(current.fleet.healthyPercent) }}</small>
          </article>
          <article class="summary-card">
            <span>주의</span>
            <strong class="status-warn">{{ current.fleet.attention }}</strong>
            <small>수집 저하·임계치·systemd 근거</small>
          </article>
          <article class="summary-card">
            <span>오프라인</span>
            <strong class="status-danger">{{ current.fleet.offline }}</strong>
            <small>서명 스냅샷 10분 초과 또는 미보고</small>
          </article>
        </section>

        <section class="chart-grid" aria-label="실제 노드 상태 차트">
          <article class="overview-card availability-card">
            <div class="card-heading">
              <div>
                <h2>노드 가용성</h2>
                <p>현재 서명 스냅샷과 진단 근거의 상태 분포</p>
              </div>
              <span class="live-chip">LIVE</span>
            </div>
            @if (availabilityData().length) {
              <div class="chart-frame donut-frame">
                <ibm-donut-chart [data]="availabilityData()" [options]="availabilityOptions()" />
              </div>
            } @else {
              <div class="empty-state">등록된 관측 노드가 없습니다.</div>
            }
          </article>

          <article class="overview-card trend-card">
            <div class="card-heading">
              <div>
                <h2>자원 사용률 추이</h2>
                <p>최근 24시간 · Beszel이 확인한 호스트 평균</p>
              </div>
              <div class="chart-evidence">
                <span [class]="statePill(current.trend.state)">{{
                  stateLabel(current.trend.state)
                }}</span>
                <small
                  >{{ current.trend.observedHostCount }}/{{ current.trend.fleetHostCount }} 호스트
                  coverage · gap {{ current.trend.gapCount }}</small
                >
              </div>
            </div>
            @if (resourceData().length) {
              <div class="chart-frame line-frame">
                <ibm-line-chart [data]="resourceData()" [options]="resourceOptions()" />
              </div>
            } @else {
              <div class="empty-state">
                <strong>24시간 시계열이 없습니다.</strong>
                <span>{{ current.trend.detail }}</span>
              </div>
            }
          </article>
        </section>

        <section class="overview-card node-table-card" aria-labelledby="node-status-title">
          <div class="card-heading">
            <div>
              <h2 id="node-status-title">주의가 필요한 노드</h2>
              <p>오프라인·수집 저하·systemd 실패·자원 임계치의 실제 근거</p>
            </div>
            <a class="btn btn-sm btn-link" routerLink="/cc/cc2/hosts">Linux 호스트 열기</a>
          </div>
          @if (attentionNodes().length) {
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>노드</th>
                    <th>상태</th>
                    <th>CPU</th>
                    <th>메모리</th>
                    <th>디스크</th>
                    <th>최근 수집</th>
                    <th>근거</th>
                  </tr>
                </thead>
                <tbody>
                  @for (node of attentionNodes(); track node.controlCenterId + '/' + node.hostId) {
                    <tr>
                      <td>
                        <strong>{{ node.displayName }}</strong>
                        <small>{{ node.controlCenterId }}/{{ node.hostId }}</small>
                      </td>
                      <td>
                        <span [class]="nodeStateClass(node.state)">{{
                          stateLabel(node.state)
                        }}</span>
                      </td>
                      <td>{{ formatPercent(node.cpuPercent) }}</td>
                      <td>{{ formatPercent(node.memoryPercent) }}</td>
                      <td>{{ formatPercent(node.diskPercent) }}</td>
                      <td>{{ formatAge(node.snapshotAgeSeconds) }}</td>
                      <td class="reason-cell">
                        {{ node.reasons.join(' · ') || '추가 근거 없음' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="empty-state">
              <strong>현재 주의가 필요한 노드가 없습니다.</strong>
              <span>서명 스냅샷과 수집 가능한 Beszel 지표가 모두 기준 안에 있습니다.</span>
            </div>
          }
        </section>

        <p class="threshold-note">
          주의 기준: CPU {{ current.thresholds.cpuPercent }}% · 메모리
          {{ current.thresholds.memoryPercent }}% · 루트 디스크
          {{ current.thresholds.diskPercent }}%. 미수집 값은 0이 아니라 — 로 표시합니다.
        </p>
      } @else if (busy()) {
        <div class="loading-state" aria-live="polite">
          <span class="spinner spinner-sm"></span> 실제 운영 데이터를 조회하고 있습니다.
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .manage-overview {
        max-width: 92rem;
      }
      .page-lead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        margin: 0.85rem 0;
      }
      .page-lead > div:first-child {
        display: grid;
        gap: 0.2rem;
      }
      .page-lead strong {
        font-size: 0.78rem;
      }
      .page-lead p {
        margin: 0;
        color: var(--os-ink-muted);
        font-size: 0.68rem;
      }
      .page-meta {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 0.5rem;
        color: var(--os-ink-muted);
        font-size: 0.62rem;
      }
      .page-meta strong {
        color: var(--os-ink);
        font-size: 0.66rem;
      }
      .bbss-live {
        margin: 1rem 0;
        border: 1px solid var(--os-hairline);
        background: #fff;
      }
      .bbss-live-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.8rem 1rem;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
      }
      .bbss-live-header > div > span {
        color: var(--os-accent);
        font-size: 0.55rem;
        font-weight: 700;
        letter-spacing: 0.08em;
      }
      .bbss-live h2 {
        margin: 0.12rem 0 0;
        font-size: 0.92rem;
      }
      .bbss-live-header p {
        margin: 0.18rem 0 0;
        color: var(--os-ink-muted);
        font-size: 0.66rem;
      }
      .bbss-state,
      .state-pill {
        display: inline-flex;
        align-items: center;
        padding: 0.14rem 0.5rem;
        border-radius: 1rem;
        font-size: 0.62rem;
        font-weight: 700;
        white-space: nowrap;
      }
      .bbss-state.ok,
      .state-pill.ok {
        color: #0e6027;
        background: #defbe6;
      }
      .bbss-state.warn,
      .state-pill.warn {
        color: #7a4d00;
        background: #fff3c4;
      }
      .bbss-state.danger,
      .state-pill.danger {
        color: #a2191f;
        background: #fff1f1;
      }
      .bbss-state.neutral,
      .state-pill.neutral {
        color: #525252;
        background: #e8e8e8;
      }
      .bbss-live-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .bbss-live-grid div {
        display: grid;
        gap: 0.15rem;
        padding: 0.65rem 1rem;
        border-right: 1px solid var(--os-hairline);
      }
      .bbss-live-grid div:last-child {
        border-right: 0;
      }
      .bbss-live-grid span {
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .bbss-live-grid strong {
        font-size: 0.8rem;
      }
      .bbss-live-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.55rem 1rem;
        border-top: 1px solid var(--os-hairline);
      }
      .bbss-service-states {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .bbss-service-states span {
        display: inline-flex;
        align-items: center;
        gap: 0.28rem;
      }
      .bbss-dot,
      .source-dot {
        width: 0.48rem;
        height: 0.48rem;
        border-radius: 50%;
        background: #8d8d8d;
      }
      .bbss-dot.ok,
      .source-dot.ok {
        background: #24a148;
      }
      .bbss-dot.warn,
      .source-dot.warn {
        background: #f1c21b;
      }
      .bbss-dot.danger,
      .source-dot.danger {
        background: #da1e28;
      }
      .bbss-ok {
        color: #168342 !important;
      }
      .bbss-warn {
        color: #a15c00 !important;
      }
      .bbss-danger {
        color: #c21d38 !important;
      }
      .bbss-neutral {
        color: var(--os-ink-muted) !important;
      }
      .source-strip {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin: 1rem 0;
        border: 1px solid var(--os-hairline);
        background: #fff;
      }
      .source-strip > div {
        display: grid;
        grid-template-columns: 0.55rem 1fr;
        align-items: center;
        gap: 0.55rem;
        padding: 0.65rem 0.85rem;
      }
      .source-strip > div + div {
        border-left: 1px solid var(--os-hairline);
      }
      .source-strip p {
        display: grid;
        gap: 0.1rem;
        margin: 0;
        color: var(--os-ink-muted);
        font-size: 0.64rem;
      }
      .source-strip strong {
        color: var(--os-ink);
        font-size: 0.68rem;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.75rem;
        margin: 1rem 0;
      }
      .summary-card {
        min-width: 0;
        padding: 1rem 1.1rem;
        border: 1px solid var(--os-hairline);
        background: #fff;
      }
      .summary-card span,
      .summary-card small {
        display: block;
        color: var(--os-ink-muted);
      }
      .summary-card span {
        font-size: 0.76rem;
        font-weight: 600;
      }
      .summary-card strong {
        display: block;
        margin: 0.35rem 0 0.15rem;
        color: var(--os-ink);
        font-size: 1.75rem;
        font-weight: 400;
      }
      .summary-card small {
        font-size: 0.7rem;
      }
      .summary-card .status-ok {
        color: #168342;
      }
      .summary-card .status-warn {
        color: #a15c00;
      }
      .summary-card .status-danger {
        color: #c21d38;
      }
      .chart-grid {
        display: grid;
        grid-template-columns: minmax(21rem, 0.8fr) minmax(30rem, 1.6fr);
        gap: 0.75rem;
      }
      .overview-card {
        min-width: 0;
        border: 1px solid var(--os-hairline);
        background: #fff;
      }
      .card-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.85rem 1rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .card-heading h2 {
        margin: 0;
        color: var(--os-ink);
        font-size: 0.9rem;
        font-weight: 600;
      }
      .card-heading p {
        margin: 0.18rem 0 0;
        color: var(--os-ink-muted);
        font-size: 0.7rem;
      }
      .live-chip {
        padding: 0.15rem 0.45rem;
        color: #0e6027;
        border: 1px solid #24a148;
        font-size: 0.6rem;
        font-weight: 700;
        letter-spacing: 0.08em;
      }
      .chart-evidence {
        display: grid;
        justify-items: end;
        gap: 0.2rem;
        color: var(--os-ink-muted);
        font-size: 0.6rem;
        text-align: right;
      }
      .chart-frame {
        min-height: 17rem;
        padding: 0.65rem;
      }
      .chart-frame ibm-donut-chart,
      .chart-frame ibm-line-chart {
        display: block;
        width: 100%;
      }
      .donut-frame {
        display: grid;
        align-items: center;
      }
      .empty-state {
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 0.3rem;
        min-height: 17rem;
        padding: 1.5rem;
        color: var(--os-ink-muted);
        font-size: 0.7rem;
        text-align: center;
      }
      .empty-state strong {
        color: var(--os-ink);
        font-size: 0.76rem;
      }
      .node-table-card {
        margin-top: 0.75rem;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 0.7rem 1rem;
        border-bottom: 1px solid var(--os-hairline);
        text-align: left;
        white-space: nowrap;
        font-size: 0.72rem;
        vertical-align: top;
      }
      th {
        color: var(--os-ink-muted);
        background: var(--os-surface-2);
        font-weight: 600;
      }
      td {
        color: var(--os-ink);
      }
      tbody tr:last-child td {
        border-bottom: 0;
      }
      td small {
        display: block;
        margin-top: 0.12rem;
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .reason-cell {
        min-width: 18rem;
        max-width: 32rem;
        white-space: normal;
        line-height: 1.45;
      }
      .state {
        display: inline-block;
        padding: 0.12rem 0.5rem;
        border-radius: 1rem;
        font-size: 0.66rem;
        font-weight: 600;
      }
      .state-ok {
        color: #0e6027;
        background: #defbe6;
      }
      .state-warn {
        color: #7a4d00;
        background: #fff3c4;
      }
      .state-danger {
        color: #a2191f;
        background: #fff1f1;
      }
      .threshold-note {
        margin: 0.65rem 0 0;
        color: var(--os-ink-muted);
        font-size: 0.62rem;
      }
      .loading-state {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        min-height: 12rem;
        color: var(--os-ink-muted);
        font-size: 0.72rem;
      }
      @media (max-width: 72rem) {
        .bbss-live-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .summary-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .chart-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 48rem) {
        .page-lead,
        .bbss-live-header {
          align-items: flex-start;
          flex-direction: column;
        }
        .page-meta {
          justify-content: flex-start;
        }
        .source-strip {
          grid-template-columns: 1fr;
        }
        .source-strip > div + div {
          border-top: 1px solid var(--os-hairline);
          border-left: 0;
        }
        .bbss-live-grid {
          grid-template-columns: 1fr;
        }
        .bbss-live-grid div {
          border-right: 0;
          border-bottom: 1px solid var(--os-hairline);
        }
        .bbss-live-footer {
          align-items: flex-start;
          flex-direction: column;
        }
        .summary-grid {
          grid-template-columns: 1fr;
        }
        .card-heading {
          align-items: flex-start;
          flex-direction: column;
        }
        .chart-evidence {
          justify-items: start;
          text-align: left;
        }
      }
    `,
  ],
})
export class AdminOverview implements OnInit, OnDestroy {
  readonly overview = signal<AdminOverviewStatus | null>(null);
  readonly overviewError = signal('');
  readonly bbss = signal<BbssOverview | null>(null);
  readonly bbssError = signal(false);
  readonly busy = signal(false);
  readonly availabilityData = signal<ChartTabularData>([]);
  readonly availabilityOptions = signal<DonutChartOptions>({});
  readonly resourceData = signal<ChartTabularData>([]);
  readonly resourceOptions = signal<LineChartOptions>({});
  readonly attentionNodes = computed(() =>
    (this.overview()?.nodes || []).filter((node) => node.state !== 'Healthy'),
  );

  private readonly http = inject(HttpService);
  private timer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(true), 30_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.busy.set(true);
    await Promise.allSettled([this.loadOverview(), this.loadBbss()]);
    if (!silent) this.busy.set(false);
  }

  stateLabel(state: string): string {
    return (
      (
        {
          Healthy: '정상',
          Degraded: '주의',
          Unavailable: '사용 불가',
          Stale: '수집 지연',
          NotConfigured: '미구성',
        } as Record<string, string>
      )[state] || state
    );
  }

  formatPercent(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
      ? '—'
      : `${value.toFixed(1)}%`;
  }

  formatAge(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '미보고';
    if (value < 60) return `${Math.max(0, Math.round(value))}초 전`;
    if (value < 3600) return `${Math.round(value / 60)}분 전`;
    if (value < 86400) return `${Math.round(value / 3600)}시간 전`;
    return `${Math.round(value / 86400)}일 전`;
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '기록 없음';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '기록 없음';
    return (
      new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(date) + ' KST'
    );
  }

  bbssStateClass(state: string): string {
    return `bbss-state ${this.toneName(state)}`;
  }

  bbssTone(state: string): string {
    return `bbss-${this.toneName(state)}`;
  }

  bbssDot(state: string): string {
    return `bbss-dot ${this.toneName(state)}`;
  }

  sourceDot(state: OverviewState): string {
    return `source-dot ${this.toneName(state)}`;
  }

  statePill(state: OverviewState): string {
    return `state-pill ${this.toneName(state)}`;
  }

  nodeStateClass(state: NodeState): string {
    if (state === 'Healthy') return 'state state-ok';
    if (state === 'Unavailable') return 'state state-danger';
    return 'state state-warn';
  }

  private async loadOverview(): Promise<void> {
    try {
      const response = await this.http.request('/api/admin/overview', { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result.error || `HTTP ${response.status}`));
      const overview = result as AdminOverviewStatus;
      if (overview.schemaVersion !== 'rcc.admin.overview/v1') {
        throw new Error('지원하지 않는 관리 개요 계약입니다.');
      }
      this.overview.set(overview);
      this.overviewError.set('');
      this.buildAvailabilityChart(overview);
      this.buildResourceChart(overview);
    } catch (error) {
      this.overview.set(null);
      this.availabilityData.set([]);
      this.resourceData.set([]);
      this.overviewError.set(`실제 관리 개요를 불러오지 못했습니다: ${String(error)}`);
    }
  }

  private async loadBbss(): Promise<void> {
    try {
      const response = await this.http.request('/api/admin/bbss/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.bbss.set((await response.json()) as BbssOverview);
      this.bbssError.set(false);
    } catch {
      this.bbss.set(null);
      this.bbssError.set(true);
    }
  }

  private buildAvailabilityChart(overview: AdminOverviewStatus): void {
    const data: ChartTabularData = [
      { group: '정상', value: overview.fleet.healthy },
      { group: '주의', value: overview.fleet.attention },
      { group: '오프라인', value: overview.fleet.offline },
    ].filter((item) => item.value > 0);
    this.availabilityData.set(data);
    this.availabilityOptions.set({
      chartId: 'manage-live-node-availability',
      theme: ChartTheme.WHITE,
      height: '15.5rem',
      resizable: true,
      animations: false,
      accessibility: {
        svgAriaLabel: `실제 노드 가용성: 정상 ${overview.fleet.healthy}, 주의 ${overview.fleet.attention}, 오프라인 ${overview.fleet.offline}`,
      },
      data: { groupMapsTo: 'group' },
      pie: { valueMapsTo: 'value' },
      donut: {
        center: {
          label: '정상',
          number: overview.fleet.healthyPercent ?? 0,
          numberFormatter: (value) => `${Math.round(value)}%`,
        },
      },
      legend: {
        enabled: true,
        clickable: false,
        position: LegendPositions.RIGHT,
        order: ['정상', '주의', '오프라인'],
      },
      color: {
        scale: {
          정상: '#24a148',
          주의: '#f1c21b',
          오프라인: '#da1e28',
        },
      },
      tooltip: {
        enabled: true,
        valueFormatter: (value) => `${Number(value)}대`,
      },
      toolbar: { enabled: false },
    });
  }

  private buildResourceChart(overview: AdminOverviewStatus): void {
    const data: ChartTabularData = [];
    const fields = [
      { key: 'cpuPercent' as const, group: 'CPU' },
      { key: 'memoryPercent' as const, group: '메모리' },
    ];
    for (const field of fields) {
      overview.trend.points.forEach((point, index) => {
        const date = new Date(point.timestamp);
        if (Number.isNaN(date.getTime())) return;
        if (point.gapBefore && index > 0) {
          const previous = Date.parse(overview.trend.points[index - 1].timestamp);
          if (Number.isFinite(previous)) {
            data.push({
              group: field.group,
              date: new Date(previous + (date.getTime() - previous) / 2),
              value: null,
            });
          }
        }
        data.push({
          group: field.group,
          date,
          value: point[field.key],
        });
      });
    }
    this.resourceData.set(data);
    this.resourceOptions.set({
      chartId: 'manage-live-resource-trend',
      theme: ChartTheme.WHITE,
      height: '15.5rem',
      resizable: true,
      animations: false,
      accessibility: {
        svgAriaLabel: `Beszel 실제 CPU와 메모리 최근 24시간 평균 시계열, ${overview.trend.observedHostCount}개 호스트`,
      },
      data: { groupMapsTo: 'group' },
      axes: {
        bottom: {
          title: '시간',
          mapsTo: 'date',
          scaleType: ScaleTypes.TIME,
          ticks: { number: 5 },
        },
        left: {
          title: '%',
          mapsTo: 'value',
          scaleType: ScaleTypes.LINEAR,
          includeZero: true,
          domain: [0, 100],
          ticks: {
            number: 5,
            formatter: (value: number | Date) => `${Number(value)}%`,
          },
        },
      },
      legend: {
        enabled: true,
        clickable: false,
        position: LegendPositions.TOP,
        order: ['CPU', '메모리'],
      },
      color: { scale: { CPU: '#0f62fe', 메모리: '#8a3ffc' } },
      points: { enabled: true, filled: true, radius: 2 },
      tooltip: {
        enabled: true,
        groupLabel: '지표',
        valueFormatter: (value) => this.formatPercent(Number(value)),
      },
      toolbar: { enabled: false },
    });
  }

  private toneName(state: string): 'ok' | 'warn' | 'danger' | 'neutral' {
    if (state === 'Healthy') return 'ok';
    if (state === 'Unavailable') return 'danger';
    if (state === 'Degraded' || state === 'Stale') return 'warn';
    return 'neutral';
  }
}
