import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';

interface DirectEvidence {
  key: string;
  label: string;
  namespace: string;
  ready: boolean;
  detail?: string;
  reason?: string;
}

interface BindingRef {
  name: string;
  namespace: string;
  phase: string;
  observedAt: string;
  templates: string[];
}

interface ObservabilityState {
  owner: 'HIS';
  mode: 'NotConfigured' | 'Pending' | 'Connected' | 'Degraded';
  ready: boolean;
  binding: BindingRef | null;
  bindingApi: string;
  capabilities: string[];
  reason: string;
  directEvidence: DirectEvidence[];
  telemetry: { enabled: boolean; source: string };
}

/**
 * Console Observability is intentionally an HIS Binding consumer.  This page
 * never discovers a Prometheus service, configures HIS, or renders synthetic
 * metrics while a binding is absent.  Direct Console deployment evidence is
 * still valuable before HIS is connected, but is not represented as telemetry.
 */
@Component({
  selector: 'os-admin-observability',
  imports: [ClarityModule, RouterLink, BackendUnavailable, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="Observability Integration" tag="HIS Binding · Read-only consumer" />

      @if (down(); as detail) {
        <os-backend-unavailable
          feature="HIS Observability Binding"
          backend="opensphere-console-dupa-controller (/api/admin/observability/status)"
          hint="Console 제어 API와 HIS Binding 읽기 권한을 확인하세요. Console은 Prometheus 또는 Grafana를 설치·탐색하지 않습니다."
          [detail]="detail"
        />
      } @else if (state(); as current) {
        <p class="os-sub">
          관측성의 소유자는 <strong>HIS</strong>입니다. Console은 HIS가 발급한 <code>ObservabilityBinding</code>만 읽어 지표·SLO·경보 표시를 활성화합니다.
        </p>

        <div class="os-actions">
          <button class="btn btn-outline" [disabled]="busy()" (click)="refresh()">새로고침</button>
          @if (busy()) { <span class="spinner spinner-inline"></span> }
          <a class="btn btn-sm btn-link" routerLink="/p/cluster-manager/his/his">HIS 관리로 이동</a>
        </div>

        @if (current.mode === 'Connected') {
          <clr-alert clrAlertType="success" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">HIS Binding 연결됨 — 승인된 관측 데이터만 Console에 표시할 수 있습니다.</span></clr-alert-item></clr-alert>
        } @else if (current.mode === 'NotConfigured') {
          <clr-alert clrAlertType="info" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">HIS Binding이 아직 없습니다. Console은 아래 직접 증거만 표시하며 메트릭·SLO·경보는 표시하지 않습니다.</span></clr-alert-item></clr-alert>
        } @else if (current.mode === 'Pending') {
          <clr-alert clrAlertType="warning" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">HIS Binding이 준비 중입니다. 완료 전까지 telemetry-dependent 운영 게이트는 충족되지 않습니다.</span></clr-alert-item></clr-alert>
        } @else {
          <clr-alert clrAlertType="danger" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">HIS Binding이 저하되었습니다. 마지막 관측 계약을 신뢰 가능한 Ready 상태로 표시하지 않습니다.</span></clr-alert-item></clr-alert>
        }

        <section class="manage-status-rail" aria-label="Observability 계약 상태">
          <div><span>Authority owner</span><strong>{{ current.owner }}</strong><small>Console은 read-only consumer</small></div>
          <div><span>Binding</span><strong [class.ok]="current.mode === 'Connected'" [class.warn]="current.mode === 'Pending' || current.mode === 'Degraded'" [class.neutral]="current.mode === 'NotConfigured'">{{ current.mode }}</strong><small>{{ current.bindingApi }}</small></div>
          <div><span>Telemetry</span><strong [class.ok]="current.telemetry.enabled" [class.neutral]="!current.telemetry.enabled">{{ current.telemetry.enabled ? 'Enabled' : 'Not enabled' }}</strong><small>{{ current.telemetry.source }}</small></div>
          <div><span>Capabilities</span><strong>{{ current.capabilities.length }}/{{ capabilityList.length }}</strong><small>HIS 계약상 제공</small></div>
          <div><span>Direct evidence</span><strong>{{ readyEvidence(current) }}/{{ current.directEvidence.length }}</strong><small>Console 가용성만 확인</small></div>
        </section>

        <section class="os-card">
          <div class="os-card-h">HIS ObservabilityBinding</div>
          @if (current.binding; as binding) {
            <dl class="binding-grid">
              <div><dt>이름</dt><dd><code>{{ binding.namespace }}/{{ binding.name }}</code></dd></div>
              <div><dt>HIS 상태</dt><dd><span class="label" [class.label-success]="current.ready" [class.label-warning]="!current.ready">{{ binding.phase }}</span></dd></div>
              <div><dt>관측 시각</dt><dd>{{ binding.observedAt || 'HIS가 아직 보고하지 않음' }}</dd></div>
              <div><dt>승인된 질의 템플릿</dt><dd>{{ binding.templates.length ? binding.templates.join(', ') : '없음' }}</dd></div>
            </dl>
          } @else {
            <p class="empty">Binding 없음 — HIS 또는 Cluster Manager에서 Console 소비자용 Binding을 발급해야 합니다.</p>
          }
          <p class="os-sub">{{ current.reason || 'Binding 계약이 유효합니다.' }}</p>
        </section>

        <section class="os-card">
          <div class="os-card-h">계약상 제공 기능</div>
          <div class="capabilities">
            @for (capability of capabilityList; track capability) {
              <span class="label" [class.label-success]="hasCapability(current, capability)" [class.label-warning]="!hasCapability(current, capability)">
                {{ capability }} · {{ hasCapability(current, capability) ? '제공됨' : '미제공' }}
              </span>
            }
          </div>
          <p class="os-sub">이 목록은 HIS Binding의 명시적 capability만 반영합니다. Console이 Prometheus/Grafana 상태를 추측하거나 직접 발견하지 않습니다.</p>
        </section>

        <section class="os-card">
          <div class="os-card-h">Binding 부재 시 직접 증거</div>
          <p class="os-sub">이 증거는 Console의 기본 가용성 확인용이며, 관측 telemetry 또는 HIS 준비 완료를 대체하지 않습니다.</p>
          <clr-datagrid>
            <clr-dg-column>대상</clr-dg-column>
            <clr-dg-column>Namespace</clr-dg-column>
            <clr-dg-column>상태</clr-dg-column>
            <clr-dg-column>증거</clr-dg-column>
            @for (item of current.directEvidence; track item.key) {
              <clr-dg-row>
                <clr-dg-cell><strong>{{ item.label }}</strong></clr-dg-cell>
                <clr-dg-cell><code>{{ item.namespace }}</code></clr-dg-cell>
                <clr-dg-cell><span class="label" [class.label-success]="item.ready" [class.label-warning]="!item.ready">{{ item.ready ? 'Ready' : 'Unavailable' }}</span></clr-dg-cell>
                <clr-dg-cell>{{ item.detail || item.reason || '상태 확인' }}</clr-dg-cell>
              </clr-dg-row>
            }
            <clr-dg-placeholder>직접 증거가 없습니다.</clr-dg-placeholder>
          </clr-datagrid>
        </section>
      }
    </div>
  `,
  styles: [`
    .os-sub { color: var(--os-muted); font-size: .72rem; margin: .3rem 0 .8rem; }
    .os-actions { display:flex; align-items:center; gap:.5rem; margin:.5rem 0 1rem; }
    .os-card { margin:.85rem 0; border:1px solid var(--os-border); background:var(--os-surface-raised); }
    .os-card-h { padding:.55rem .8rem; border-bottom:1px solid var(--os-border); font-weight:600; font-size:.8rem; }
    .binding-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.75rem; padding:.8rem; margin:0; }
    dt { color:var(--os-muted); font-size:.62rem; } dd { margin:.2rem 0 0; font-size:.73rem; }
    .empty { padding:.8rem; margin:0; color:var(--os-muted); }
    .capabilities { padding:.8rem; display:flex; gap:.4rem; flex-wrap:wrap; }
    .label { margin:0; }
    @media (max-width:48rem) { .summary-grid, .binding-grid { grid-template-columns:1fr; } }
  `],
})
export class AdminObservability implements OnInit, OnDestroy {
  readonly state = signal<ObservabilityState | null>(null);
  readonly down = signal('');
  readonly busy = signal(false);
  readonly capabilityList = ['metrics', 'logs', 'traces', 'otlp'];
  private readonly http = inject(HttpService);
  private timer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(true), 30_000);
  }

  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  hasCapability(state: ObservabilityState, capability: string): boolean {
    return state.capabilities.map((item) => item.toLowerCase()).includes(capability);
  }

  readyEvidence(state: ObservabilityState): number { return state.directEvidence.filter((item) => item.ready).length; }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.busy.set(true);
    try {
      const response = await this.http.request('/api/admin/observability/status', { cache: 'no-store' });
      if (!response.ok) { this.down.set(`HIS Binding status HTTP ${response.status}`); return; }
      this.state.set(await response.json() as ObservabilityState);
      this.down.set('');
    } catch (error) {
      this.down.set(`HIS Binding 상태 조회 실패: ${String(error)}`);
    } finally {
      if (!silent) this.busy.set(false);
    }
  }
}
