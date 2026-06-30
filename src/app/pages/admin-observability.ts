import { Component, OnInit, OnDestroy, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { AuthService } from '../core/auth.service';

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

  private auth = inject(AuthService);
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
      const r = await fetch('/api/admin/observability/status', this.authGet());
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
      const r = await fetch('/api/admin/observability/targets', this.authGet());
      if (r.ok) this.targets.set(await r.json());
      else this.targets.set({ reachable: false, hint: `HTTP ${r.status}` });
    } catch (e) { this.targets.set({ reachable: false, hint: String(e) }); }
  }
}
