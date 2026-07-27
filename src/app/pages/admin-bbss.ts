import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import CheckmarkFilled16 from '@carbon/icons/es/checkmark--filled/16';
import Renew16 from '@carbon/icons/es/renew/16';
import WarningAltFilled16 from '@carbon/icons/es/warning--alt--filled/16';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { CarbonIcon } from '../os/carbon-icon';
import { OsPageHeader } from '../os/os-page-header';

type BbssState = 'Healthy' | 'Degraded' | 'Unavailable' | 'Stale' | 'NotConfigured';

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
}

interface BbssCheck {
  id: string;
  name: string;
  state: BbssState;
  detail: string;
}

interface BbssCapacity {
  cpuMillicores: number | null;
  memoryBytes: number | null;
  pvcCount: number;
  requestedBytes: number;
  capacityBytes: number;
  actualUsedBytes: number | null;
  logicalUsedBytes?: number | null;
  claims: Array<{
    name: string;
    state: string;
    storageClass: string | null;
    requestedBytes: number | null;
    capacityBytes: number | null;
  }>;
}

interface BbssActivity {
  label: string;
  value: number | null;
  unit?: string;
  kind: string;
}

interface BbssService {
  id: 'supabase' | 'gitea' | 'beszel';
  name: string;
  role: string;
  state: BbssState;
  observedAt: string | null;
  version: string | null;
  route: string;
  checks: BbssCheck[];
  components: BbssComponent[];
  capacity: BbssCapacity;
  activity: BbssActivity[];
  warnings: string[];
  latest?: {
    cpuPercent: number | null;
    memoryPercent: number | null;
    diskPercent: number | null;
  } | null;
}

interface BbssDependency {
  id: string;
  name: string;
  state: BbssState;
  detail: string;
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
  summary: { services: number; healthy: number; attention: number; unavailable: number };
  services: BbssService[];
  dependencies: BbssDependency[];
  sourcePolicy: {
    currentState: string;
    hostTimeSeries: string;
    applicationTimeSeries: string;
    auditAuthority: string;
  };
}

const PRODUCT_LOGO: Record<BbssService['id'], string> = {
  supabase: 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/supabase-2.svg',
  gitea: 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/gitea.svg',
  beszel: 'https://cdn.statically.io/gh/openplatform-labs/images@main/logos/beszel-light.svg',
};

/**
 * BBSS live availability view.
 *
 * This is a read-only projection. It never treats a Ready Pod as recovery
 * proof, never invents application time-series, and never exposes owner
 * credentials or raw Kubernetes objects to the browser.
 */
