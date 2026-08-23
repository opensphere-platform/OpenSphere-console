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
import Renew16 from '@carbon/icons/es/renew/16';
import { HttpService } from '../core/http.service';
import { CarbonIcon } from '../os/carbon-icon';
import { OsPageHeader } from '../os/os-page-header';

type FoundationState = 'Healthy' | 'Degraded' | 'Stale' | 'Unavailable' | 'NotConfigured';

interface SupabaseStatus {
  meta: { checkedAt: string };
  components: Array<{ name: string; ready: boolean; detail: string }>;
  operators: number;
  roles: unknown[];
  auditEvents: number;
  buckets: unknown[];
  recovery: {
    available: boolean;
    reason?: string;
    supabase?: { state?: string; declaredState?: string };
    storage?: { state?: string; declaredState?: string };
  };
}

interface ChangeStatus {
  meta: { checkedAt: string };
  configured: boolean;
  ready: boolean;
  managementReady: boolean;
  version: string;
  repositoryCount: number | null;
  receipts: unknown[];
  byStatus: Record<string, number>;
  reason: string;
  supplyChain: {
    protected: boolean;
    requiredApprovals: number;
    signedCommitsRequired: boolean;
    directPushEnabled: boolean;
  } | null;
}

interface MonitoringOverview {
  freshness: 'fresh' | 'stale';
  observedAt: string;
  systems: {
    total: number;
    up: number;
    down: number;
    unmatched: number;
    identityRejected: number;
    disagreement: number;
  };
  kubernetes: { available: boolean; nodes: number; nodesReady: number };
  alerts: { total: number; triggered: number };
  retention: { maximumDays: number; authority: string };
}

interface MonitoringHealth {
  status: 'healthy' | 'degraded' | 'unavailable' | 'unconfigured';
  checkedAt: string;
  freshness?: string;
  observedAt?: string;
  reasons: string[];
}

interface OsdstControl {
  mode: string;
  rollout: { ready: boolean };
  runtime: {
    ready?: boolean;
    service?: string;
    version?: string;
    error?: string;
  };
}

interface ReadResult<T> {
  value: T | null;
  error: string;
}

interface FoundationSnapshot {
  generatedAt: string;
  supabase: ReadResult<SupabaseStatus>;
  change: ReadResult<ChangeStatus>;
  monitoring: ReadResult<MonitoringOverview>;
  monitoringHealth: ReadResult<MonitoringHealth>;
  osdst: ReadResult<OsdstControl>;
}

interface Evidence {
  label: string;
  value: string;
  hint: string;
}

interface FoundationService {
  id: 'data' | 'change' | 'monitoring';
  domain: string;
  implementation: string;
  role: string;
  state: FoundationState;
  route: string;
  logo: string;
  observedAt: string | null;
  evidence: Evidence[];
  warning: string;
}

const LOGOS = {
  data: '/assets/product-logos/supabase-icon.svg',
  change: '/assets/product-logos/gitea.svg',
  monitoring: '/assets/product-logos/beszel-light.svg',
} as const;

