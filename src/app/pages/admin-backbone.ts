import { Component, OnDestroy, OnInit, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsCellDef, OsColumn, OsDatagrid } from '../os/os-datagrid';
import { OsPageHeader } from '../os/os-page-header';
import { BackboneGraph } from './backbone-graph';
import { BackboneSlice } from './backbone-slice';

interface BbComponent {
  key: string;
  name: string;
  role: string;
  kind: string;
  installed: boolean;
  ready: boolean;
  detail: string;
}

interface BbState {
  namespace: string;
  nsExists: boolean;
  installed: boolean;
  ready: boolean;
  components: BbComponent[];
}

interface CtrlStatus {
  crdReady: boolean;
  dbConnected: boolean;
  runs: number;
  total: number;
  bound: number;
  lastRun: string;
  lastError: string;
  intervalSec: number;
  finalizer: string;
}

interface Claim {
  namespace: string;
  name: string;
  phase: string;
  deleting: boolean;
  message: string;
  spec: { postgres: boolean; objectStore: boolean; gitOps: boolean };
  postgres: { secretRef: string; database: string } | null;
  objectStore: { bucket: string; state: string } | null;
}

/**
 * Main Shell native Backbone status. Backbone is a bootstrap prerequisite, so
 * this page diagnoses the three pillars and never installs optional services.
 */