@Component({
  selector: 'os-admin-bbss',
  imports: [RouterLink, ClarityModule, BackendUnavailable, CarbonIcon, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page bbss-page">
      <os-page-header title="Backbone Service Stack" tag="BBSS · Live availability">
        <p>
          RCC의 Data & Identity, Declarative Change, Host Time-series 기반을 현재 증거로 판정합니다.
        </p>
      </os-page-header>

      @if (down(); as detail) {
        <os-backend-unavailable
          feature="BBSS 가용성"
          backend="opensphere-console-backend (/api/admin/bbss/status)"
          hint="개별 서비스 상태는 유지되지만 통합 증거를 가져오지 못했습니다. Backend와 Supabase 세션을 먼저 확인하세요."
          [detail]="detail"
        />
      } @else if (status(); as current) {
        <div class="page-lead">
          <div>
            <strong>현재 상태와 운영 복원력을 분리해 표시합니다.</strong>
            <p>
              Pod Ready만으로 전체를 정상 처리하지 않으며, stale·미구성·단일 장애 도메인을 숨기지
              않습니다.
            </p>
          </div>
          <div class="page-meta">
            <span>마지막 확인</span>
            <strong>{{ formatDate(current.generatedAt) }}</strong>
            <button
              class="icon-button"
              type="button"
              aria-label="BBSS 상태 새로고침"
              [disabled]="busy()"
              (click)="refresh()"
            >
              <os-cicon [icon]="icons.renew" [size]="16" />
            </button>
          </div>
        </div>

        <section class="status-rail" aria-label="BBSS 종합 판정">
          <div class="rail-cell primary">
            <span>종합 판정</span>
            <strong [class]="stateClass(current.overall.state)">
              <os-cicon
                [icon]="current.overall.state === 'Healthy' ? icons.check : icons.warning"
                [size]="14"
              />
              {{ stateLabel(current.overall.state) }}
            </strong>
            <small>{{ current.overall.reason }}</small>
          </div>
          <div class="rail-cell">
            <span>현재 가용성</span>
            <strong [class]="stateClass(current.overall.runtimeAvailability)">{{
              stateLabel(current.overall.runtimeAvailability)
            }}</strong>
            <small
              >{{ current.summary.healthy }}/{{ current.summary.services }} service healthy</small
            >
          </div>
          <div class="rail-cell">
            <span>운영 복원력</span>
            <strong [class]="stateClass(current.overall.resilience)">{{
              stateLabel(current.overall.resilience)
            }}</strong>
            <small>노드 · 저장소 · 중단 · 복구</small>
          </div>
          <div class="rail-cell">
            <span>업무 시계열</span>
            <strong [class]="stateClass(current.overall.applicationTelemetry)">{{
              stateLabel(current.overall.applicationTelemetry)
            }}</strong>
            <small>Supabase · Gitea 처리량</small>
          </div>
          <div class="rail-cell">
            <span>주의</span>
            <strong class="tone-warn">{{ current.summary.attention }}</strong>
            <small>degraded · stale · not configured</small>
          </div>
          <div class="rail-cell">
            <span>사용 불가</span>
            <strong [class.tone-danger]="current.summary.unavailable > 0">{{
              current.summary.unavailable
            }}</strong>
            <small>mandatory service</small>
          </div>
        </section>

        @if (current.overall.state !== 'Healthy') {
          <clr-alert
            [clrAlertType]="current.overall.state === 'Unavailable' ? 'danger' : 'warning'"
            [clrAlertClosable]="false"
          >
            <clr-alert-item>
              <span class="alert-text">
                현재 서비스 도달성과 장기 운영 준비도는 다릅니다. 아래 공통 의존성에서 닫히지 않은
                gate를 확인하세요.
              </span>
            </clr-alert-item>
          </clr-alert>
        }

        <section class="service-grid" aria-label="BBSS 서비스">
          @for (service of current.services; track service.id) {
            <article class="service-card">
              <div class="service-card-header">
                <div class="service-identity">
                  <span class="service-logo"
                    ><img
                      [src]="logoFor(service.id)"
                      [alt]="service.name + ' logo'"
                      width="132"
                      height="36"
                  /></span>
                  <div class="service-copy">
                    <span class="service-kicker">{{ service.id }}</span>
                    <h2>{{ service.name }}</h2>
                    <p>{{ service.role }}</p>
                  </div>
                </div>
                <span [class]="stateClass(service.state)">{{ stateLabel(service.state) }}</span>
              </div>

              <dl class="service-facts">
                <div>
                  <dt>구성요소</dt>
                  <dd>{{ readyComponents(service) }}/{{ service.components.length }} Ready</dd>
                </div>
                <div>
                  <dt>현재 CPU</dt>
                  <dd>{{ formatCpu(service.capacity.cpuMillicores) }}</dd>
                </div>
                <div>
                  <dt>현재 메모리</dt>
                  <dd>{{ formatBytes(service.capacity.memoryBytes) }}</dd>
                </div>
                <div>
                  <dt>PVC 요청 용량</dt>
                  <dd>{{ formatBytes(service.capacity.requestedBytes) }}</dd>
                </div>
                <div>
                  <dt>파일시스템 실사용</dt>
                  <dd>
                    {{
                      service.capacity.actualUsedBytes === null
                        ? '미수집'
                        : formatBytes(service.capacity.actualUsedBytes)
                    }}
                  </dd>
                </div>
                <div>
                  <dt>최근 증거</dt>
                  <dd>{{ formatAge(service.observedAt, current.generatedAt) }}</dd>
                </div>
              </dl>

              @if (service.latest) {
                <div class="latest-strip" aria-label="Beszel 최근 호스트 값">
                  <span
                    >Host CPU <strong>{{ formatPercent(service.latest.cpuPercent) }}</strong></span
                  >
                  <span
                    >Memory <strong>{{ formatPercent(service.latest.memoryPercent) }}</strong></span
                  >
                  <span
                    >Disk <strong>{{ formatPercent(service.latest.diskPercent) }}</strong></span
                  >
                </div>
              }

              <div class="activity-grid">
                @for (item of service.activity; track item.label) {
                  <div>
                    <span>{{ item.label }}</span>
                    <strong>{{ activityValue(item) }}</strong>
                    <small>{{ activityKind(item.kind) }}</small>
                  </div>
                }
              </div>

              <div class="service-checks">
                @for (check of service.checks; track check.id) {
                  <div>
                    <span [class]="stateDotClass(check.state)" aria-hidden="true"></span>
                    <strong>{{ check.name }}</strong>
                    <small>{{ check.detail }}</small>
                  </div>
                } @empty {
                  <p>Owner 상태 확인 항목이 없습니다.</p>
                }
              </div>

              <footer>
                <span>{{
                  service.version ? 'version ' + service.version : 'version evidence unavailable'
                }}</span>
                <a class="btn btn-sm btn-link" [routerLink]="productRoute(service.id)">제품 상세</a>
              </footer>
            </article>
          }
        </section>

        <section class="detail-grid">
          <article class="panel">
            <div class="panel-header">
              <h2>공통 의존성과 장애 도메인</h2>
              <p>세 서비스가 동시에 영향을 받는 기반입니다.</p>
            </div>
            <div class="dependency-list">
              @for (dependency of current.dependencies; track dependency.id) {
                <div>
                  <span [class]="stateDotClass(dependency.state)" aria-hidden="true"></span>
                  <strong>{{ dependency.name }}</strong>
                  <span [class]="stateClass(dependency.state)">{{
                    stateLabel(dependency.state)
                  }}</span>
                  <small>{{ dependency.detail }}</small>
                </div>
              }
            </div>
          </article>

          <article class="panel">
            <div class="panel-header">
              <h2>데이터 출처 계약</h2>
              <p>한 저장소가 모든 의미를 대신하지 않습니다.</p>
            </div>
            <dl class="source-policy">
              <div>
                <dt>현재 상태</dt>
                <dd>{{ current.sourcePolicy.currentState }}</dd>
              </div>
              <div>
                <dt>호스트 시계열</dt>
                <dd>{{ current.sourcePolicy.hostTimeSeries }}</dd>
              </div>
              <div>
                <dt>업무 시계열</dt>
                <dd>{{ current.sourcePolicy.applicationTimeSeries }}</dd>
              </div>
              <div>
                <dt>감사 정본</dt>
                <dd>{{ current.sourcePolicy.auditAuthority }}</dd>
              </div>
            </dl>
            <p class="source-note">
              처리량이 아직 저장되지 않는 항목은 0이 아니라 미구성으로 표시합니다.
            </p>
          </article>
        </section>

        <section class="panel component-panel">
          <div class="panel-header">
            <h2>런타임 구성요소</h2>
            <p>Kubernetes에서 직접 읽은 현재 replica와 restart입니다.</p>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>서비스</th>
                  <th>구성요소</th>
                  <th>종류</th>
                  <th>상태</th>
                  <th>Ready</th>
                  <th>Restart</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                @for (service of current.services; track service.id) {
                  @for (component of service.components; track component.id) {
                    <tr>
                      <td>{{ service.name }}</td>
                      <td>
                        <strong>{{ component.name }}</strong>
                      </td>
                      <td>{{ component.kind }}</td>
                      <td>
                        <span [class]="stateClass(component.state)">{{
                          stateLabel(component.state)
                        }}</span>
                      </td>
                      <td>{{ component.ready }}/{{ component.desired }}</td>
                      <td [class.tone-warn]="component.restarts > 0">{{ component.restarts }}</td>
                      <td>{{ component.version || '—' }}</td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else {
        <div class="loading-state">
          <span class="spinner spinner-md" aria-label="BBSS 상태를 불러오는 중"></span>
          <p>BBSS 현재 증거를 확인하고 있습니다.</p>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .bbss-page {
        max-width: 94rem;
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
        display: grid;
        grid-template-columns: auto auto auto;
        align-items: center;
        gap: 0.4rem;
        color: var(--os-ink-muted);
        font-size: 0.62rem;
      }
      .page-meta strong {
        color: var(--os-ink);
        font-size: 0.66rem;
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
        cursor: default;
      }
      .status-rail {
        display: grid;
        grid-template-columns: 1.45fr repeat(5, minmax(0, 1fr));
        margin: 0.85rem 0;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .rail-cell {
        display: grid;
        align-content: start;
        gap: 0.2rem;
        min-width: 0;
        padding: 0.7rem 0.8rem;
        border-right: 1px solid var(--os-hairline);
      }
      .rail-cell:last-child {
        border-right: 0;
      }
      .rail-cell.primary {
        background: var(--os-surface-1);
      }
      .rail-cell > span,
      .rail-cell small {
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .rail-cell > strong {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        color: var(--os-ink);
        font-size: 0.78rem;
      }
      .rail-cell small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .service-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        align-items: stretch;
        gap: 0.75rem;
        margin: 0.85rem 0;
      }
      .service-card,
      .panel {
        min-width: 0;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .service-card {
        display: flex;
        overflow: hidden;
        flex-direction: column;
      }
      .service-card-header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: start;
        gap: 0.75rem;
        min-height: 5.6rem;
        padding: 0.8rem;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .service-identity {
        display: grid;
        grid-template-columns: 3.25rem minmax(0, 1fr);
        align-items: center;
        gap: 0.75rem;
        min-width: 0;
      }
      .service-logo {
        display: grid;
        place-items: center;
        width: 3.25rem;
        height: 3.25rem;
        padding: 0;
        border: 0;
        background: transparent;
      }
      .service-logo img {
        display: block;
        width: 100%;
        height: 100%;
        max-width: 3rem;
        max-height: 3rem;
        object-fit: contain;
      }
      .service-copy {
        display: grid;
        align-content: center;
        min-width: 0;
      }
      .service-kicker {
        color: var(--os-accent);
        font-size: 0.54rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .service-card h2,
      .panel h2 {
        margin: 0.12rem 0 0;
        color: var(--os-ink);
        font-size: 0.82rem;
      }
      .service-card-header p,
      .panel-header p {
        min-height: 2.8em;
        margin: 0.18rem 0 0;
        color: var(--os-ink-muted);
        font-size: 0.58rem;
        line-height: 1.4;
      }
      .service-card-header > .state-pill {
        margin-top: 0.05rem;
      }
      .service-facts {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin: 0;
      }
      .service-facts div {
        display: grid;
        align-content: center;
        gap: 0.12rem;
        min-height: 3rem;
        padding: 0.55rem 0.7rem;
        border-right: 1px solid var(--os-hairline);
        border-bottom: 1px solid var(--os-hairline);
      }
      .service-facts div:nth-child(2n) {
        border-right: 0;
      }
      .service-facts dt,
      .service-facts dd {
        margin: 0;
      }
      .service-facts dt {
        color: var(--os-ink-muted);
        font-size: 0.56rem;
      }
      .service-facts dd {
        font-size: 0.68rem;
        font-weight: 600;
      }
      .latest-strip {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        border-bottom: 1px solid var(--os-hairline);
        background: #f4f8ff;
      }
      .latest-strip span {
        display: grid;
        gap: 0.1rem;
        padding: 0.48rem 0.6rem;
        color: var(--os-ink-muted);
        font-size: 0.53rem;
      }
      .latest-strip strong {
        color: var(--os-accent);
        font-size: 0.67rem;
      }
      .activity-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        border-bottom: 1px solid var(--os-hairline);
      }
      .activity-grid div {
        display: grid;
        gap: 0.08rem;
        padding: 0.48rem;
        border-right: 1px solid var(--os-hairline);
      }
      .activity-grid div:last-child {
        border-right: 0;
      }
      .activity-grid span,
      .activity-grid small {
        color: var(--os-ink-muted);
        font-size: 0.5rem;
      }
      .activity-grid strong {
        font-size: 0.68rem;
      }
      .service-checks {
        display: grid;
        align-content: start;
        flex: 1;
      }
      .service-checks > div {
        display: grid;
        grid-template-columns: 0.6rem minmax(5rem, 0.75fr) minmax(0, 1.4fr);
        align-items: center;
        gap: 0.35rem;
        padding: 0.4rem 0.65rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .service-checks strong {
        font-size: 0.58rem;
      }
      .service-checks small {
        overflow: hidden;
        color: var(--os-ink-muted);
        font-size: 0.52rem;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .service-checks p {
        margin: 0.6rem;
        color: var(--os-ink-muted);
        font-size: 0.58rem;
      }
      .service-card > footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-top: auto;
        padding: 0.45rem 0.65rem;
      }
      .service-card > footer > span {
        color: var(--os-ink-muted);
        font-size: 0.52rem;
      }
      .state-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.22rem;
        width: max-content;
        max-width: 100%;
        padding: 0.12rem 0.42rem;
        border-radius: 1rem;
        font-size: 0.57rem;
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
        width: 0.5rem;
        height: 0.5rem;
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
      .tone-danger {
        color: #c21d38 !important;
      }
      .detail-grid {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 0.75rem;
        margin: 0.75rem 0;
      }
      .panel > .panel-header {
        min-height: 3.25rem;
        padding: 0.7rem 0.8rem;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
      }
      .dependency-list {
        display: grid;
      }
      .dependency-list > div {
        display: grid;
        grid-template-columns: 0.6rem minmax(8rem, 0.8fr) auto minmax(10rem, 1.4fr);
        align-items: center;
        gap: 0.45rem;
        padding: 0.48rem 0.7rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .dependency-list > div:last-child {
        border-bottom: 0;
      }
      .dependency-list strong {
        font-size: 0.62rem;
      }
      .dependency-list small {
        color: var(--os-ink-muted);
        font-size: 0.54rem;
      }
      .source-policy {
        margin: 0;
      }
      .source-policy div {
        display: grid;
        grid-template-columns: 8rem minmax(0, 1fr);
        gap: 0.5rem;
        padding: 0.5rem 0.7rem;
        border-bottom: 1px solid var(--os-hairline);
        font-size: 0.62rem;
      }
      .source-policy dt {
        color: var(--os-ink-muted);
      }
      .source-policy dd {
        margin: 0;
        font-weight: 600;
      }
      .source-note {
        margin: 0.65rem;
        color: var(--os-ink-muted);
        font-size: 0.56rem;
        line-height: 1.45;
      }
      .component-panel {
        margin-top: 0.75rem;
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
        padding: 0.5rem 0.65rem;
        border-bottom: 1px solid var(--os-hairline);
        text-align: left;
        white-space: nowrap;
        font-size: 0.61rem;
      }
      th {
        color: var(--os-ink-muted);
        background: var(--os-surface-2);
        font-size: 0.55rem;
        font-weight: 600;
      }
      tbody tr:last-child td {
        border-bottom: 0;
      }
      .loading-state {
        display: grid;
        justify-items: center;
        gap: 0.6rem;
        padding: 4rem;
        color: var(--os-ink-muted);
        font-size: 0.68rem;
      }
      @media (max-width: 80rem) {
        .status-rail {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .rail-cell {
          border-bottom: 1px solid var(--os-hairline);
        }
        .service-grid {
          grid-template-columns: 1fr;
        }
        .detail-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 48rem) {
        .page-lead {
          flex-direction: column;
        }
        .status-rail {
          grid-template-columns: 1fr;
        }
        .rail-cell {
          border-right: 0;
        }
        .service-facts {
          grid-template-columns: 1fr;
        }
        .service-facts div {
          border-right: 0;
        }
        .activity-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .dependency-list > div {
          grid-template-columns: 0.6rem 1fr auto;
        }
        .dependency-list small {
          grid-column: 2/-1;
        }
      }
    `,
  ],
})
export class AdminBbss implements OnInit, OnDestroy {
  readonly icons = { check: CheckmarkFilled16, renew: Renew16, warning: WarningAltFilled16 };
  readonly status = signal<BbssStatus | null>(null);
  readonly down = signal('');
  readonly busy = signal(false);
  private readonly http = inject(HttpService);
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
      this.status.set(result as BbssStatus);
      this.down.set('');
    } catch (error) {
      this.status.set(null);
      this.down.set(`BBSS 상태 조회 실패: ${String(error)}`);
    } finally {
      if (!silent) this.busy.set(false);
    }
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

  readyComponents(service: BbssService): number {
    return service.components.filter((component) => component.state === 'Healthy').length;
  }

  productRoute(serviceId: BbssService['id']): string {
    return `/manage/bbss/${serviceId}`;
  }

  logoFor(serviceId: BbssService['id']): string {
    return PRODUCT_LOGO[serviceId];
  }

  formatCpu(value: number | null): string {
    if (value === null) return '미수집';
    return value >= 1000 ? `${(value / 1000).toFixed(2)} cores` : `${value}m`;
  }

  formatBytes(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '미수집';
    if (value === 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  }

  formatPercent(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
      ? '—'
      : `${value.toFixed(1)}%`;
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

  formatAge(value: string | null | undefined, generatedAt: string): string {
    const observed = Date.parse(String(value || ''));
    const generated = Date.parse(generatedAt);
    if (!Number.isFinite(observed) || !Number.isFinite(generated)) return '알 수 없음';
    const seconds = Math.max(0, Math.floor((generated - observed) / 1000));
    if (seconds < 60) return `${seconds}초 전`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
    return `${Math.floor(seconds / 3600)}시간 전`;
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
}
