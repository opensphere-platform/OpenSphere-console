import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import {
  ChartTabularData,
  ChartTheme,
  LegendPositions,
  LineChartComponent,
  LineChartOptions,
  ScaleTypes,
} from '@carbon/charts-angular';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';

type MonitoringTab = 'overview' | 'nodes' | 'kubernetes' | 'alerts' | 'health';
type Range = '1h' | '12h' | '24h' | '7d' | '30d';

interface Overview {
  freshness: 'fresh' | 'stale';
  observedAt: string;
  upstreamError?: string;
  provider: { id: string; versionContract: string; mode: string };
  systems: { total: number; up: number; down: number; unmatched: number; identityRejected: number; disagreement: number };
  kubernetes: { available: boolean; nodes: number; nodesReady: number; namespaces: number; pods: Record<string, number> };
  alerts: { total: number; triggered: number };
  retention: { maximumDays: number; authority: string };
}

interface KubernetesNode {
  uid: string;
  name: string;
  ready: boolean;
  roles: string[];
  kubeletVersion: string;
  osImage: string;
  architecture: string;
  internalIp: string;
}

interface MonitoredNode {
  id: string;
  name: string;
  hostname: string;
  status: 'up' | 'down' | 'paused' | 'pending' | 'unknown';
  observedAt: string | null;
  agentVersion: string;
  os: string;
  kernel: string;
  cpuModel: string;
  cpuThreads: number | null;
  cpuCores: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  loadAverage: Array<number | null>;
  uptimeSeconds: number | null;
  temperatureCelsius: number | null;
  binding: 'beszel-authoritative';
  identity: 'beszel-system';
  bindingEvidence: { state: string; fingerprintDigest?: string; reason?: string } | null;
  stateAgreement: 'not-applicable';
  kubernetes: KubernetesNode | null;
}

interface NodeResult {
  freshness: 'fresh' | 'stale';
  observedAt: string;
  upstreamError?: string;
  items: MonitoredNode[];
  kubernetesAvailable: boolean;
}

interface SeriesPoint {
  at: string | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  networkSentBytesPerSecond: number | null;
  networkReceivedBytesPerSecond: number | null;
  loadAverage: Array<number | null>;
}

interface Series {
  systemId: string;
  range: Range;
  resolution: string;
  points: SeriesPoint[];
  observedAt: string;
}

interface AlertsResult {
  freshness: 'fresh' | 'stale';
  observedAt: string;
  upstreamError?: string;
  active: Array<{ id: string; systemId: string; metric: string; triggered: boolean; threshold: number | null; durationMinutes: number | null; updatedAt: string | null }>;
  history: Array<{ id: string; systemId: string; metric: string; value: number | null; triggeredAt: string | null; resolvedAt: string | null }>;
}

interface DataHealth {
  status: 'healthy' | 'degraded' | 'unavailable' | 'unconfigured';
  checkedAt: string;
  provider: string;
  adapter: string;
  freshness?: string;
  observedAt?: string;
  systemCount?: number;
  staleAfterSeconds?: number;
  reasons: string[];
}

interface ChartView {
  id: string;
  title: string;
  description: string;
  data: ChartTabularData;
  options: LineChartOptions;
}