@Component({
  selector: 'os-admin-backbone',
  imports: [ClarityModule, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef, BackboneGraph, BackboneSlice],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="Backbone" tag="Core·Admin · Console 필수 기반" />

      @if (down(); as detail) {
        <os-backend-unavailable
          feature="Backbone"
          backend="opensphere-console-dupa-controller (/api/admin/backbone)"
          hint="Backbone 세 기둥과 DUPA controller를 Console보다 먼저 복구해야 합니다."
          [detail]="detail"
        />
      } @else {
        <p class="os-sub">
          Console이 서는 필수 상태저장 기반 — PostgreSQL · RustFS · Gitea.
          @if (state(); as current) {
            · ns <code>{{ current.namespace }}</code>
            · {{ current.installed ? '설치됨' : '미설치' }}
            · {{ current.ready ? '정상(Ready)' : '준비중' }}
          }
        </p>

        @if (authExpired()) {
          <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
            <clr-alert-item>
              <span class="alert-text">API 인증 토큰이 만료되었습니다. <a (click)="reAuth()">인증 갱신 →</a></span>
            </clr-alert-item>
          </clr-alert>
        } @else if (msg(); as message) {
          <clr-alert [clrAlertType]="message.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)">
            <clr-alert-item><span class="alert-text">{{ message.text }}</span></clr-alert-item>
          </clr-alert>
        }

        <clr-tabs>
          <clr-tab>
            <button clrTabLink>구성요소</button>
            <clr-tab-content>
              <div class="os-actions">
                <button class="btn btn-outline" [disabled]="busy()" (click)="refresh()">새로고침</button>
                @if (busy()) { <span class="spinner spinner-inline"></span> }
              </div>
              <p class="os-sub">Backbone은 Console보다 먼저 설치되는 bootstrap 계층입니다. 이 화면은 상태와 증거만 조회합니다.</p>
              <os-datagrid
                [columns]="cols"
                [rows]="components()"
                [selected]="selectedRow()"
                (rowClick)="openDetail($event)"
                empty="Backbone 상태 조회 중…"
              >
                <ng-template osCell="name" let-component>
                  <strong>{{ component.name }}</strong> <span class="os-mono">· {{ component.kind }}</span>
                </ng-template>
                <ng-template osCell="status" let-component>
                  @if (component.ready) { <span class="label label-success">Ready</span> }
                  @else if (component.installed) { <span class="label label-warning">NotReady</span> }
                  @else { <span class="label">미설치</span> }
                </ng-template>
                <ng-template osCell="detail" let-component><span class="os-mono">{{ component.detail }}</span></ng-template>
              </os-datagrid>
              <p class="os-sub">로컬 local-path는 단일 replica·논리 백업 전용입니다. 운영 환경은 네트워크 스토리지로 격상해야 합니다.</p>
            </clr-tab-content>
          </clr-tab>

          <clr-tab>
            <button clrTabLink>의존 관계</button>
            <clr-tab-content>
              <p class="os-sub">Backbone → Main Shell → Consumer 순서를 표시합니다. 데이터 기둥 색상은 실제 readiness입니다.</p>
              <os-backbone-graph [statusByKey]="statusByKey()" />
            </clr-tab-content>
          </clr-tab>

          <clr-tab>
            <button clrTabLink (click)="loadController()">할당 컨트롤러</button>
            <clr-tab-content>
              @if (ctrl(); as controller) {
                <div class="os-actions"><button class="btn btn-sm btn-outline" (click)="loadController()">새로고침</button></div>
                <h2>BackboneClaim reconciler</h2>
                <clr-datagrid>
                  <clr-dg-column>항목</clr-dg-column>
                  <clr-dg-column>상태</clr-dg-column>
                  <clr-dg-row><clr-dg-cell>CRD</clr-dg-cell><clr-dg-cell>{{ controller.crdReady ? 'installed' : 'missing' }}</clr-dg-cell></clr-dg-row>
                  <clr-dg-row><clr-dg-cell>PostgreSQL</clr-dg-cell><clr-dg-cell>{{ controller.dbConnected ? 'connected' : 'disconnected' }}</clr-dg-cell></clr-dg-row>
                  <clr-dg-row><clr-dg-cell>Claims</clr-dg-cell><clr-dg-cell>{{ controller.bound }} / {{ controller.total }} bound</clr-dg-cell></clr-dg-row>
                  <clr-dg-row><clr-dg-cell>Reconcile</clr-dg-cell><clr-dg-cell class="os-mono">runs {{ controller.runs }} · {{ controller.intervalSec }}s · {{ controller.lastRun || '—' }}</clr-dg-cell></clr-dg-row>
                  @if (controller.lastError) {
                    <clr-dg-row><clr-dg-cell>Last error</clr-dg-cell><clr-dg-cell class="os-mono">{{ controller.lastError }}</clr-dg-cell></clr-dg-row>
                  }
                  <clr-dg-row><clr-dg-cell>Finalizer</clr-dg-cell><clr-dg-cell class="os-mono">{{ controller.finalizer }}</clr-dg-cell></clr-dg-row>
                </clr-datagrid>

                <h2>BackboneClaim <span class="os-engine">({{ claims().length }})</span></h2>
                <clr-datagrid>
                  <clr-dg-column>Namespace</clr-dg-column>
                  <clr-dg-column>Name</clr-dg-column>
                  <clr-dg-column>Phase</clr-dg-column>
                  <clr-dg-column>요청</clr-dg-column>
                  <clr-dg-column>바인딩</clr-dg-column>
                  @for (claim of claims(); track claim.namespace + claim.name) {
                    <clr-dg-row>
                      <clr-dg-cell>{{ claim.namespace }}</clr-dg-cell>
                      <clr-dg-cell>{{ claim.name }}{{ claim.deleting ? ' (deleting)' : '' }}</clr-dg-cell>
                      <clr-dg-cell>{{ claim.phase }}</clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ specStr(claim) }}</clr-dg-cell>
                      <clr-dg-cell class="os-mono">{{ bindStr(claim) }}</clr-dg-cell>
                    </clr-dg-row>
                  }
                  <clr-dg-placeholder>Consumer BackboneClaim이 없습니다.</clr-dg-placeholder>
                </clr-datagrid>
              } @else {
                <p class="os-sub">컨트롤러 상태를 불러오는 중…</p>
              }
            </clr-tab-content>
          </clr-tab>
        </clr-tabs>
      }
    </div>

    @if (selectedRow(); as row) {
      <os-backbone-slice [row]="row" (closed)="closeDetail()" />
    }
  `,
  styles: [
    `
      .os-sub { color: var(--os-muted); font-size: 0.7rem; margin: 0.3rem 0 0.8rem; }
      .os-engine { font-size: 0.6rem; color: var(--os-muted); font-weight: 400; margin-left: 0.4rem; }
      .os-mono { font-family: monospace; font-size: 0.62rem; color: var(--os-muted); }
      .os-actions { display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0 1rem; }
      .label { margin: 0 0.25rem 0.25rem 0; }
      h2 { font-size: 0.9rem; margin: 1rem 0 0.5rem; }
    `,
  ],
})
export class AdminBackbone implements OnInit, OnDestroy {
  readonly cols: OsColumn[] = [
    { key: 'name', label: '구성요소' },
    { key: 'role', label: '역할' },
    { key: 'status', label: '상태' },
    { key: 'detail', label: '상세' },
  ];
  readonly state = signal<BbState | null>(null);
  readonly components = computed(() => this.state()?.components ?? []);
  readonly statusByKey = computed<Record<string, { installed: boolean; ready: boolean }>>(() => {
    const status: Record<string, { installed: boolean; ready: boolean }> = {};
    for (const component of this.components()) status[component.key] = { installed: component.installed, ready: component.ready };
    return status;
  });
  readonly down = signal('');
  readonly busy = signal(false);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  readonly authExpired = signal(false);
  readonly selectedRow = signal<BbComponent | null>(null);
  readonly ctrl = signal<CtrlStatus | null>(null);
  readonly claims = signal<Claim[]>([]);

  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpService);
  private timer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(true), 8000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.busy.set(true);
    try {
      const response = await this.http.request('/api/admin/backbone/status', this.authGet());
      if (this.checkExpired(response.status)) return;
      if (response.status === 401 || response.status === 403) {
        if (!silent) this.msg.set({ type: 'danger', text: '관리자 권한이 필요합니다 (opensphere-console-admins).' });
        return;
      }
      if (!response.ok) {
        this.down.set(`status HTTP ${response.status}`);
        return;
      }
      this.authExpired.set(false);
      this.down.set('');
      this.state.set(await response.json());
    } catch (error) {
      this.down.set('조회 실패: ' + error);
    } finally {
      if (!silent) this.busy.set(false);
    }
  }

  async loadController(): Promise<void> {
    try {
      const [controller, claims] = await Promise.all([
        this.http.request('/api/admin/backbone/controller', this.authGet()),
        this.http.request('/api/admin/backbone/claims', this.authGet()),
      ]);
      if (this.checkExpired(controller.status) || this.checkExpired(claims.status)) return;
      if (controller.ok) this.ctrl.set(await controller.json());
      if (claims.ok) this.claims.set((await claims.json()).items || []);
    } catch {
      this.msg.set({ type: 'danger', text: 'BackboneClaim 컨트롤러 상태를 조회하지 못했습니다.' });
    }
  }

  openDetail(component: BbComponent): void { this.selectedRow.set(component); }
  closeDetail(): void { this.selectedRow.set(null); }
  reAuth(): void { void this.auth.reAuthenticate(); }

  specStr(claim: Claim): string {
    return [claim.spec.postgres ? 'postgres' : '', claim.spec.objectStore ? 'objectStore' : '', claim.spec.gitOps ? 'gitOps' : '']
      .filter(Boolean)
      .join(', ') || '—';
  }

  bindStr(claim: Claim): string {
    const bindings: string[] = [];
    if (claim.postgres) bindings.push(`pg:${claim.postgres.database} → ${claim.postgres.secretRef}`);
    if (claim.objectStore) bindings.push(`s3:${claim.objectStore.bucket}(${claim.objectStore.state})`);
    return bindings.join(' · ') || claim.message || '—';
  }

  private authGet(): RequestInit {
    return { cache: 'no-store', headers: { authorization: 'Bearer ' + (this.auth.token() || '') } };
  }

  private checkExpired(status: number): boolean {
    if (status === 401 && this.auth.isTokenExpired()) {
      this.authExpired.set(true);
      return true;
    }
    return false;
  }
}