@Component({
  selector: 'os-admin-foundation-services',
  imports: [RouterLink, ClarityModule, CarbonIcon, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page foundation-page">
      <os-page-header title="CBSS 자원 서비스" tag="Console Backbone Service Stack · Live evidence" />
      <div class="page-lead">
        <div>
          <p>
            OSCE와 OSDST를 비롯한 Console 서비스를 지속시키는 Data &amp; Identity, 선언형 상태 변경,
            노드 시계열 자원을 하나의 운영 관점에서 확인합니다. 제품 이름보다 서비스 역할을
            우선하며, 각 상세 화면의 권위와 기능은 그대로 유지합니다.
          </p>
          <small>현재 가용성과 장기 운영 준비도를 분리하고, 수집되지 않은 값은 0이 아닌 미구성으로 표시합니다.</small>
        </div>
        <div class="page-meta">
          <span>마지막 확인</span>
          <strong>{{ formatDate(snapshot()?.generatedAt) }}</strong>
          <button
            class="icon-button"
            type="button"
            aria-label="CBSS 자원 서비스 상태 새로고침"
            [disabled]="busy()"
            (click)="refresh()"
          >
            <os-cicon [icon]="renewIcon" [size]="16" />
          </button>
        </div>
      </div>

      @if (busy() && !snapshot()) {
        <div class="loading-block"><span class="spinner spinner-md"></span><span>CBSS 자원 서비스 증거를 확인하고 있습니다.</span></div>
      } @else if (snapshot()) {
        @if (failedReads().length) {
          <clr-alert [clrAlertType]="availableCount() ? 'warning' : 'danger'" [clrAlertClosable]="false">
            <clr-alert-item>
              <span class="alert-text">
                <strong>{{ availableCount() ? '일부 근거를 불러오지 못했습니다.' : 'CBSS 자원 서비스 상태를 확인할 수 없습니다.' }}</strong>
                {{ failedReads().join(' · ') }}
              </span>
            </clr-alert-item>
          </clr-alert>
        }

        <section class="core-consumers" aria-labelledby="core-consumers-title">
          <div class="core-consumers-heading">
            <span class="eyebrow">CORE SERVICE CONSUMERS</span>
            <h2 id="core-consumers-title">이 자원을 소비하는 CBSS Core Service</h2>
            <p>Core Service의 건강과 자원 서비스의 건강은 별도로 판정하되, revision과 evidence로 연결합니다.</p>
          </div>
          <a routerLink="/manage/platform-control"><strong>OSCE</strong><span>Platform Control Core Engine</span><small>Supabase identity · Gitea change authority · runtime evidence 소비</small></a>
          <a routerLink="/manage/osaa">
            <span class="core-service-name"><strong>OSDST</strong><em [class]="stateClass(osdstState())">{{ stateLabel(osdstState()) }}</em></span>
            <span>OpenSphere Dialogue State Tracker</span>
            <small>{{ osdstSummary() }}</small>
          </a>
        </section>

        <section class="status-rail" aria-label="CBSS 자원 서비스 종합 상태">
          <div>
            <span>종합 판정</span>
            <strong [class]="stateClass(overallState())">{{ stateLabel(overallState()) }}</strong>
            <small>서비스 역할별 최악 상태</small>
          </div>
          <div>
            <span>현재 가용성</span>
            <strong>{{ availableCount() }}/{{ services().length }}</strong>
            <small>사용자가 도달 가능한 기반 서비스</small>
          </div>
          <div>
            <span>현재 서비스 정상</span>
            <strong>{{ healthyCount() }}/{{ services().length }}</strong>
            <small>권위 API와 현재 연결 상태</small>
          </div>
          <div>
            <span>운영 Gate 주의</span>
            <strong [class.warn]="operationalAttentionCount() > 0">{{ operationalAttentionCount() }}</strong>
            <small>복구·공급망·신선도</small>
          </div>
          <div>
            <span>사용 불가·미구성</span>
            <strong [class.danger]="blockedCount() > 0">{{ blockedCount() }}</strong>
            <small>운영자가 조치할 항목</small>
          </div>
        </section>

        <section class="service-grid" aria-label="CBSS 자원 서비스 역할별 상태">
          @for (service of services(); track service.id) {
            <article class="service-card">
              <div class="service-heading">
                <span class="service-logo"><img [src]="service.logo" [alt]="service.implementation + ' logo'" /></span>
                <div>
                  <span class="eyebrow">{{ service.implementation }}</span>
                  <h2>{{ service.domain }}</h2>
                  <p>{{ service.role }}</p>
                </div>
                <span [class]="stateClass(service.state)">{{ stateLabel(service.state) }}</span>
              </div>

              <div class="evidence-grid">
                @for (item of service.evidence; track item.label) {
                  <div><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.hint }}</small></div>
                }
              </div>

              @if (service.warning) {
                <p class="service-warning">{{ service.warning }}</p>
              }
              <div class="service-footer">
                <span>{{ formatDate(service.observedAt) }}</span>
                <a [routerLink]="service.route">상세 운영 화면</a>
              </div>
            </article>
          }
        </section>

        <section class="foundation-section">
          <div class="section-heading">
            <div>
              <span class="eyebrow">OPERATIONAL READINESS</span>
              <h2>공통 운영 Gate</h2>
              <p>Pod 또는 API의 현재 응답만으로 장기 운영 준비 완료를 선언하지 않습니다.</p>
            </div>
          </div>
          <div class="gate-grid">
            @for (gate of gates(); track gate.label) {
              <div>
                <span>{{ gate.label }}</span>
                <strong [class]="stateClass(gate.state)">{{ stateLabel(gate.state) }}</strong>
                <p>{{ gate.detail }}</p>
              </div>
            }
          </div>
        </section>

        <section class="foundation-section source-contract">
          <div class="section-heading">
            <div>
              <span class="eyebrow">SOURCE CONTRACT</span>
              <h2>데이터 출처 계약</h2>
              <p>한 저장소나 모니터링 제품이 모든 의미를 대신하지 않습니다.</p>
            </div>
          </div>
          <dl>
            <div><dt>Data &amp; Identity 현재 상태</dt><dd>Supabase owner API · RLS-backed projection</dd></div>
            <div><dt>선언형 변경 현재 상태</dt><dd>State Change Authority · Gitea owner API · Kubernetes receipt</dd></div>
            <div><dt>노드 OS 시계열</dt><dd>Beszel read-only adapter · Kubernetes Node correlation</dd></div>
            <div><dt>애플리케이션 관측</dt><dd>HISS Observability · 별도 SLO, trace, 장기보존 계약</dd></div>
            <div><dt>감사 정본</dt><dd>Supabase append-only audit projection</dd></div>
          </dl>
        </section>
      }
    </div>
  `,
  styles: [`
    .foundation-page{min-width:0}
    .page-lead{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--os-6);margin:.35rem 0 1rem}
    .page-lead p{max-width:70rem;margin:0;color:var(--os-ink-muted);font-size:.76rem;line-height:1.55}
    .page-lead small{display:block;margin-top:.25rem;color:var(--os-ink-subtle);font-size:.64rem}
    .page-meta{display:grid;grid-template-columns:auto auto auto;align-items:center;gap:var(--os-3);white-space:nowrap;color:var(--os-ink-muted);font-size:.65rem}
    .page-meta strong{color:var(--os-ink);font-size:.7rem}.icon-button{display:grid;place-items:center;width:2rem;height:2rem;border:1px solid var(--os-hairline);background:var(--os-canvas);color:var(--os-accent)}
    .core-consumers{display:grid;grid-template-columns:minmax(18rem,1.2fr) repeat(2,minmax(15rem,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas);margin:var(--os-5) 0}.core-consumers>*{min-width:0;padding:var(--os-5);border-inline-end:1px solid var(--os-hairline)}.core-consumers>*:last-child{border-inline-end:0}.core-consumers h2{margin:.2rem 0;font-size:.92rem}.core-consumers p,.core-consumers small{display:block;margin:.25rem 0 0;color:var(--os-ink-muted);font-size:.62rem;line-height:1.4}.core-consumers a{display:grid;align-content:center;color:inherit;text-decoration:none}.core-consumers a:hover{background:var(--os-surface-1)}.core-consumers a strong{color:var(--os-accent);font:700 .8rem var(--os-font-mono)}.core-consumers a>span{margin-top:.2rem;font-size:.72rem;font-weight:600}.core-service-name{display:flex!important;align-items:center;justify-content:space-between;gap:var(--os-3);margin:0!important}.core-service-name em{font-style:normal}
    .status-rail{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas);margin:var(--os-5) 0}
    .status-rail>div{display:grid;gap:var(--os-2);min-width:0;padding:var(--os-5);border-inline-end:1px solid var(--os-hairline)}
    .status-rail>div:last-child{border-inline-end:0}.status-rail span,.evidence-grid span{color:var(--os-ink-muted);font-size:.64rem}.status-rail strong{font-size:1.08rem}.status-rail small,.evidence-grid small{color:var(--os-ink-subtle);font-size:.59rem}
    .service-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--os-5);margin:var(--os-5) 0 var(--os-7)}
    .service-card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--os-hairline);background:var(--os-canvas)}
    .service-heading{display:grid;grid-template-columns:3rem minmax(0,1fr) auto;align-items:start;gap:var(--os-4);padding:var(--os-5);border-bottom:1px solid var(--os-hairline)}
    .service-logo{display:grid;place-items:center;width:3rem;height:2.4rem}.service-logo img{display:block;max-width:100%;max-height:2.2rem}
    .eyebrow{display:block;color:var(--os-accent);font-size:.59rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
    h2{margin:.15rem 0;font-size:.95rem;line-height:1.25}.service-heading p,.section-heading p{margin:0;color:var(--os-ink-muted);font-size:.65rem;line-height:1.45}
    .state-pill{display:inline-flex;align-items:center;justify-content:center;min-height:1.35rem;padding:0 .5rem;border-radius:1rem;font-size:.6rem;font-weight:600;white-space:nowrap}
    .state-healthy{color:#0e6027;background:#defbe6}.state-degraded,.state-stale{color:#684e00;background:#fff1c7}.state-unavailable{color:#a2191f;background:#fff1f1}.state-notconfigured{color:#525252;background:#e8e8e8}
    .evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));flex:1}.evidence-grid>div{display:grid;gap:var(--os-2);padding:var(--os-5);border-bottom:1px solid var(--os-hairline)}.evidence-grid>div:nth-child(odd){border-inline-end:1px solid var(--os-hairline)}.evidence-grid strong{font-size:.84rem}
    .service-warning{margin:0;padding:var(--os-4) var(--os-5);border-inline-start:3px solid #f1c21b;background:#fff8e1;color:#684e00;font-size:.64rem;line-height:1.45}
    .service-footer{display:flex;align-items:center;justify-content:space-between;gap:var(--os-4);padding:var(--os-4) var(--os-5);font-size:.62rem;color:var(--os-ink-subtle)}.service-footer a{color:var(--os-accent);font-weight:600}
    .foundation-section{margin-top:var(--os-6);border-top:1px solid var(--os-hairline);padding-top:var(--os-5)}.section-heading{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:var(--os-4)}
    .gate-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--os-hairline);background:var(--os-canvas)}.gate-grid>div{padding:var(--os-5);border-inline-end:1px solid var(--os-hairline)}.gate-grid>div:last-child{border-inline-end:0}.gate-grid>div>span{display:block;margin-bottom:var(--os-3);color:var(--os-ink-muted);font-size:.65rem}.gate-grid p{margin:.5rem 0 0;color:var(--os-ink-muted);font-size:.64rem;line-height:1.45}
    .source-contract dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0;border:1px solid var(--os-hairline);background:var(--os-canvas)}.source-contract dl>div{display:grid;grid-template-columns:minmax(9rem,.7fr) minmax(0,1.3fr);gap:var(--os-4);padding:var(--os-4) var(--os-5);border-bottom:1px solid var(--os-hairline)}.source-contract dt{font-size:.65rem;font-weight:600}.source-contract dd{margin:0;color:var(--os-ink-muted);font-size:.64rem}
    .loading-block{display:grid;place-items:center;gap:var(--os-4);min-height:14rem;color:var(--os-ink-muted);font-size:.72rem}.warn{color:#684e00}.danger{color:#a2191f}
    @media(max-width:76rem){.service-grid{grid-template-columns:1fr}.core-consumers{grid-template-columns:1fr}.core-consumers>*{border-inline-end:0;border-bottom:1px solid var(--os-hairline)}.core-consumers>*:last-child{border-bottom:0}.status-rail{grid-template-columns:repeat(3,minmax(0,1fr))}.status-rail>div:nth-child(3){border-inline-end:0}.gate-grid{grid-template-columns:1fr}.gate-grid>div{border-inline-end:0;border-bottom:1px solid var(--os-hairline)}.gate-grid>div:last-child{border-bottom:0}}
    @media(max-width:48rem){.page-lead{display:grid}.page-meta{white-space:normal}.status-rail,.source-contract dl{grid-template-columns:1fr}.status-rail>div{border-inline-end:0;border-bottom:1px solid var(--os-hairline)}.status-rail>div:last-child{border-bottom:0}.source-contract dl>div{grid-template-columns:1fr;gap:var(--os-2)}}
  `],
})
export class AdminFoundationServices implements OnInit, OnDestroy {
  private readonly http = inject(HttpService);
  readonly renewIcon = Renew16;
  readonly snapshot = signal<FoundationSnapshot | null>(null);
  readonly busy = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly services = computed<FoundationService[]>(() => {
    const current = this.snapshot();
    if (!current) return [];
    return [
      this.dataService(current.supabase),
      this.changeService(current.change),
      this.monitoringService(current.monitoring, current.monitoringHealth),
    ];
  });
  readonly failedReads = computed(() => {
    const current = this.snapshot();
    if (!current) return [];
    return [
      current.supabase.error,
      current.change.error,
      current.monitoring.error,
      current.monitoringHealth.error,
      current.osdst.error,
    ].filter((item, index, all) => item && all.indexOf(item) === index);
  });
  readonly availableCount = computed(() => this.services().filter((item) =>
    item.state !== 'Unavailable' && item.state !== 'NotConfigured').length);
  readonly healthyCount = computed(() => this.services().filter((item) => item.state === 'Healthy').length);
  readonly gates = computed(() => {
    const current = this.snapshot();
    const supabase = current?.supabase.value;
    const change = current?.change.value;
    const monitoring = current?.monitoringHealth.value;
    const recoveryReady = !!supabase?.recovery?.available
      && this.recoveryState(supabase.recovery.supabase) === 'Healthy'
      && this.recoveryState(supabase.recovery.storage) === 'Healthy';
    return [
      {
        label: 'Data & Identity 복구 증거',
        state: (recoveryReady ? 'Healthy' : supabase ? 'Degraded' : 'Unavailable') as FoundationState,
        detail: recoveryReady
          ? 'Supabase 데이터베이스와 객체 저장 복구 증거가 검증되었습니다.'
          : supabase?.recovery?.reason || '검증된 데이터베이스·객체 저장 복구 증거가 부족합니다.',
      },
      {
        label: '선언형 변경 공급망',
        state: (change?.managementReady && change.supplyChain?.protected
          ? 'Healthy'
          : change?.ready ? 'Degraded' : change?.configured === false ? 'NotConfigured' : 'Unavailable') as FoundationState,
        detail: change?.managementReady && change.supplyChain?.protected
          ? `보호 브랜치 · ${change.supplyChain.requiredApprovals}명 승인 · 서명 요구 ${change.supplyChain.signedCommitsRequired ? '적용' : '미적용'}`
          : change?.reason || '승인·webhook·보호 브랜치 근거가 완전하지 않습니다.',
      },
      {
        label: '노드 시계열 신선도',
        state: (monitoring?.status === 'healthy'
          ? 'Healthy'
          : monitoring?.status === 'unconfigured' ? 'NotConfigured'
            : monitoring?.status === 'unavailable' || !monitoring ? 'Unavailable' : 'Stale') as FoundationState,
        detail: monitoring?.status === 'healthy'
          ? 'Beszel read-only adapter의 최신 표본과 Kubernetes 노드 결합이 확인되었습니다.'
          : monitoring?.reasons?.join(' · ') || '노드 시계열의 최신 근거를 확인할 수 없습니다.',
      },
    ];
  });
  readonly operationalAttentionCount = computed(() => this.gates().filter((item) =>
    item.state === 'Degraded' || item.state === 'Stale').length);
  readonly blockedCount = computed(() => [...this.services(), ...this.gates()].filter((item) =>
    item.state === 'Unavailable' || item.state === 'NotConfigured').length);
  readonly overallState = computed<FoundationState>(() => {
    const states = [...this.services(), ...this.gates()].map((item) => item.state);
    if (states.includes('Unavailable')) return 'Unavailable';
    if (states.includes('NotConfigured')) return 'NotConfigured';
    if (states.includes('Degraded')) return 'Degraded';
    if (states.includes('Stale')) return 'Stale';
    return states.length ? 'Healthy' : 'Unavailable';
  });
  readonly osdstState = computed<FoundationState>(() => {
    const result = this.snapshot()?.osdst;
    if (!result?.value) return 'Unavailable';
    return result.value.runtime?.ready === true && result.value.rollout?.ready === true
      ? 'Healthy' : 'Degraded';
  });

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(true), 30_000);
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.busy.set(true);
    const [supabase, change, monitoring, monitoringHealth, osdst] = await Promise.all([
      this.read<SupabaseStatus>('/api/identity/supabase/status', 'Data & Identity 상태'),
      this.read<ChangeStatus>('/api/platform/gitea/status', '선언형 변경 상태'),
      this.read<MonitoringOverview>('/api/monitoring/baseline/v1/overview', '노드 관측 요약'),
      this.read<MonitoringHealth>('/api/monitoring/baseline/v1/data-health', '노드 관측 데이터 상태'),
      this.read<OsdstControl>('/api/osaa/admin/dialogue-state', 'OSDST 상태'),
    ]);
    this.snapshot.set({
      generatedAt: new Date().toISOString(),
      supabase,
      change,
      monitoring,
      monitoringHealth,
      osdst,
    });
    if (!silent) this.busy.set(false);
  }

  osdstSummary(): string {
    const result = this.snapshot()?.osdst;
    if (!result?.value) return result?.error || '실측 상태를 확인할 수 없습니다.';
    const runtime = result.value.runtime || {};
    if (runtime.ready !== true) return runtime.error || 'OSDST runtime이 Ready가 아닙니다.';
    return `${runtime.version || 'version 미수집'} · ${result.value.mode || 'mode 미수집'} · CBSS Supabase projection`;
  }

  stateLabel(state: FoundationState): string {
    return ({
      Healthy: '정상',
      Degraded: '주의',
      Stale: '수집 지연',
      Unavailable: '사용 불가',
      NotConfigured: '미구성',
    } as Record<FoundationState, string>)[state];
  }
  stateClass(state: FoundationState): string { return `state-pill state-${state.toLowerCase()}`; }
  formatDate(value: string | null | undefined): string {
    if (!value) return '기록 없음';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '기록 없음' : date.toLocaleString('ko-KR');
  }

  private async read<T>(url: string, label: string): Promise<ReadResult<T>> {
    try {
      const response = await this.http.request(url, { cache: 'no-store' });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new Error(`${label}: JSON이 아닌 응답`);
      }
      const body = await response.json().catch(() => ({})) as T & { error?: string };
      if (!response.ok) throw new Error(`${label}: ${body.error || `HTTP ${response.status}`}`);
      return { value: body, error: '' };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : `${label}: ${String(error)}` };
    }
  }

  private dataService(result: ReadResult<SupabaseStatus>): FoundationService {
    const value = result.value;
    const ready = value?.components.filter((item) => item.ready).length || 0;
    const total = value?.components.length || 0;
    const state: FoundationState = !value ? 'Unavailable' : ready === total && total > 0 ? 'Healthy' : ready > 0 ? 'Degraded' : 'Unavailable';
    return {
      id: 'data',
      domain: 'Data & Identity',
      implementation: 'Supabase',
      role: 'Console 시스템 관리자 인증·권한과 업무 데이터·감사·객체 저장 권위',
      state,
      route: '/manage/data-identity',
      logo: LOGOS.data,
      observedAt: value?.meta.checkedAt || null,
      evidence: [
        { label: 'Owner probes', value: value ? `${ready}/${total}` : '미수집', hint: 'Auth · PostgREST · Storage' },
        { label: 'Operators', value: value ? String(value.operators) : '미수집', hint: '현재 inventory' },
        { label: 'Role contracts', value: value ? String(value.roles.length) : '미수집', hint: 'RLS 평가 역할' },
        { label: 'Audit events', value: value ? String(value.auditEvents) : '미수집', hint: '현재 bounded 조회' },
      ],
      warning: result.error || (state !== 'Healthy' ? '하나 이상의 Data & Identity owner probe가 준비되지 않았습니다.' : ''),
    };
  }

  private changeService(result: ReadResult<ChangeStatus>): FoundationService {
    const value = result.value;
    const state: FoundationState = !value ? 'Unavailable'
      : !value.configured ? 'NotConfigured'
        : value.ready && value.managementReady ? 'Healthy'
          : value.ready ? 'Degraded' : 'Unavailable';
    const pending = value ? ['intent', 'authorized', 'committed'].reduce((sum, key) => sum + Number(value.byStatus[key] || 0), 0) : null;
    return {
      id: 'change',
      domain: '선언형 상태 변경',
      implementation: 'Gitea',
      role: '검토 가능한 선언·교차 승인·적용 영수증·변경 이력 권위',
      state,
      route: '/manage/state-changes',
      logo: LOGOS.change,
      observedAt: value?.meta.checkedAt || null,
      evidence: [
        { label: 'Authority API', value: value?.ready ? '연결됨' : value ? '사용 불가' : '미수집', hint: value?.version || 'version 미수집' },
        { label: '선언 저장소', value: value?.repositoryCount === null || value?.repositoryCount === undefined ? '미수집' : String(value.repositoryCount), hint: '현재 inventory' },
        { label: '진행 중 변경', value: pending === null ? '미수집' : String(pending), hint: '요청 · 승인 · 적용 대기' },
        { label: '적용 / 실패', value: value ? `${value.byStatus['applied'] || 0} / ${value.byStatus['failed'] || 0}` : '미수집', hint: 'Kubernetes 실측 결과' },
      ],
      warning: result.error || value?.reason || '',
    };
  }

  private monitoringService(
    overviewResult: ReadResult<MonitoringOverview>,
    healthResult: ReadResult<MonitoringHealth>,
  ): FoundationService {
    const value = overviewResult.value;
    const health = healthResult.value;
    const state: FoundationState = !value || !health ? 'Unavailable'
      : health.status === 'unconfigured' ? 'NotConfigured'
        : health.status === 'unavailable' ? 'Unavailable'
          : value.freshness === 'stale' || health.status === 'degraded' ? 'Stale'
            : value.systems.down > 0 || value.systems.unmatched > 0 || value.systems.identityRejected > 0
              || value.systems.disagreement > 0 || value.kubernetes.nodesReady !== value.kubernetes.nodes
              ? 'Degraded' : 'Healthy';
    return {
      id: 'monitoring',
      domain: 'Infrastructure Monitoring',
      implementation: 'Beszel',
      role: '노드 OS 시계열·기초 경보와 Kubernetes Node 결합 관측',
      state,
      route: '/manage/infrastructure-monitoring',
      logo: LOGOS.monitoring,
      observedAt: value?.observedAt || health?.observedAt || health?.checkedAt || null,
      evidence: [
        { label: 'Agent 연결', value: value ? `${value.systems.up}/${value.systems.total}` : '미수집', hint: 'Beszel systems' },
        { label: 'Kubernetes Ready', value: value ? `${value.kubernetes.nodesReady}/${value.kubernetes.nodes}` : '미수집', hint: 'API 현재 상태' },
        { label: '수집 불일치', value: value ? String(value.systems.disagreement + value.systems.identityRejected) : '미수집', hint: '상태·신원 충돌' },
        { label: '활성 경보', value: value ? String(value.alerts.triggered) : '미수집', hint: value ? `${value.alerts.total}개 규칙` : '규칙 미수집' },
      ],
      warning: overviewResult.error || healthResult.error || health?.reasons?.join(' · ') || '',
    };
  }

  private recoveryState(value: { state?: string; declaredState?: string } | undefined): FoundationState {
    const state = value?.state || value?.declaredState || '';
    return /verified|ready|healthy/i.test(state) ? 'Healthy' : 'Degraded';
  }
}
