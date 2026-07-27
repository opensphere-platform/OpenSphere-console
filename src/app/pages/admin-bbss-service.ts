import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import {
  ChartTabularData,
  ChartTheme,
  LegendPositions,
  LineChartComponent,
  LineChartOptions,
  ScaleTypes,
} from '@carbon/charts-angular';
import CheckmarkFilled16 from '@carbon/icons/es/checkmark--filled/16';
import Renew16 from '@carbon/icons/es/renew/16';
import WarningAltFilled16 from '@carbon/icons/es/warning--alt--filled/16';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { CarbonIcon } from '../os/carbon-icon';
import { OsPageHeader } from '../os/os-page-header';

type BbssProductId = 'supabase' | 'gitea' | 'beszel';
type BbssState = 'Healthy' | 'Degraded' | 'Unavailable' | 'Stale' | 'NotConfigured';
type BeszelRange = '1h' | '12h' | '24h' | '1w' | '30d';

interface BbssComponent {
  id: string;
  name: string;
  kind: string;
  state: BbssState;
  desired: number;
  ready: number;
  available: number;
  restarts: number;
  version: string | null;
  images: string[];
}

interface BbssCheck {
  id: string;
  name: string;
  state: BbssState;
  detail: string;
}

interface BbssActivity {
  label: string;
  value: number | null;
  unit?: string;
  kind: string;
}

interface BbssClaim {
  name: string;
  state: string;
  storageClass: string | null;
  requestedBytes: number | null;
  capacityBytes: number | null;
}

interface BbssService {
  id: BbssProductId;
  name: string;
  role: string;
  state: BbssState;
  observedAt: string | null;
  version: string | null;
  route: string;
  checks: BbssCheck[];
  components: BbssComponent[];
  capacity: {
    cpuMillicores: number | null;
    memoryBytes: number | null;
    pvcCount: number;
    requestedBytes: number;
    capacityBytes: number;
    actualUsedBytes: number | null;
    logicalUsedBytes?: number | null;
    claims: BbssClaim[];
  };
  activity: BbssActivity[];
  warnings: string[];
  latest?: {
    cpuPercent: number | null;
    memoryPercent: number | null;
    diskPercent: number | null;
  } | null;
}

interface BbssStatus {
  schemaVersion: 'rcc.bbss.status/v1';
  generatedAt: string;
  overall: {
    state: BbssState;
    runtimeAvailability: BbssState;
    resilience: BbssState;
    applicationTelemetry: BbssState;
    reason: string;
  };
  services: BbssService[];
  dependencies: Array<{ id: string; name: string; state: BbssState; detail: string }>;
}

interface SupabaseDetail {
  meta: { checkedAt: string };
  components: Array<{
    key: string;
    name: string;
    responsibility: string;
    ready: boolean;
    detail: string;
  }>;
  operators: number;
  roles: Array<{ id: string; code: string; description: string }>;
  auditEvents: number;
  buckets: Array<{ id: string; name: string; public: boolean; file_size_limit: number | null }>;
  database: { authority: string; accessModel: string; rls: { state: string; evidence: string } };
  auth: { authority: string; sessionModel: string; elevatedChange: string };
  integrations: Array<{
    consumerId: string;
    displayName: string;
    status: string;
    schemas: string[];
    buckets: string[];
    observability: { phase: string; binding: string | null; observedAt: string | null } | null;
  }>;
}

interface GiteaDetail {
  meta: { checkedAt: string; organization: string };
  ready: boolean;
  managementReady: boolean;
  version: string;
  repositoryCount: number | null;
  repositories: Array<{
    name: string;
    private: boolean;
    archived: boolean;
    empty: boolean;
    defaultBranch: string;
    updatedAt: string | null;
    sizeKiB: number;
  }>;
  byStatus: Record<string, number>;
  receipts: Array<{
    event_type: string;
    disposition: string;
    signature_valid: boolean;
    received_at: string;
  }>;
  supplyChain: {
    repository: string;
    defaultBranch: string;
    protected: boolean;
    requiredApprovals: number;
    directPushEnabled: boolean;
    signedCommitsRequired: boolean;
    blockRejectedReviews: boolean;
    blockOutdatedBranch?: boolean;
    blockAdminMergeOverride?: boolean;
    verifiedMergeRequired?: boolean;
  } | null;
}

interface BeszelPoint {
  timestamp: string;
  cpuPercent: number | null;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  memoryPercent: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskPercent: number | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  networkSendBytesPerSecond: number | null;
  networkReceiveBytesPerSecond: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  gapBefore: boolean;
}

interface BeszelMetrics {
  schemaVersion: 'rcc.host.metrics/v1';
  source: { name: string; agentVersion: string; mode: string };
  range: BeszelRange;
  sourceResolution: string;
  resolutionSeconds: number;
  generatedAt: string;
  system: {
    name: string;
    status: string;
    updatedAt: string | null;
    freshness: string;
    latestAgeSeconds: number | null;
  };
  truncated: boolean;
  gapCount: number;
  points: BeszelPoint[];
  latest: BeszelPoint | null;
  warnings: string[];
}

type PointKey =
  | 'cpuPercent'
  | 'memoryPercent'
  | 'diskPercent'
  | 'networkSendBytesPerSecond'
  | 'networkReceiveBytesPerSecond'
  | 'diskReadBytesPerSecond'
  | 'diskWriteBytesPerSecond'
  | 'load1'
  | 'load5'
  | 'load15';

interface ChartView {
  id: string;
  title: string;
  unit: string;
  description: string;
  data: ChartTabularData;
  options: LineChartOptions;
  startAt: string | null;
  endAt: string | null;
}

const PRODUCT = {
  supabase: {
    title: 'BBSS · Supabase',
    tag: 'Data & Identity backbone',
    description: 'RCC 인증·권한·업무 데이터·감사·객체 저장 권위의 가용성과 용량 근거입니다.',
    ownerRoute: '/manage/data-identity',
    ownerLabel: 'Data & Identity 운영 화면',
    logo: 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/supabase-2.svg',
    logoAlt: 'Supabase',
  },
  gitea: {
    title: 'BBSS · Gitea',
    tag: 'Declarative Change backbone',
    description: '선언형 변경 정본, 보호 브랜치, webhook과 reconcile 증거의 가용성입니다.',
    ownerRoute: '/manage/change-control',
    ownerLabel: 'Change Control 운영 화면',
    logo: 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/gitea.svg',
    logoAlt: 'Gitea',
  },
  beszel: {
    title: 'BBSS · Beszel',
    tag: 'Host Time-series backbone',
    description: '호스트 상태와 CPU·메모리·디스크·네트워크 시계열의 수집 신선도입니다.',
    ownerRoute: '/cc/cc2/hosts',
    ownerLabel: 'Linux Host Metrics 화면',
    logo: 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/beszel-light.svg',
    logoAlt: 'Beszel',
  },
} as const;