@Component({
  selector: 'os-admin-infrastructure-monitoring',
  imports: [ClarityModule, FormsModule, BackendUnavailable, LineChartComponent, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page monitoring-page">
      <os-page-header title="Infrastructure Monitoring" tag="Baseline observation · Beszel v0.18.7" />
      <p class="os-sub">Console Backbone의 Beszel Hub·Agent가 제공하는 노드 OS 시계열을 읽기 전용으로 표시합니다. Kubernetes 관측 owner는 아직 구성하지 않았으며, Prometheus 또는 Grafana 설치 여부와 관계없이 동작합니다.</p>

      <div class="os-actions">
        <button class="btn btn-sm btn-outline" (click)="refresh()" [disabled]="loading()">새로고침</button>
        @if (loading()) { <span class="spinner spinner-inline" aria-label="기초 관측 정보를 불러오는 중"></span> }
        @if (overview(); as summary) {
          <span class="label" [class.label-success]="summary.freshness === 'fresh'" [class.label-warning]="summary.freshness === 'stale'">
            {{ summary.freshness === 'fresh' ? '최신 관측' : '마지막 정상 관측' }}
          </span>
          <span class="observed">{{ fmt(summary.observedAt) }}</span>
        }
      </div>

      @if (error(); as detail) {
        <os-backend-unavailable
          feature="Infrastructure Monitoring"
          backend="Console Baseline Monitoring adapter (/api/monitoring/baseline/v1)"
          hint="Beszel Hub·Agent와 읽기 전용 adapter 자격을 확인하십시오. 인증·상태 변경·HISS에는 영향을 주지 않습니다."
          [detail]="detail"
        />
      } @else {
        @if (staleMessage(); as stale) {
          <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text"><strong>마지막 정상 관측값을 표시합니다.</strong> {{ stale }}</span></clr-alert-item>
          </clr-alert>
        }

        <clr-tabs>
          <clr-tab>
            <button clrTabLink (click)="selectTab('overview')">개요</button>
            <clr-tab-content *clrIfActive="tab() === 'overview'">
              @if (overview(); as summary) {
                <section class="status-rail" aria-label="기초 관측 요약">
                  <div><span>노드 관측</span><strong [class.ok]="summary.systems.down === 0">{{ summary.systems.up }}/{{ summary.systems.total }}</strong><small>Beszel Agent 연결</small></div>
                  <div><span>Kubernetes 관측</span><strong [class.ok]="summary.kubernetes.available && summary.kubernetes.nodesReady === summary.kubernetes.nodes">{{ summary.kubernetes.available ? summary.kubernetes.nodesReady + "/" + summary.kubernetes.nodes : "미구성" }}</strong><small>{{ summary.kubernetes.available ? "API 현재 상태" : "관측 owner 미구성" }}</small></div>
                  <div><span>활성 경보</span><strong [class.warn]="summary.alerts.triggered > 0">{{ summary.alerts.triggered }}</strong><small>설정 {{ summary.alerts.total }}건</small></div>
                  <div><span>상태 비교</span><strong [class.warn]="summary.kubernetes.available && summary.systems.disagreement > 0">{{ summary.kubernetes.available ? summary.systems.disagreement : "미측정" }}</strong><small>Beszel과 K8s 권위</small></div>
                  <div><span>최대 이력</span><strong>{{ summary.retention.maximumDays }}일</strong><small>계층형 자동 보존</small></div>
                </section>

                <div class="overview-grid">
                  <section class="os-card">
                    <div class="os-card-h">현재 운영 상태</div>
                    <dl class="facts">
                      <div><dt>연결되지 않은 Kubernetes 노드</dt><dd>{{ summary.kubernetes.available ? summary.systems.unmatched + "대" : "미측정" }}</dd></div>
                      <div><dt>신원 충돌로 거부된 노드</dt><dd>{{ summary.systems.identityRejected || 0 }}대</dd></div>
                      <div><dt>실행 중 Pod</dt><dd>{{ summary.kubernetes.available ? (summary.kubernetes.pods['Running'] || 0) + ' / ' + (summary.kubernetes.pods['total'] || 0) : '미측정' }}</dd></div>
                      <div><dt>Namespace</dt><dd>{{ summary.kubernetes.available ? summary.kubernetes.namespaces : '미측정' }}</dd></div>
                      <div><dt>Kubernetes API</dt><dd>{{ summary.kubernetes.available ? '연결됨' : '사용 불가' }}</dd></div>
                    </dl>
                  </section>
                  <section class="os-card">
                    <div class="os-card-h">데이터 권위와 한계</div>
                    <ul class="scope-list">
                      <li><strong>노드 OS 추세</strong><span>Beszel · CPU, 메모리, 디스크, I/O, 네트워크, load</span></li>
                      <li><strong>Kubernetes 현재 상태</strong><span>관측 owner 미구성 · C_API에 Kubernetes 권한 없음</span></li>
                      <li><strong>고급 관측</strong><span>HISS · SLO, trace, 장기보존, 업무 telemetry</span></li>
                    </ul>
                  </section>
                </div>
              }
            </clr-tab-content>
          </clr-tab>

          <clr-tab>
            <button clrTabLink (click)="selectTab('nodes')">노드</button>
            <clr-tab-content *clrIfActive="tab() === 'nodes'">
              <section class="tab-section">
                <div class="section-heading">
                  <div><h2>노드 OS 관측</h2><p class="os-sub">Beszel Agent가 보고한 현재 사용률입니다. Kubernetes 결합은 별도 관측 owner가 구성된 뒤에만 표시합니다.</p></div>
                </div>
                <div class="grid-scroll" tabindex="0" aria-label="노드 OS 관측 표">
                  <clr-datagrid clrDetailExpandableAriaLabel="노드 메트릭 상세">
                    <clr-dg-column>노드</clr-dg-column><clr-dg-column>연결</clr-dg-column><clr-dg-column>CPU</clr-dg-column><clr-dg-column>메모리</clr-dg-column><clr-dg-column>디스크</clr-dg-column><clr-dg-column>Kubernetes</clr-dg-column><clr-dg-column>관측 시각</clr-dg-column>
                    @for (node of nodes()?.items || []; track node.id) {
                      <clr-dg-row
                        [clrDgItem]="node"
                        [clrDgExpanded]="selectedNode()?.id === node.id"
                        [clrDgDetailOpenLabel]="node.name + ' 메트릭 펼치기'"
                        [clrDgDetailCloseLabel]="node.name + ' 메트릭 접기'"
                        (clrDgExpandedChange)="setNodeExpanded(node, $event)"
                      >
                        <clr-dg-cell>
                          <button
                            type="button"
                            class="node-trigger"
                            [attr.aria-expanded]="selectedNode()?.id === node.id"
                            (click)="toggleNode(node)"
                          >{{ node.name }}</button>
                          <div class="node-meta">{{ node.os || 'OS 정보 없음' }} · Agent {{ node.agentVersion || '—' }}</div>
                        </clr-dg-cell>
                        <clr-dg-cell><span class="label" [class.label-success]="node.status === 'up'" [class.label-danger]="node.status === 'down'">{{ statusLabel(node.status) }}</span></clr-dg-cell>
                        <clr-dg-cell>{{ percent(node.cpuPercent) }}</clr-dg-cell>
                        <clr-dg-cell>{{ percent(node.memoryPercent) }}</clr-dg-cell>
                        <clr-dg-cell>{{ percent(node.diskPercent) }}</clr-dg-cell>
                        <clr-dg-cell>
                          @if (node.kubernetes) {
                            <span class="label" [class.label-success]="node.kubernetes.ready" [class.label-warning]="!node.kubernetes.ready">{{ node.kubernetes.ready ? 'Ready' : 'Not Ready' }}</span>
                            <span class="label" [class.label-success]="node.identity === 'beszel-system'">
                              {{ identityLabel(node.identity) }}
                            </span>
                          } @else {
                            <span class="label label-warning">{{ nodes()?.kubernetesAvailable ? "연결 대상 없음" : "관측 owner 미구성" }}</span>
                          }
                        </clr-dg-cell>
                        <clr-dg-cell>{{ fmt(node.observedAt) }}</clr-dg-cell>
                        <clr-dg-row-detail *clrIfExpanded>
                          <section class="node-detail" [attr.aria-label]="node.name + ' 메트릭 상세'">
                            <div class="section-heading detail-heading">
                              <div>
                                <h2>{{ node.name }} 메트릭</h2>
                                <p class="os-sub">Beszel 계층형 보존값 · {{ series()?.resolution || '조회 중' }} 해상도</p>
                              </div>
                              <clr-select-container class="range-select">
                                <label>조회 기간</label>
                                <select clrSelect [(ngModel)]="range" (change)="loadSeries()">
                                  <option value="1h">최근 1시간</option><option value="12h">최근 12시간</option><option value="24h">최근 24시간</option><option value="7d">최근 7일</option><option value="30d">최근 30일</option>
                                </select>
                              </clr-select-container>
                            </div>
                            @if (seriesLoading()) {
                              <div class="loading-block"><span class="spinner spinner-md"></span><span>{{ node.name }} 시계열을 불러오는 중입니다.</span></div>
                            } @else if (seriesError()) {
                              <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ seriesError() }}</span></clr-alert-item></clr-alert>
                            } @else if (series(); as chart) {
                              <div class="chart-grid">
                                @for (view of charts(); track view.id) {
                                  <article class="chart-panel">
                                    <div class="chart-heading">
                                      <div><h3>{{ view.title }}</h3><p>{{ view.description }}</p></div>
                                    </div>
                                    <ibm-line-chart [data]="view.data" [options]="view.options" />
                                  </article>
                                }
                              </div>
                            }
                          </section>
                        </clr-dg-row-detail>
                      </clr-dg-row>
                    }
                    <clr-dg-placeholder>관측 중인 노드가 없습니다. Agent bootstrap과 Hub 연결을 확인하십시오.</clr-dg-placeholder>
                    <clr-dg-footer>{{ nodes()?.items?.length || 0 }}개 노드</clr-dg-footer>
                  </clr-datagrid>
                </div>
              </section>
            </clr-tab-content>
          </clr-tab>

          <clr-tab>
            <button clrTabLink (click)="selectTab('kubernetes')">Kubernetes</button>
            <clr-tab-content *clrIfActive="tab() === 'kubernetes'">
              <section class="tab-section">
                <h2>Kubernetes 기초 상태</h2>
                <p class="os-sub">Kubernetes 관측 owner는 아직 구성하지 않았습니다. 구성되기 전까지 Node Ready·Pod phase·Namespace를 추정하거나 0으로 표시하지 않습니다.</p>
                <clr-datagrid>
                  <clr-dg-column>Node</clr-dg-column><clr-dg-column>Ready</clr-dg-column><clr-dg-column>역할</clr-dg-column><clr-dg-column>내부 IP</clr-dg-column><clr-dg-column>Kubelet</clr-dg-column><clr-dg-column>OS·Arch</clr-dg-column><clr-dg-column>OS 관측 결합</clr-dg-column>
                  @for (node of kubernetesNodes(); track node.uid) {
                    <clr-dg-row>
                      <clr-dg-cell><strong>{{ node.name }}</strong><div class="os-mono">{{ node.uid }}</div></clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-success]="node.ready" [class.label-danger]="!node.ready">{{ node.ready ? 'Ready' : 'Not Ready' }}</span></clr-dg-cell>
                      <clr-dg-cell>{{ node.roles.join(', ') || 'worker' }}</clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ node.internalIp || '—' }}</clr-dg-cell>
                      <clr-dg-cell>{{ node.kubeletVersion || '—' }}</clr-dg-cell>
                      <clr-dg-cell>{{ node.osImage || '—' }} · {{ node.architecture || '—' }}</clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-success]="monitorFor(node.name)" [class.label-warning]="!monitorFor(node.name)">{{ monitorFor(node.name) ? '결합됨' : 'Agent 미결합' }}</span></clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>Kubernetes 관측 owner가 구성되지 않아 Node 상태를 측정하지 않습니다.</clr-dg-placeholder>
                  <clr-dg-footer>{{ nodes()?.kubernetesAvailable ? kubernetesNodes().length + '개 Node' : '미측정' }}</clr-dg-footer>
                </clr-datagrid>
              </section>
            </clr-tab-content>
          </clr-tab>

          <clr-tab>
            <button clrTabLink (click)="selectTab('alerts')">경보</button>
            <clr-tab-content *clrIfActive="tab() === 'alerts'">
              <section class="tab-section">
                <h2>노드 기초 경보</h2>
                <p class="os-sub">Beszel 경보 상태를 읽기 전용으로 표시합니다. 외부 전달은 OpenSphere 알림·외부 채널 정책으로 통합합니다.</p>
                <clr-datagrid>
                  <clr-dg-column>지표</clr-dg-column><clr-dg-column>노드</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>임계값</clr-dg-column><clr-dg-column>지속</clr-dg-column><clr-dg-column>갱신</clr-dg-column>
                  @for (alert of alerts()?.active || []; track alert.id) {
                    <clr-dg-row>
                      <clr-dg-cell><strong>{{ alert.metric }}</strong></clr-dg-cell>
                      <clr-dg-cell>{{ nodeName(alert.systemId) }}</clr-dg-cell>
                      <clr-dg-cell><span class="label" [class.label-danger]="alert.triggered" [class.label-success]="!alert.triggered">{{ alert.triggered ? '발생 중' : '정상' }}</span></clr-dg-cell>
                      <clr-dg-cell>{{ alert.threshold ?? '—' }}</clr-dg-cell>
                      <clr-dg-cell>{{ alert.durationMinutes === null ? '—' : alert.durationMinutes + '분' }}</clr-dg-cell>
                      <clr-dg-cell>{{ fmt(alert.updatedAt) }}</clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>설정된 기초 경보가 없습니다.</clr-dg-placeholder>
                  <clr-dg-footer>{{ alerts()?.active?.length || 0 }}개 규칙 · 발생 {{ triggeredAlerts() }}건</clr-dg-footer>
                </clr-datagrid>

                <h2 class="separated">최근 발생·해제 이력</h2>
                <clr-datagrid>
                  <clr-dg-column>지표</clr-dg-column><clr-dg-column>노드</clr-dg-column><clr-dg-column>관측값</clr-dg-column><clr-dg-column>발생</clr-dg-column><clr-dg-column>해제</clr-dg-column>
                  @for (event of alerts()?.history || []; track event.id) {
                    <clr-dg-row><clr-dg-cell>{{ event.metric }}</clr-dg-cell><clr-dg-cell>{{ nodeName(event.systemId) }}</clr-dg-cell><clr-dg-cell>{{ event.value ?? '—' }}</clr-dg-cell><clr-dg-cell>{{ fmt(event.triggeredAt) }}</clr-dg-cell><clr-dg-cell>{{ fmt(event.resolvedAt) }}</clr-dg-cell></clr-dg-row>
                  }
                  <clr-dg-placeholder>최근 경보 이력이 없습니다.</clr-dg-placeholder>
                  <clr-dg-footer>최근 {{ alerts()?.history?.length || 0 }}건</clr-dg-footer>
                </clr-datagrid>
              </section>
            </clr-tab-content>
          </clr-tab>

          <clr-tab>
            <button clrTabLink (click)="selectTab('health')">데이터 상태</button>
            <clr-tab-content *clrIfActive="tab() === 'health'">
              <section class="tab-section">
                <h2>관측 데이터 상태</h2>
                <p class="os-sub">Hub 연결, adapter 계약, 마지막 성공 시각을 분리하여 표시합니다. 장애 시 마지막 정상값은 stale로 명시됩니다.</p>
                @if (health(); as current) {
                  <section class="status-rail health-rail" aria-label="관측 데이터 상태">
                    <div><span>전체 상태</span><strong [class.ok]="current.status === 'healthy'" [class.warn]="current.status !== 'healthy'">{{ healthLabel(current.status) }}</strong><small>{{ fmt(current.checkedAt) }}</small></div>
                    <div><span>Provider</span><strong>{{ current.provider }}</strong><small>계약 v0.18.7</small></div>
                    <div><span>Adapter</span><strong>{{ current.adapter }}</strong><small>Console 공개 API v1</small></div>
                    <div><span>관측 노드</span><strong>{{ current.systemCount ?? '—' }}</strong><small>stale 제한 {{ current.staleAfterSeconds || 120 }}초</small></div>
                  </section>
                  @if (current.reasons.length) {
                    <clr-alert clrAlertType="warning" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">{{ current.reasons.join(' · ') }}</span></clr-alert-item></clr-alert>
                  }
                  <section class="os-card">
                    <div class="os-card-h">보존과 장애 경계</div>
                    <dl class="facts">
                      <div><dt>1분 지점</dt><dd>최근 1시간</dd></div><div><dt>10분 지점</dt><dd>최근 12시간</dd></div>
                      <div><dt>20분 지점</dt><dd>최근 24시간</dd></div><div><dt>2시간 지점</dt><dd>최근 7일</dd></div>
                      <div><dt>8시간 지점</dt><dd>최근 30일</dd></div><div><dt>장기보존</dt><dd>HISS 또는 승인된 별도 export</dd></div>
                    </dl>
                  </section>
                }
              </section>
            </clr-tab-content>
          </clr-tab>
        </clr-tabs>
      }
    </div>
  `,
  styles: [`
    .monitoring-page{min-width:0}
    .os-sub{color:var(--os-ink-muted);font-size:.72rem;line-height:1.5;margin:.3rem 0 .8rem}
    .os-actions{display:flex;align-items:center;gap:var(--os-3);min-height:2rem;margin:.5rem 0 1rem;flex-wrap:wrap}
    .observed{color:var(--os-ink-subtle);font-size:.65rem}
    .status-rail{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas);margin:var(--os-5) 0}
    .status-rail>div{display:grid;gap:var(--os-2);min-width:0;padding:var(--os-5);border-inline-end:1px solid var(--os-hairline)}
    .status-rail>div:last-child{border-inline-end:0}.status-rail span{color:var(--os-ink-muted);font-size:.65rem}.status-rail strong{font-size:1.15rem}.status-rail small{color:var(--os-ink-subtle);font-size:.6rem}
    .ok{color:var(--os-success)}.warn{color:var(--os-ink)}
    .overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--os-5);margin-top:var(--os-5)}
    .os-card{border:1px solid var(--os-hairline);background:var(--os-canvas);min-width:0}.os-card-h{padding:var(--os-4) var(--os-5);border-bottom:1px solid var(--os-hairline);font-size:.8rem;font-weight:600}
    .facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0}.facts div{padding:var(--os-5);border-bottom:1px solid var(--os-hairline)}.facts dt{color:var(--os-ink-muted);font-size:.65rem}.facts dd{margin:var(--os-2) 0 0;font-size:.8rem;font-weight:600}
    .scope-list{list-style:none;margin:0;padding:0}.scope-list li{display:grid;grid-template-columns:minmax(8rem,.7fr) minmax(0,1.3fr);gap:var(--os-5);padding:var(--os-5);border-bottom:1px solid var(--os-hairline);font-size:.7rem}.scope-list span{color:var(--os-ink-muted)}
    .tab-section{padding:var(--os-5) 0 var(--os-7);min-width:0}.tab-section h2{margin:.3rem 0 .5rem;font-size:1rem}.section-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--os-5);flex-wrap:wrap}
    .grid-scroll{max-width:100%;overflow-x:auto}.grid-scroll clr-datagrid{min-width:70rem}.node-meta{margin-top:var(--os-2);color:var(--os-ink-muted);font-size:.62rem}
    .node-trigger{appearance:none;border:0;background:transparent;padding:0;color:var(--os-accent);font:inherit;font-weight:600;text-align:left;cursor:pointer}.node-trigger:hover{text-decoration:underline}.node-trigger:focus-visible{outline:2px solid var(--os-accent);outline-offset:2px}
    .node-detail{width:100%;min-width:0;padding:var(--os-5);background:var(--os-surface-subtle)}.detail-heading{padding-bottom:var(--os-4);border-bottom:1px solid var(--os-hairline)}.detail-heading h2{margin:0;font-size:.9rem}.range-select{margin:0;min-width:10rem}
    .chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--os-5);margin-top:var(--os-5)}.chart-panel{min-width:0;border:1px solid var(--os-hairline);background:var(--os-canvas)}.chart-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--os-4);padding:var(--os-4) var(--os-5);border-bottom:1px solid var(--os-hairline)}.chart-heading h3{margin:0;font-size:.78rem}.chart-heading p{margin:.15rem 0 0;color:var(--os-ink-muted);font-size:.62rem}.chart-panel ibm-line-chart{display:block;min-height:15rem}.loading-block{display:flex;align-items:center;justify-content:center;gap:var(--os-4);min-height:10rem;color:var(--os-ink-muted)}
    .os-mono{font-family:var(--os-font-mono);font-size:.62rem;word-break:break-all}.separated{margin-top:var(--os-7)!important;padding-top:var(--os-5);border-top:1px solid var(--os-hairline)}.health-rail{grid-template-columns:repeat(4,minmax(0,1fr))}
    @media(max-width:70rem){.status-rail{grid-template-columns:repeat(3,minmax(0,1fr))}.status-rail>div:nth-child(3){border-inline-end:0}.overview-grid{grid-template-columns:1fr}}
    @media(max-width:48rem){.status-rail,.health-rail,.chart-grid,.facts{grid-template-columns:1fr}.status-rail>div{border-inline-end:0;border-bottom:1px solid var(--os-hairline)}.status-rail>div:last-child{border-bottom:0}.scope-list li{grid-template-columns:1fr;gap:var(--os-2)}}
  `],
})
export class AdminInfrastructureMonitoring implements OnInit, OnDestroy {
  private readonly http = inject(HttpService);
  readonly tab = signal<MonitoringTab>('overview');
  readonly overview = signal<Overview | null>(null);
  readonly nodes = signal<NodeResult | null>(null);
  readonly alerts = signal<AlertsResult | null>(null);
  readonly health = signal<DataHealth | null>(null);
  readonly selectedNode = signal<MonitoredNode | null>(null);
  readonly series = signal<Series | null>(null);
  readonly loading = signal(false);
  readonly seriesLoading = signal(false);
  readonly error = signal('');
  readonly seriesError = signal('');
  range: Range = '24h';
  private timer: ReturnType<typeof setInterval> | null = null;
  private seriesRequest = 0;

  readonly kubernetesNodes = computed(() => (this.nodes()?.items || [])
    .map((item) => item.kubernetes)
    .filter((item): item is KubernetesNode => Boolean(item))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.uid === item.uid) === index));
  readonly triggeredAlerts = computed(() => (this.alerts()?.active || []).filter((item) => item.triggered).length);
  readonly charts = computed(() => this.buildCharts(this.series()?.points || []));
  readonly staleMessage = computed(() => {
    const stale = [this.overview(), this.nodes(), this.alerts()].find((item) => item?.freshness === 'stale');
    return stale?.upstreamError || '';
  });

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(true), 30_000);
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.loading.set(true);
    try {
      const [overview, nodes, alerts, health] = await Promise.all([
        this.get<Overview>('/api/monitoring/baseline/v1/overview'),
        this.get<NodeResult>('/api/monitoring/baseline/v1/nodes'),
        this.get<AlertsResult>('/api/monitoring/baseline/v1/alerts'),
        this.get<DataHealth>('/api/monitoring/baseline/v1/data-health'),
      ]);
      this.overview.set(overview); this.nodes.set(nodes); this.alerts.set(alerts); this.health.set(health); this.error.set('');
      const selected = this.selectedNode();
      if (selected) this.selectedNode.set(nodes.items.find((item) => item.id === selected.id) || null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (!silent) this.loading.set(false);
    }
  }

  selectTab(tab: MonitoringTab): void { this.tab.set(tab); }
  toggleNode(node: MonitoredNode): void {
    this.setNodeExpanded(node, this.selectedNode()?.id !== node.id);
  }

  setNodeExpanded(node: MonitoredNode, expanded: boolean): void {
    if (!expanded) {
      if (this.selectedNode()?.id !== node.id) return;
      this.seriesRequest += 1;
      this.selectedNode.set(null);
      this.series.set(null);
      this.seriesError.set('');
      this.seriesLoading.set(false);
      return;
    }
    if (this.selectedNode()?.id === node.id) return;
    this.selectedNode.set(node);
    this.series.set(null);
    this.seriesError.set('');
    void this.loadSeries();
  }

  async loadSeries(): Promise<void> {
    const node = this.selectedNode();
    if (!node) return;
    const request = ++this.seriesRequest;
    this.seriesLoading.set(true); this.seriesError.set('');
    try {
      const result = await this.get<Series>(`/api/monitoring/baseline/v1/nodes/${encodeURIComponent(node.id)}/series?range=${this.range}`);
      if (request === this.seriesRequest && this.selectedNode()?.id === node.id) this.series.set(result);
    } catch (error) {
      if (request === this.seriesRequest && this.selectedNode()?.id === node.id) {
        this.seriesError.set(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === this.seriesRequest) this.seriesLoading.set(false);
    }
  }

  monitorFor(name: string): MonitoredNode | null { return (this.nodes()?.items || []).find((item) => item.kubernetes?.name === name) || null; }
  nodeName(id: string): string { return (this.nodes()?.items || []).find((item) => item.id === id)?.name || id; }
  percent(value: number | null): string { return value === null ? '—' : `${value.toFixed(0)}%`; }
  fmt(value: string | null | undefined): string { return value ? new Date(value).toLocaleString() : '—'; }
  statusLabel(value: string): string { return ({ up: '연결됨', down: '연결 끊김', paused: '일시 중지', pending: '등록 대기', unknown: '알 수 없음' } as Record<string, string>)[value] || value; }
  identityLabel(value: string): string {
    return ({
      verified: '신원 확인됨',
      unmatched: '대상 없음',
      candidate: '확인 대기',
      ambiguous: '이름 중복',
      'fingerprint-pending': '지문 대기',
      rejected: '신원 충돌',
      'beszel-system': 'Beszel 권위',
    } as Record<string, string>)[value] || value;
  }
  healthLabel(value: string): string { return ({ healthy: '정상', degraded: '저하', unavailable: '사용 불가', unconfigured: '미구성' } as Record<string, string>)[value] || value; }

  private async get<T>(url: string): Promise<T> {
    const response = await this.http.request(url, { cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(`Infrastructure Monitoring API가 JSON 대신 ${contentType || '알 수 없는 형식'}을 반환했습니다.`);
    }
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || `Infrastructure Monitoring HTTP ${response.status}`);
    return body;
  }

  private buildCharts(points: SeriesPoint[]): ChartView[] {
    if (!points.length) return [];
    type PointKey = 'cpuPercent' | 'memoryPercent' | 'diskPercent'
      | 'diskReadBytesPerSecond' | 'diskWriteBytesPerSecond'
      | 'networkSentBytesPerSecond' | 'networkReceivedBytesPerSecond'
      | 'load1' | 'load5' | 'load15';
    const normalized = points.map((point) => ({
      ...point,
      load1: point.loadAverage?.[0] ?? null,
      load5: point.loadAverage?.[1] ?? null,
      load15: point.loadAverage?.[2] ?? null,
    }));
    const definitions: Array<{
      id: string;
      title: string;
      description: string;
      unit: '%' | 'B/s' | 'load';
      fixedMax?: number;
      fields: Array<{ key: PointKey; label: string; color: string }>;
    }> = [
      {
        id: 'utilization',
        title: 'CPU · Memory · Disk',
        description: '노드 자원 사용률',
        unit: '%',
        fixedMax: 100,
        fields: [
          { key: 'cpuPercent', label: 'CPU', color: '#0f62fe' },
          { key: 'memoryPercent', label: 'Memory', color: '#8a3ffc' },
          { key: 'diskPercent', label: 'Disk', color: '#198038' },
        ],
      },
      {
        id: 'network',
        title: 'Network throughput',
        description: '노드 송·수신 처리량',
        unit: 'B/s',
        fields: [
          { key: 'networkSentBytesPerSecond', label: 'Send', color: '#1192e8' },
          { key: 'networkReceivedBytesPerSecond', label: 'Receive', color: '#005d5d' },
        ],
      },
      {
        id: 'disk-io',
        title: 'Disk I/O',
        description: '노드 디스크 읽기·쓰기 처리량',
        unit: 'B/s',
        fields: [
          { key: 'diskReadBytesPerSecond', label: 'Read', color: '#fa4d56' },
          { key: 'diskWriteBytesPerSecond', label: 'Write', color: '#9f1853' },
        ],
      },
      {
        id: 'load',
        title: 'Load average',
        description: '노드 1·5·15분 부하 평균',
        unit: 'load',
        fields: [
          { key: 'load1', label: '1m', color: '#6929c4' },
          { key: 'load5', label: '5m', color: '#009d9a' },
          { key: 'load15', label: '15m', color: '#ee5396' },
        ],
      },
    ];

    return definitions.map((definition) => {
      const data: ChartTabularData = [];
      for (const field of definition.fields) {
        for (const point of normalized) {
          const date = point.at ? new Date(point.at) : null;
          if (!date || Number.isNaN(date.getTime())) continue;
          const value = point[field.key];
          data.push({
            group: field.label,
            date,
            value: value === null || !Number.isFinite(value) ? null : value,
          });
        }
      }
      const formatValue = definition.unit === '%'
        ? (value: unknown) => `${Number(value).toFixed(0)}%`
        : definition.unit === 'B/s'
          ? (value: unknown) => this.formatRate(Number(value))
          : (value: unknown) => Number(value).toFixed(2);
      const options: LineChartOptions = {
        chartId: `infrastructure-${definition.id}`,
        theme: ChartTheme.WHITE,
        height: '15rem',
        resizable: true,
        animations: false,
        accessibility: { svgAriaLabel: `${definition.title} Beszel 시계열` },
        data: { groupMapsTo: 'group' },
        axes: {
          bottom: {
            title: '시간',
            mapsTo: 'date',
            scaleType: ScaleTypes.TIME,
            ticks: { number: 5 },
          },
          left: {
            title: definition.unit,
            mapsTo: 'value',
            scaleType: ScaleTypes.LINEAR,
            includeZero: true,
            ...(definition.fixedMax ? { domain: [0, definition.fixedMax] } : {}),
            ticks: { number: 5, formatter: (value: number | Date) => formatValue(value) },
          },
        },
        legend: {
          enabled: true,
          clickable: false,
          position: LegendPositions.TOP,
          order: definition.fields.map((field) => field.label),
        },
        color: { scale: Object.fromEntries(definition.fields.map((field) => [field.label, field.color])) },
        points: { enabled: true, filled: true, radius: 2 },
        tooltip: { enabled: true, groupLabel: '지표', valueFormatter: (value) => formatValue(value) },
        toolbar: { enabled: false },
      };
      return { id: definition.id, title: definition.title, description: definition.description, data, options };
    });
  }

  private formatRate(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
    let current = Math.max(0, value);
    let index = 0;
    while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1; }
    return `${current.toFixed(index ? 1 : 0)} ${units[index]}`;
  }
}