const RANGE_LABEL: Record<BeszelRange, string> = {
  '1h': '1시간',
  '12h': '12시간',
  '24h': '24시간',
  '1w': '7일',
  '30d': '30일',
};

/**
 * BBSS product evidence view.
 *
 * All product pages consume the admin-gated BBSS projection first. Supplemental
 * reads stay on existing owner APIs; Beszel remains behind the RCC readonly
 * adapter. A supplemental failure degrades only its section and never erases
 * the runtime evidence already proven by BBSS.
 */
@Component({
  selector: 'os-admin-bbss-service',
  imports: [
    RouterLink,
    ClarityModule,
    LineChartComponent,
    BackendUnavailable,
    CarbonIcon,
    OsPageHeader,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page product-page">
      <nav class="breadcrumbs" aria-label="BBSS 위치">
        <a routerLink="/manage/bbss">Backbone Service Stack</a><span>/</span
        ><strong>{{ serviceName() }}</strong>
      </nav>

      <div class="product-heading">
        <div class="product-logo-shell">
          <img [src]="config.logo" [alt]="config.logoAlt + ' logo'" width="176" height="48" />
        </div>
        <os-page-header [title]="config.title" [tag]="config.tag">
          <p>{{ config.description }}</p>
        </os-page-header>
      </div>

      @if (down(); as detail) {
        <os-backend-unavailable
          [feature]="config.title"
          backend="opensphere-console-backend (/api/admin/bbss/status)"
          hint="제품 자체 상태와 Kubernetes runtime 증거를 함께 읽지 못했습니다. 세션과 BBSS Backend를 확인하세요."
          [detail]="detail"
        />
      } @else if (service(); as current) {
        <div class="page-lead">
          <div>
            <strong>{{ current.role }}</strong>
            <p>
              Ready만으로 정상 처리하지 않고 owner API, 수집 신선도와 미구성 항목을 함께 표시합니다.
            </p>
          </div>
          <div class="page-actions">
            <span>{{ formatDate(status()?.generatedAt) }}</span>
            <a class="btn btn-sm btn-link" [routerLink]="config.ownerRoute">{{
              config.ownerLabel
            }}</a>
            <button
              class="icon-button"
              type="button"
              aria-label="제품 상태 새로고침"
              [disabled]="busy()"
              (click)="refresh()"
            >
              <os-cicon [icon]="icons.renew" [size]="16" />
            </button>
          </div>
        </div>

        <section class="status-rail" [attr.aria-label]="current.name + ' 핵심 상태'">
          <div class="rail-cell primary">
            <span>제품 판정</span>
            <strong [class]="stateClass(current.state)">
              <os-cicon
                [icon]="current.state === 'Healthy' ? icons.check : icons.warning"
                [size]="14"
              />
              {{ stateLabel(current.state) }}
            </strong>
            <small>{{ current.version ? 'version ' + current.version : 'version 미수집' }}</small>
          </div>
          <div class="rail-cell">
            <span>Runtime</span><strong>{{ ready(current) }}/{{ current.components.length }}</strong
            ><small>구성요소 Ready</small>
          </div>
          <div class="rail-cell">
            <span>Restart</span
            ><strong [class.tone-warn]="restarts(current) > 0">{{ restarts(current) }}</strong
            ><small>현재 Pod 누적</small>
          </div>
          <div class="rail-cell">
            <span>현재 CPU</span><strong>{{ formatCpu(current.capacity.cpuMillicores) }}</strong
            ><small>metrics-server point</small>
          </div>
          <div class="rail-cell">
            <span>현재 메모리</span><strong>{{ formatBytes(current.capacity.memoryBytes) }}</strong
            ><small>metrics-server point</small>
          </div>
          <div class="rail-cell">
            <span>PVC 요청</span><strong>{{ formatBytes(current.capacity.requestedBytes) }}</strong
            ><small>{{ current.capacity.pvcCount }} claims</small>
          </div>
        </section>

        @if (current.state !== 'Healthy') {
          <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
            <clr-alert-item>
              <span class="alert-text"
                >제품 runtime과 연계 기능은 별도 판정입니다. 아래 상태 근거에서 주의 원인을
                확인하세요.</span
              >
            </clr-alert-item>
          </clr-alert>
        }

        <section class="two-column">
          <article class="panel">
            <div class="panel-header">
              <h2>상태 근거</h2>
              <p>제품 owner API 또는 readonly source가 직접 증명한 항목입니다.</p>
            </div>
            <div class="check-list">
              @for (check of current.checks; track check.id) {
                <div>
                  <span [class]="stateDotClass(check.state)" aria-hidden="true"></span>
                  <strong>{{ check.name }}</strong>
                  <span [class]="stateClass(check.state)">{{ stateLabel(check.state) }}</span>
                  <small>{{ check.detail }}</small>
                </div>
              } @empty {
                <p class="empty">제품 상태 근거가 없습니다.</p>
              }
            </div>
          </article>

          <article class="panel">
            <div class="panel-header">
              <h2>현재 업무·수집 값</h2>
              <p>inventory와 현재 조회 범위를 처리량 시계열과 구분합니다.</p>
            </div>
            <div class="activity-grid">
              @for (item of current.activity; track item.label) {
                <div>
                  <span>{{ item.label }}</span>
                  <strong>{{ activityValue(item) }}</strong>
                  <small>{{ activityKind(item.kind) }}</small>
                </div>
              }
            </div>
          </article>
        </section>

        @if (productId === 'supabase') {
          @if (ownerDown(); as detail) {
            <clr-alert clrAlertType="warning" [clrAlertClosable]="false"
              ><clr-alert-item
                ><span class="alert-text">{{ detail }}</span></clr-alert-item
              ></clr-alert
            >
          }
          @if (supabase(); as owner) {
            <section class="three-column product-evidence">
              <article class="panel compact-card">
                <div class="panel-header">
                  <h2>{{ owner.database.authority }}</h2>
                  <p>Database authority</p>
                </div>
                <dl>
                  <div>
                    <dt>RLS</dt>
                    <dd>{{ owner.database.rls.state }}</dd>
                  </div>
                  <div>
                    <dt>접근 경계</dt>
                    <dd>{{ owner.database.accessModel }}</dd>
                  </div>
                  <div>
                    <dt>증거</dt>
                    <dd>{{ owner.database.rls.evidence }}</dd>
                  </div>
                </dl>
              </article>
              <article class="panel compact-card">
                <div class="panel-header">
                  <h2>{{ owner.auth.authority }}</h2>
                  <p>Session and assurance</p>
                </div>
                <dl>
                  <div>
                    <dt>세션</dt>
                    <dd>{{ owner.auth.sessionModel }}</dd>
                  </div>
                  <div>
                    <dt>고위험 변경</dt>
                    <dd>{{ owner.auth.elevatedChange }}</dd>
                  </div>
                </dl>
              </article>
              <article class="panel compact-card">
                <div class="panel-header">
                  <h2>권위 Inventory</h2>
                  <p>현재 bounded 조회</p>
                </div>
                <dl>
                  <div>
                    <dt>Operators</dt>
                    <dd>{{ owner.operators }}</dd>
                  </div>
                  <div>
                    <dt>Roles</dt>
                    <dd>{{ owner.roles.length }}</dd>
                  </div>
                  <div>
                    <dt>Audit sample</dt>
                    <dd>{{ owner.auditEvents }}</dd>
                  </div>
                  <div>
                    <dt>Buckets</dt>
                    <dd>{{ owner.buckets.length }}</dd>
                  </div>
                </dl>
              </article>
            </section>

            <section class="two-column">
              <article class="panel">
                <div class="panel-header">
                  <h2>역할 계약</h2>
                  <p>Console이 요청마다 평가하는 역할입니다.</p>
                </div>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (role of owner.roles; track role.id) {
                        <tr>
                          <td>
                            <strong>{{ role.code }}</strong>
                          </td>
                          <td>{{ role.description }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </article>
              <article class="panel">
                <div class="panel-header">
                  <h2>Storage buckets</h2>
                  <p>객체 저장 경계와 파일 한도입니다.</p>
                </div>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Bucket</th>
                        <th>공개 범위</th>
                        <th>파일 한도</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (bucket of owner.buckets; track bucket.id) {
                        <tr>
                          <td>
                            <strong>{{ bucket.name }}</strong>
                          </td>
                          <td>{{ bucket.public ? 'public' : 'private' }}</td>
                          <td>{{ bucketLimit(bucket.file_size_limit) }}</td>
                        </tr>
                      } @empty {
                        <tr>
                          <td colspan="3">등록된 bucket이 없습니다.</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </article>
            </section>

            <section class="panel">
              <div class="panel-header">
                <h2>Consumer integrations</h2>
                <p>Supabase 경계와 HIS observability binding을 함께 표시합니다.</p>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Consumer</th>
                      <th>상태</th>
                      <th>Schemas</th>
                      <th>Buckets</th>
                      <th>Observability</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (item of owner.integrations; track item.consumerId) {
                      <tr>
                        <td>
                          <strong>{{ item.displayName || item.consumerId }}</strong
                          ><small>{{ item.consumerId }}</small>
                        </td>
                        <td>{{ item.status }}</td>
                        <td>{{ join(item.schemas) || '—' }}</td>
                        <td>{{ join(item.buckets) || '—' }}</td>
                        <td>
                          {{ item.observability?.phase || 'NotConfigured'
                          }}<small>{{ item.observability?.binding || 'binding 없음' }}</small>
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="5">등록된 consumer contract가 없습니다.</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }
        }

        @if (productId === 'gitea') {
          @if (ownerDown(); as detail) {
            <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
              <clr-alert-item
                ><span class="alert-text"
                  >{{ detail }} Gitea 엔진 상태는 위 BBSS 근거로 계속 확인할 수 있습니다.</span
                ></clr-alert-item
              >
            </clr-alert>
          }
          @if (gitea(); as owner) {
            <section class="three-column product-evidence">
              <article class="panel compact-card">
                <div class="panel-header">
                  <h2>Gitea API</h2>
                  <p>{{ owner.meta.organization }}</p>
                </div>
                <dl>
                  <div>
                    <dt>Version</dt>
                    <dd>{{ owner.version }}</dd>
                  </div>
                  <div>
                    <dt>API</dt>
                    <dd>{{ owner.ready ? 'Ready' : 'Unavailable' }}</dd>
                  </div>
                  <div>
                    <dt>관리 연계</dt>
                    <dd>{{ owner.managementReady ? 'Ready' : 'Attention' }}</dd>
                  </div>
                </dl>
              </article>
              <article class="panel compact-card">
                <div class="panel-header">
                  <h2>Governed changes</h2>
                  <p>Supabase projection</p>
                </div>
                <dl>
                  <div>
                    <dt>Pending</dt>
                    <dd>{{ pendingChanges(owner) }}</dd>
                  </div>
                  <div>
                    <dt>Applied</dt>
                    <dd>{{ owner.byStatus['applied'] ?? 0 }}</dd>
                  </div>
                  <div>
                    <dt>Failed</dt>
                    <dd>{{ owner.byStatus['failed'] ?? 0 }}</dd>
                  </div>
                  <div>
                    <dt>Webhook receipts</dt>
                    <dd>{{ owner.receipts.length }}</dd>
                  </div>
                </dl>
              </article>
              <article class="panel compact-card">
                <div class="panel-header">
                  <h2>Supply chain</h2>
                  <p>보호 브랜치 계약</p>
                </div>
                @if (owner.supplyChain; as policy) {
                  <dl>
                    <div>
                      <dt>Repository</dt>
                      <dd>{{ policy.repository }}</dd>
                    </div>
                    <div>
                      <dt>Branch</dt>
                      <dd>{{ policy.defaultBranch }}</dd>
                    </div>
                    <div>
                      <dt>보호</dt>
                      <dd>{{ policy.protected ? 'Enforced' : 'Missing' }}</dd>
                    </div>
                    <div>
                      <dt>승인</dt>
                      <dd>{{ policy.requiredApprovals }}</dd>
                    </div>
                    <div>
                      <dt>서명 commit</dt>
                      <dd>{{ policy.signedCommitsRequired ? 'Required' : 'Not enforced' }}</dd>
                    </div>
                    <div>
                      <dt>직접 push</dt>
                      <dd>{{ policy.directPushEnabled ? 'Allowed' : 'Denied' }}</dd>
                    </div>
                  </dl>
                } @else {
                  <p class="empty">보호 브랜치 증거를 읽지 못했습니다.</p>
                }
              </article>
            </section>

            <section class="panel">
              <div class="panel-header">
                <h2>Repository inventory</h2>
                <p>Gitea API가 직접 반환한 현재 저장소입니다.</p>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Repository</th>
                      <th>Visibility</th>
                      <th>Default branch</th>
                      <th>상태</th>
                      <th>Logical size</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (repository of owner.repositories; track repository.name) {
                      <tr>
                        <td>
                          <strong>{{ repository.name }}</strong>
                        </td>
                        <td>{{ repository.private ? 'private' : 'public' }}</td>
                        <td>{{ repository.defaultBranch || '—' }}</td>
                        <td>
                          {{
                            repository.archived ? 'archived' : repository.empty ? 'empty' : 'active'
                          }}
                        </td>
                        <td>{{ formatBytes(repository.sizeKiB * 1024) }}</td>
                        <td>{{ formatDate(repository.updatedAt) }}</td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="6">Repository inventory가 없습니다.</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }
        }

        <section class="panel metrics-panel">
          <div class="panel-header metrics-header">
            <div>
              <h2>{{ telemetryTitle() }}</h2>
              <p>
                {{ telemetryDescription() }} Carbon Charts는 Beszel readonly API의 실제 집계 점만
                그리며, gap은 선을 이어 왜곡하지 않습니다.
              </p>
            </div>
            <div class="range-controls" role="group" aria-label="Beszel 시계열 범위">
              @for (item of ranges; track item) {
                <button
                  type="button"
                  [class.active]="range() === item"
                  [disabled]="metricsBusy()"
                  (click)="setRange(item)"
                >
                  {{ rangeLabel(item) }}
                </button>
              }
            </div>
          </div>

          @if (productId !== 'beszel') {
            <div class="telemetry-boundary">
              <strong>공통 호스트 영향 지표</strong>
              <span
                >이 차트는 {{ serviceName() }} 프로세스 전용 사용량이나 서비스 가동률이 아닙니다.
                제품 자체의 현재 가용성은 상단 Runtime·owner API 근거로 판정합니다.</span
              >
            </div>
          }
          @if (metricsDown(); as detail) {
            <clr-alert clrAlertType="warning" [clrAlertClosable]="false"
              ><clr-alert-item
                ><span class="alert-text">{{ detail }}</span></clr-alert-item
              ></clr-alert
            >
          }
          @if (metrics(); as sample) {
            <section class="metrics-rail">
              <div>
                <span>System</span><strong>{{ sample.system.name }}</strong
                ><small>{{ sample.system.status }} · {{ sample.system.freshness }}</small>
              </div>
              <div>
                <span>Points</span><strong>{{ sample.points.length }}</strong
                ><small>{{ sample.sourceResolution }} source</small>
              </div>
              <div>
                <span>Latest age</span
                ><strong>{{
                  sample.system.latestAgeSeconds === null
                    ? '—'
                    : sample.system.latestAgeSeconds + 's'
                }}</strong
                ><small>{{ formatDate(sample.generatedAt) }}</small>
              </div>
              <div>
                <span>Collection gaps</span
                ><strong [class.tone-warn]="sample.gapCount > 0">{{ sample.gapCount }}</strong
                ><small>{{ sample.truncated ? 'bounded response' : 'not truncated' }}</small>
              </div>
              <div>
                <span>Agent</span><strong>{{ sample.source.agentVersion || '—' }}</strong
                ><small>{{ sample.source.mode }}</small>
              </div>
            </section>

            @if (sample.latest; as latest) {
              <section class="latest-grid">
                <div>
                  <span>CPU</span><strong>{{ formatPercent(latest.cpuPercent) }}</strong>
                </div>
                <div>
                  <span>Memory</span><strong>{{ formatPercent(latest.memoryPercent) }}</strong
                  ><small
                    >{{ formatBytes(latest.memoryUsedBytes) }} /
                    {{ formatBytes(latest.memoryTotalBytes) }}</small
                  >
                </div>
                <div>
                  <span>Disk</span><strong>{{ formatPercent(latest.diskPercent) }}</strong
                  ><small
                    >{{ formatBytes(latest.diskUsedBytes) }} /
                    {{ formatBytes(latest.diskTotalBytes) }}</small
                  >
                </div>
                <div>
                  <span>Network ↑ / ↓</span
                  ><strong
                    >{{ formatRate(latest.networkSendBytesPerSecond) }} /
                    {{ formatRate(latest.networkReceiveBytesPerSecond) }}</strong
                  >
                </div>
                <div>
                  <span>Disk read / write</span
                  ><strong
                    >{{ formatRate(latest.diskReadBytesPerSecond) }} /
                    {{ formatRate(latest.diskWriteBytesPerSecond) }}</strong
                  >
                </div>
                <div>
                  <span>Load 1 / 5 / 15</span
                  ><strong
                    >{{ formatLoad(latest.load1) }} / {{ formatLoad(latest.load5) }} /
                    {{ formatLoad(latest.load15) }}</strong
                  >
                </div>
              </section>
            }

            @if (charts().length) {
              <section class="chart-grid" aria-label="IBM Carbon Charts 기반 Beszel 시계열">
                @for (chart of charts(); track chart.id) {
                  <article class="chart-card">
                    <div class="chart-header">
                      <div>
                        <h3>{{ chart.title }}</h3>
                        <small>{{ chart.description }}</small>
                      </div>
                      <span class="carbon-mark">IBM Carbon Charts</span>
                    </div>
                    <ibm-line-chart
                      [data]="chart.data"
                      [options]="chart.options"
                      width="100%"
                      height="15rem"
                    />
                    <footer>
                      <span>{{ formatShortDate(chart.startAt) }}</span
                      ><span>{{ chart.unit }}</span
                      ><span>{{ formatShortDate(chart.endAt) }}</span>
                    </footer>
                  </article>
                }
              </section>
            } @else {
              <p class="empty metrics-empty">선택한 범위에 표시할 Beszel 시계열 점이 없습니다.</p>
            }

            @if (sample.warnings.length) {
              <div class="warning-list">
                @for (warning of sample.warnings; track warning) {
                  <p>{{ warning }}</p>
                }
              </div>
            }
          } @else if (metricsBusy()) {
            <div class="loading-inline">
              <span class="spinner spinner-sm"></span>Beszel 시계열을 불러오는 중입니다.
            </div>
          }
        </section>

        <section class="two-column">
          <article class="panel">
            <div class="panel-header">
              <h2>Runtime 구성요소</h2>
              <p>Kubernetes의 replica, restart와 실제 배포 image입니다.</p>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>구성요소</th>
                    <th>종류</th>
                    <th>상태</th>
                    <th>Ready</th>
                    <th>Available</th>
                    <th>Restart</th>
                    <th>Image</th>
                  </tr>
                </thead>
                <tbody>
                  @for (component of current.components; track component.id) {
                    <tr>
                      <td>
                        <strong>{{ component.name }}</strong
                        ><small>{{ component.version || 'version 미수집' }}</small>
                      </td>
                      <td>{{ component.kind }}</td>
                      <td>
                        <span [class]="stateClass(component.state)">{{
                          stateLabel(component.state)
                        }}</span>
                      </td>
                      <td>{{ component.ready }}/{{ component.desired }}</td>
                      <td>{{ component.available }}</td>
                      <td [class.tone-warn]="component.restarts > 0">{{ component.restarts }}</td>
                      <td class="mono">{{ shortImage(component.images[0]) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </article>

          <article class="panel">
            <div class="panel-header">
              <h2>Persistent storage</h2>
              <p>요청·프로비저닝 용량이며 실제 파일시스템 사용량과 다릅니다.</p>
            </div>
            <div class="capacity-note">
              <span
                >요청 <strong>{{ formatBytes(current.capacity.requestedBytes) }}</strong></span
              >
              <span
                >프로비저닝 <strong>{{ formatBytes(current.capacity.capacityBytes) }}</strong></span
              >
              <span
                >실사용
                <strong>{{
                  current.capacity.actualUsedBytes === null
                    ? '미수집'
                    : formatBytes(current.capacity.actualUsedBytes)
                }}</strong></span
              >
              @if (current.capacity.logicalUsedBytes !== undefined) {
                <span
                  >논리 inventory
                  <strong>{{ formatBytes(current.capacity.logicalUsedBytes) }}</strong></span
                >
              }
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Claim</th>
                    <th>상태</th>
                    <th>StorageClass</th>
                    <th>요청</th>
                    <th>Capacity</th>
                  </tr>
                </thead>
                <tbody>
                  @for (claim of current.capacity.claims; track claim.name) {
                    <tr>
                      <td>
                        <strong>{{ claim.name }}</strong>
                      </td>
                      <td>{{ claim.state }}</td>
                      <td>{{ claim.storageClass || '—' }}</td>
                      <td>{{ formatBytes(claim.requestedBytes) }}</td>
                      <td>{{ formatBytes(claim.capacityBytes) }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5">PersistentVolumeClaim이 없습니다.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </article>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>주의와 데이터 한계</h2>
            <p>수집되지 않는 값을 정상이나 0으로 오인하지 않기 위한 명시적 경계입니다.</p>
          </div>
          <div class="warning-list">
            @for (warning of current.warnings; track warning) {
              <p>{{ warning }}</p>
            } @empty {
              <p>현재 제품 경고가 없습니다.</p>
            }
          </div>
        </section>
      } @else {
        <div class="loading-state">
          <span class="spinner spinner-md"></span>
          <p>{{ config.title }} 상태를 불러오는 중입니다.</p>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .product-page {
        max-width: 96rem;
      }
      .breadcrumbs {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        margin-bottom: 0.65rem;
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .breadcrumbs a {
        color: var(--os-accent);
        text-decoration: none;
      }
      .breadcrumbs strong {
        color: var(--os-ink);
      }
      .product-heading {
        display: grid;
        grid-template-columns: 4.5rem minmax(0, 1fr);
        align-items: start;
        gap: 1rem;
        margin-bottom: 0.75rem;
        padding: 0.9rem 1rem;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .product-logo-shell {
        display: grid;
        place-items: center;
        width: 4.5rem;
        height: 4.5rem;
        padding: 0;
        border: 0;
        background: transparent;
      }
      .product-logo-shell img {
        display: block;
        width: 100%;
        height: 100%;
        max-width: 4rem;
        max-height: 4rem;
        object-fit: contain;
      }
      .product-heading os-page-header {
        min-width: 0;
        padding: 0.1rem 0 0;
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
        font-size: 0.76rem;
      }
      .page-lead p {
        margin: 0;
        color: var(--os-ink-muted);
        font-size: 0.6rem;
      }
      .page-actions {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .icon-button {
        display: grid;
        place-items: center;
        width: 1.8rem;
        height: 1.8rem;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
        color: var(--os-accent);
        cursor: pointer;
      }
      .icon-button:disabled {
        opacity: 0.5;
      }
      .status-rail {
        display: grid;
        grid-template-columns: 1.35fr repeat(5, minmax(0, 1fr));
        margin: 0.75rem 0;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .rail-cell {
        display: grid;
        gap: 0.16rem;
        padding: 0.68rem 0.75rem;
        border-right: 1px solid var(--os-hairline);
      }
      .rail-cell:last-child {
        border-right: 0;
      }
      .rail-cell.primary {
        background: var(--os-surface-1);
      }
      .rail-cell span,
      .rail-cell small {
        color: var(--os-ink-muted);
        font-size: 0.54rem;
      }
      .rail-cell strong {
        display: flex;
        align-items: center;
        gap: 0.22rem;
        font-size: 0.75rem;
      }
      .two-column {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch;
        gap: 0.75rem;
        margin: 0.75rem 0;
      }
      .three-column {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        align-items: stretch;
        gap: 0.75rem;
        margin: 0.75rem 0;
      }
      .panel {
        min-width: 0;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .panel > .panel-header {
        min-height: 3.2rem;
        padding: 0.65rem 0.75rem;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
      }
      .panel h2,
      .panel h3 {
        margin: 0;
        color: var(--os-ink);
        font-size: 0.76rem;
      }
      .panel-header p {
        margin: 0.15rem 0 0;
        color: var(--os-ink-muted);
        font-size: 0.54rem;
        line-height: 1.45;
      }
      .check-list {
        display: grid;
      }
      .check-list > div {
        display: grid;
        grid-template-columns: 0.55rem minmax(7rem, 0.75fr) auto minmax(9rem, 1.25fr);
        align-items: center;
        gap: 0.4rem;
        padding: 0.48rem 0.65rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .check-list > div:last-child {
        border-bottom: 0;
      }
      .check-list strong {
        font-size: 0.59rem;
      }
      .check-list small {
        color: var(--os-ink-muted);
        font-size: 0.53rem;
      }
      .activity-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .activity-grid div {
        display: grid;
        gap: 0.08rem;
        padding: 0.65rem;
        border-right: 1px solid var(--os-hairline);
        border-bottom: 1px solid var(--os-hairline);
      }
      .activity-grid div:nth-child(2n) {
        border-right: 0;
      }
      .activity-grid span,
      .activity-grid small {
        color: var(--os-ink-muted);
        font-size: 0.52rem;
      }
      .activity-grid strong {
        font-size: 0.78rem;
      }
      .compact-card dl {
        margin: 0;
      }
      .compact-card dl div {
        display: grid;
        grid-template-columns: 6.5rem minmax(0, 1fr);
        gap: 0.45rem;
        padding: 0.48rem 0.65rem;
        border-bottom: 1px solid var(--os-hairline);
        font-size: 0.56rem;
      }
      .compact-card dt {
        color: var(--os-ink-muted);
      }
      .compact-card dd {
        margin: 0;
        font-weight: 600;
        line-height: 1.45;
      }
      .empty {
        margin: 0.75rem;
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .table-wrap {
        overflow: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 0.47rem 0.58rem;
        border-bottom: 1px solid var(--os-hairline);
        text-align: left;
        vertical-align: top;
        white-space: nowrap;
        font-size: 0.56rem;
      }
      th {
        color: var(--os-ink-muted);
        background: var(--os-surface-2);
        font-size: 0.51rem;
        font-weight: 600;
      }
      td small {
        display: block;
        margin-top: 0.1rem;
        color: var(--os-ink-muted);
        font-size: 0.49rem;
      }
      .mono {
        max-width: 17rem;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .capacity-note {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        border-bottom: 1px solid var(--os-hairline);
      }
      .capacity-note span {
        display: grid;
        gap: 0.1rem;
        padding: 0.5rem 0.65rem;
        color: var(--os-ink-muted);
        font-size: 0.51rem;
      }
      .capacity-note strong {
        color: var(--os-ink);
        font-size: 0.63rem;
      }
      .metrics-panel {
        margin: 0.75rem 0;
      }
      .metrics-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }
      .range-controls {
        display: flex;
        gap: 0.2rem;
      }
      .range-controls button {
        padding: 0.28rem 0.48rem;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
        color: var(--os-ink-muted);
        font-size: 0.52rem;
        cursor: pointer;
      }
      .range-controls button.active {
        border-color: var(--os-accent);
        background: var(--os-accent);
        color: #fff;
      }
      .range-controls button:disabled {
        opacity: 0.55;
      }
      .telemetry-boundary {
        display: flex;
        align-items: flex-start;
        gap: 0.65rem;
        padding: 0.55rem 0.7rem;
        border-bottom: 1px solid #f1c21b;
        background: #fff8e1;
      }
      .telemetry-boundary strong {
        flex: 0 0 auto;
        color: #684e00;
        font-size: 0.56rem;
      }
      .telemetry-boundary span {
        color: #684e00;
        font-size: 0.53rem;
        line-height: 1.45;
      }
      .metrics-rail {
        display: grid;
        grid-template-columns: 1.3fr repeat(4, 1fr);
        border-bottom: 1px solid var(--os-hairline);
      }
      .metrics-rail div,
      .latest-grid div {
        display: grid;
        gap: 0.08rem;
        padding: 0.55rem 0.65rem;
        border-right: 1px solid var(--os-hairline);
      }
      .metrics-rail div:last-child,
      .latest-grid div:last-child {
        border-right: 0;
      }
      .metrics-rail span,
      .metrics-rail small,
      .latest-grid span,
      .latest-grid small {
        color: var(--os-ink-muted);
        font-size: 0.5rem;
      }
      .metrics-rail strong,
      .latest-grid strong {
        font-size: 0.66rem;
      }
      .latest-grid {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        border-bottom: 1px solid var(--os-hairline);
        background: #f4f8ff;
      }
      .chart-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch;
        gap: 0.65rem;
        padding: 0.65rem;
      }
      .chart-card {
        min-width: 0;
        overflow: hidden;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .chart-card > .chart-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.5rem;
        min-height: 3.1rem;
        padding: 0.48rem 0.55rem;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
      }
      .chart-card h3 {
        font-size: 0.62rem;
      }
      .chart-header small {
        display: block;
        margin-top: 0.08rem;
        color: var(--os-ink-muted);
        font-size: 0.48rem;
      }
      .carbon-mark {
        flex: 0 0 auto;
        padding: 0.12rem 0.35rem;
        background: #161616;
        color: #fff;
        font-size: 0.43rem;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .chart-card ibm-line-chart {
        display: block;
        min-height: 15rem;
      }
      .chart-card footer {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 0.4rem;
        padding: 0.3rem 0.5rem;
        border-top: 1px solid var(--os-hairline);
        color: var(--os-ink-muted);
        font-size: 0.46rem;
      }
      .chart-card footer span:last-child {
        text-align: right;
      }
      .metrics-empty {
        padding: 2rem;
        text-align: center;
      }
      .loading-inline {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 2rem;
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .warning-list {
        display: grid;
      }
      .warning-list p {
        margin: 0;
        padding: 0.47rem 0.65rem;
        border-bottom: 1px solid var(--os-hairline);
        color: var(--os-ink-muted);
        font-size: 0.54rem;
        line-height: 1.45;
      }
      .warning-list p:last-child {
        border-bottom: 0;
      }
      .state-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.2rem;
        width: max-content;
        padding: 0.12rem 0.4rem;
        border-radius: 1rem;
        font-size: 0.54rem;
        font-weight: 700;
        white-space: nowrap;
      }
      .state-healthy {
        color: #0e6027;
        background: #defbe6;
      }
      .state-degraded,
      .state-stale {
        color: #7a4d00;
        background: #fff3c4;
      }
      .state-unavailable {
        color: #a2191f;
        background: #fff1f1;
      }
      .state-notconfigured {
        color: #525252;
        background: #e8e8e8;
      }
      .state-dot {
        width: 0.48rem;
        height: 0.48rem;
        border-radius: 50%;
      }
      .dot-healthy {
        background: #24a148;
      }
      .dot-degraded,
      .dot-stale {
        background: #f1c21b;
      }
      .dot-unavailable {
        background: #da1e28;
      }
      .dot-notconfigured {
        background: #8d8d8d;
      }
      .tone-warn {
        color: #a15c00 !important;
      }
      .loading-state {
        display: grid;
        justify-items: center;
        gap: 0.6rem;
        padding: 4rem;
        color: var(--os-ink-muted);
        font-size: 0.64rem;
      }
      @media (max-width: 84rem) {
        .status-rail {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .rail-cell {
          border-bottom: 1px solid var(--os-hairline);
        }
        .three-column {
          grid-template-columns: 1fr;
        }
        .latest-grid {
          grid-template-columns: repeat(3, 1fr);
        }
        .metrics-rail {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 64rem) {
        .two-column,
        .chart-grid {
          grid-template-columns: 1fr;
        }
        .page-lead,
        .metrics-header {
          align-items: flex-start;
          flex-direction: column;
        }
        .latest-grid,
        .metrics-rail {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @media (max-width: 42rem) {
        .product-heading {
          grid-template-columns: 3.5rem minmax(0, 1fr);
          gap: 0.75rem;
          padding: 0.75rem;
        }
        .product-logo-shell {
          width: 3.5rem;
          height: 3.5rem;
        }
        .product-logo-shell img {
          max-width: 3.25rem;
          max-height: 3.25rem;
        }
        .status-rail {
          grid-template-columns: 1fr;
        }
        .rail-cell {
          border-right: 0;
        }
        .page-actions {
          align-items: flex-start;
          flex-wrap: wrap;
        }
        .check-list > div {
          grid-template-columns: 0.55rem 1fr auto;
        }
        .check-list small {
          grid-column: 2/-1;
        }
        .activity-grid,
        .latest-grid,
        .metrics-rail {
          grid-template-columns: 1fr;
        }
        .range-controls {
          flex-wrap: wrap;
        }
        .telemetry-boundary {
          display: grid;
        }
      }
    `,
  ],
})
export class AdminBbssService implements OnInit, OnDestroy {
  readonly icons = { check: CheckmarkFilled16, renew: Renew16, warning: WarningAltFilled16 };
  readonly ranges: readonly BeszelRange[] = ['1h', '12h', '24h', '1w', '30d'];
  readonly status = signal<BbssStatus | null>(null);
  readonly service = signal<BbssService | null>(null);
  readonly supabase = signal<SupabaseDetail | null>(null);
  readonly gitea = signal<GiteaDetail | null>(null);
  readonly metrics = signal<BeszelMetrics | null>(null);
  readonly charts = signal<ChartView[]>([]);
  readonly down = signal('');
  readonly ownerDown = signal('');
  readonly metricsDown = signal('');
  readonly busy = signal(false);
  readonly metricsBusy = signal(false);
  readonly range = signal<BeszelRange>('1h');

  private readonly http = inject(HttpService);
  private readonly route = inject(ActivatedRoute);
  readonly productId = this.route.snapshot.data['bbssService'] as BbssProductId;
  readonly config = PRODUCT[this.productId] || PRODUCT.supabase;
  private timer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(true), 20_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.busy.set(true);
    try {
      const response = await this.http.request('/api/admin/bbss/status', { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result.error || `HTTP ${response.status}`));
      const status = result as BbssStatus;
      const service = status.services.find((item) => item.id === this.productId);
      if (!service) throw new Error(`${this.productId} status is missing from BBSS`);
      this.status.set(status);
      this.service.set(service);
      this.down.set('');
      await this.refreshSupplemental();
    } catch (error) {
      this.status.set(null);
      this.service.set(null);
      this.supabase.set(null);
      this.gitea.set(null);
      this.metrics.set(null);
      this.charts.set([]);
      this.down.set(`${this.config.title} 조회 실패: ${String(error)}`);
    } finally {
      if (!silent) this.busy.set(false);
    }
  }

  async setRange(range: BeszelRange): Promise<void> {
    if (this.range() === range) return;
    this.range.set(range);
    await this.refreshBeszel();
  }

  serviceName(): string {
    return this.service()?.name || this.productId;
  }

  stateLabel(state: BbssState): string {
    return (
      (
        {
          Healthy: '정상',
          Degraded: '주의',
          Unavailable: '사용 불가',
          Stale: '수집 지연',
          NotConfigured: '미구성',
        } as const
      )[state] || state
    );
  }

  stateClass(state: BbssState): string {
    return `state-pill state-${state.toLowerCase()}`;
  }

  stateDotClass(state: BbssState): string {
    return `state-dot dot-${state.toLowerCase()}`;
  }

  ready(service: BbssService): number {
    return service.components.filter((component) => component.state === 'Healthy').length;
  }

  restarts(service: BbssService): number {
    return service.components.reduce((sum, component) => sum + component.restarts, 0);
  }

  pendingChanges(value: GiteaDetail): number {
    return ['intent', 'authorized', 'committed'].reduce(
      (sum, key) => sum + Number(value.byStatus[key] || 0),
      0,
    );
  }

  rangeLabel(range: BeszelRange): string {
    return RANGE_LABEL[range];
  }

  telemetryTitle(): string {
    return this.productId === 'beszel'
      ? 'Beszel 호스트 시계열'
      : `${this.serviceName()} · 공통 CC2 호스트 시계열`;
  }

  telemetryDescription(): string {
    return this.productId === 'beszel'
      ? 'Beszel이 직접 소유하는 CC2 호스트 운영 시계열입니다.'
      : '이 제품이 동작하는 단일 CC2 호스트의 부하·포화도·I/O 환경입니다.';
  }

  formatCpu(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '미수집';
    return value >= 1000 ? `${(value / 1000).toFixed(2)} cores` : `${value}m`;
  }

  formatBytes(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '미수집';
    if (value === 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  }

  formatRate(value: number | null | undefined): string {
    const bytes = this.formatBytes(value);
    return bytes === '미수집' ? '—' : `${bytes}/s`;
  }

  bucketLimit(value: number | null): string {
    return value === null ? 'unlimited' : this.formatBytes(value);
  }

  formatPercent(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
      ? '—'
      : `${value.toFixed(1)}%`;
  }

  formatLoad(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
      ? '—'
      : value.toFixed(2);
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '기록 없음';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return (
      new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(date) + ' KST'
    );
  }

  formatShortDate(value: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  activityValue(item: BbssActivity): string {
    if (item.value === null || item.value === undefined || !Number.isFinite(item.value)) return '—';
    return `${new Intl.NumberFormat('ko-KR').format(item.value)}${item.unit ? ` ${item.unit}` : ''}`;
  }

  activityKind(kind: string): string {
    return (
      (
        {
          inventory: '현재 inventory',
          current: '현재 값',
          'bounded-current': '현재 조회 범위',
          'range-1h': '최근 1시간',
        } as Record<string, string>
      )[kind] || kind
    );
  }

  join(value: string[] | null | undefined): string {
    return (value || []).join(', ');
  }

  shortImage(value: string | null | undefined): string {
    const image = String(value || '');
    if (!image) return '미수집';
    return image.length > 76 ? `…${image.slice(-75)}` : image;
  }

  private async refreshSupplemental(): Promise<void> {
    const reads: Promise<void>[] = [this.refreshBeszel()];
    if (this.productId === 'supabase') {
      reads.push(
        this.fetchSupplemental(
          '/api/identity/supabase/status',
          (value) => this.supabase.set(value as SupabaseDetail),
          'Supabase authority 상세',
        ),
      );
    } else if (this.productId === 'gitea') {
      reads.push(
        this.fetchSupplemental(
          '/api/platform/gitea/status',
          (value) => this.gitea.set(value as GiteaDetail),
          'Gitea governed-change 상세',
        ),
      );
    } else {
      this.ownerDown.set('');
    }
    await Promise.all(reads);
  }

  private async fetchSupplemental(
    path: string,
    accept: (value: unknown) => void,
    label: string,
  ): Promise<void> {
    try {
      const response = await this.http.request(path, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result.error || `HTTP ${response.status}`));
      accept(result);
      this.ownerDown.set('');
    } catch (error) {
      if (path.includes('/identity/supabase/')) this.supabase.set(null);
      if (path.includes('/platform/gitea/')) this.gitea.set(null);
      this.ownerDown.set(`${label} 미수집: ${String(error)}`);
    }
  }

  private async refreshBeszel(): Promise<void> {
    const beszel = this.status()?.services.find((service) => service.id === 'beszel');
    const binding = beszel?.checks
      .map((check) => check.id)
      .find((id) => id.split('/').length === 2);
    if (!binding) {
      this.metrics.set(null);
      this.charts.set([]);
      this.metricsDown.set('Beszel host binding이 없어 시계열을 조회할 수 없습니다.');
      return;
    }
    const [controlCenterId, hostId] = binding.split('/');
    this.metricsBusy.set(true);
    try {
      const path = `/api/plugins/linux-host-manager/control-centers/${encodeURIComponent(controlCenterId)}/hosts/${encodeURIComponent(hostId)}/metrics?range=${this.range()}`;
      const response = await this.http.request(path, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result.error || `HTTP ${response.status}`));
      const metrics = result as BeszelMetrics;
      this.metrics.set(metrics);
      this.charts.set(this.buildCharts(metrics.points));
      this.metricsDown.set('');
    } catch (error) {
      this.metrics.set(null);
      this.charts.set([]);
      this.metricsDown.set(`Beszel 시계열 미수집: ${String(error)}`);
    } finally {
      this.metricsBusy.set(false);
    }
  }

  private buildCharts(points: BeszelPoint[]): ChartView[] {
    if (!points.length) return [];
    const definitions: Array<{
      id: string;
      title: string;
      unit: string;
      description: string;
      fixedMax?: number;
      fields: Array<{ key: PointKey; label: string; color: string }>;
    }> = [
      {
        id: 'utilization',
        title: 'CPU · Memory · Disk',
        unit: '%',
        description: '호스트 자원 사용률',
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
        unit: 'B/s',
        description: '호스트 송·수신 처리량',
        fields: [
          { key: 'networkSendBytesPerSecond', label: 'Send', color: '#1192e8' },
          { key: 'networkReceiveBytesPerSecond', label: 'Receive', color: '#005d5d' },
        ],
      },
      {
        id: 'disk-io',
        title: 'Disk I/O',
        unit: 'B/s',
        description: '호스트 디스크 읽기·쓰기 처리량',
        fields: [
          { key: 'diskReadBytesPerSecond', label: 'Read', color: '#fa4d56' },
          { key: 'diskWriteBytesPerSecond', label: 'Write', color: '#9f1853' },
        ],
      },
      {
        id: 'load',
        title: 'Load average',
        unit: 'load',
        description: '호스트 1·5·15분 부하 평균',
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
        points.forEach((point, index) => {
          const date = new Date(point.timestamp);
          if (Number.isNaN(date.getTime())) return;
          if (point.gapBefore && index > 0) {
            const previous = Date.parse(points[index - 1].timestamp);
            if (Number.isFinite(previous)) {
              data.push({
                group: field.label,
                date: new Date(previous + (date.getTime() - previous) / 2),
                value: null,
              });
            }
          }
          const value = point[field.key];
          data.push({
            group: field.label,
            date,
            value: value === null || !Number.isFinite(value) ? null : value,
          });
        });
      }
      const colors = Object.fromEntries(
        definition.fields.map((field) => [field.label, field.color]),
      );
      const formatValue =
        definition.unit === '%'
          ? (value: unknown) => this.formatPercent(Number(value))
          : definition.unit === 'B/s'
            ? (value: unknown) => this.formatRate(Number(value))
            : (value: unknown) => this.formatLoad(Number(value));
      const options: LineChartOptions = {
        chartId: `bbss-${this.productId}-${definition.id}`,
        theme: ChartTheme.WHITE,
        height: '15rem',
        resizable: true,
        animations: false,
        accessibility: {
          svgAriaLabel: `${this.serviceName()} ${definition.title} Beszel 시계열`,
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
            title: definition.unit,
            mapsTo: 'value',
            scaleType: ScaleTypes.LINEAR,
            includeZero: true,
            ...(definition.fixedMax ? { domain: [0, definition.fixedMax] } : {}),
            ticks: {
              number: 5,
              formatter: (value: number | Date) => formatValue(value),
            },
          },
        },
        legend: {
          enabled: true,
          clickable: false,
          position: LegendPositions.TOP,
          order: definition.fields.map((field) => field.label),
        },
        color: { scale: colors },
        points: { enabled: true, filled: true, radius: 2 },
        tooltip: {
          enabled: true,
          groupLabel: '지표',
          valueFormatter: (value) => formatValue(value),
        },
        toolbar: { enabled: false },
      };
      return {
        id: definition.id,
        title: definition.title,
        unit: definition.unit,
        description: definition.description,
        startAt: points[0]?.timestamp || null,
        endAt: points.at(-1)?.timestamp || null,
        data,
        options,
      };
    });
  }
}
