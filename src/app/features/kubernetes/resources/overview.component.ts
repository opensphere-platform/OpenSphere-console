import { CommonModule } from '@angular/common';
import { Component, EventEmitter, OnInit, Output, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { K8sService } from '../core/k8s.service';
import { NAV_ICON } from '../nav-icons';

const isNodeReady = (o: any) => !!o.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True');
const nodeRoles = (o: any) => Object.keys(o.metadata?.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).filter(Boolean);

/** CPU 문자열 → millicore. */
function cpuM(v?: string): number {
  if (!v) return 0;
  if (v.endsWith('n')) return parseInt(v, 10) / 1e6;
  if (v.endsWith('u')) return parseInt(v, 10) / 1e3;
  if (v.endsWith('m')) return parseInt(v, 10);
  return parseFloat(v) * 1000;
}
/** 메모리 문자열 → bytes. */
function memB(v?: string): number {
  if (!v) return 0;
  const u: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, Pi: 1024 ** 5 };
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(v);
  if (!m) return 0;
  return m[2] && u[m[2]] ? parseFloat(m[1]) * u[m[2]] : parseFloat(m[1]);
}

// Chart/gauge 팔레트 — SVG attr 바인딩용. CSS var()는 SVG stroke attr에 미작동하므로
// OS 토큰 팔레트에서 의미론적으로 선정된 고정값 사용(디자인 시스템 계약).
const PHASE_COLOR: Record<string, string> = {
  Running:   'var(--clr-color-success-600, #2ecc71)',
  Succeeded: 'var(--clr-color-action-600, #3498db)',
  Pending:   'var(--clr-color-warning-700, #f1c40f)',
  Failed:    'var(--clr-color-danger-700,  #e74c3c)',
  Unknown:   'var(--clr-color-neutral-500, #95a5a6)',
};
// Namespace bar palette — 8색 시리즈 (OS 브랜드 팔레트 계열)
const NS_PALETTE = [
  'var(--os-brand-500, #4c6fff)',
  'var(--clr-color-success-700, #1f7a4d)',
  'var(--clr-color-danger-800,  #7b1d3a)',
  'var(--clr-color-danger-700,  #e74c3c)',
  'var(--clr-color-action-800,  #8e44ad)',
  'var(--os-accent,             #00bfa5)',
  'var(--clr-color-action-700,  #6b52ae)',
  'var(--clr-color-warning-900, #b8860b)',
];

interface Seg { color: string; dash: string; offset: string; }
interface Bar { label: string; value: number; sub?: string; pct: number; color: string; }

/** 클러스터 개요(인덱스) — SVG 차트(라이브러리 무의존). 카드/차트 클릭 시 해당 리스트로 이동. */
@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  template: `
    <div class="os-title-row">
      <h2 class="os-h2">Cluster Overview <span class="label label-info">Angular · Clarity</span></h2>
      <span class="os-sub" *ngIf="!loaded()">불러오는 중…</span>
      <button class="btn btn-sm btn-link os-ml-auto" (click)="loadAll()">새로고침</button>
    </div>

    <div *ngIf="error()" class="alert alert-danger" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div>
    </div>

    <!-- 게이지 카드 -->
    <div class="os-ov-cards">
      <div class="os-ov-gcard" role="button" tabindex="0" (click)="go('nodes')" (keydown.enter)="go('nodes')">
        <div class="os-ov-gh">CPU <span class="os-muted">{{ usageMode() }}</span></div>
        <div class="os-ov-gsub">{{ cpuNum() }} / {{ cpuDen() }} cores</div>
        <svg viewBox="0 0 120 120" class="os-gauge"><circle class="os-gtrack" cx="60" cy="60" r="52" pathLength="100"/><circle class="os-gval os-gval-cpu" cx="60" cy="60" r="52" pathLength="100" [attr.stroke-dasharray]="gd(cpuPct())" transform="rotate(-90 60 60)"/><text x="60" y="66" class="os-gtxt">{{ cpuPct() }}%</text></svg>
      </div>
      <div class="os-ov-gcard" role="button" tabindex="0" (click)="go('nodes')" (keydown.enter)="go('nodes')">
        <div class="os-ov-gh">Memory <span class="os-muted">{{ usageMode() }}</span></div>
        <div class="os-ov-gsub">{{ memNum() }} / {{ memDen() }} GB</div>
        <svg viewBox="0 0 120 120" class="os-gauge"><circle class="os-gtrack" cx="60" cy="60" r="52" pathLength="100"/><circle class="os-gval os-gval-mem" cx="60" cy="60" r="52" pathLength="100" [attr.stroke-dasharray]="gd(memPct())" transform="rotate(-90 60 60)"/><text x="60" y="66" class="os-gtxt">{{ memPct() }}%</text></svg>
      </div>
      <div class="os-ov-gcard" role="button" tabindex="0" (click)="go('pods')" (keydown.enter)="go('pods')">
        <div class="os-ov-gh">Pods</div>
        <div class="os-ov-gsub">{{ podsScheduled() }} / {{ pods().length }} scheduled</div>
        <svg viewBox="0 0 120 120" class="os-gauge"><circle class="os-gtrack" cx="60" cy="60" r="52" pathLength="100"/><circle class="os-gval os-gval-pods" cx="60" cy="60" r="52" pathLength="100" [attr.stroke-dasharray]="gd(podSchedPct())" transform="rotate(-90 60 60)"/><text x="60" y="66" class="os-gtxt">{{ podSchedPct() }}%</text></svg>
      </div>
      <div class="os-ov-gcard" role="button" tabindex="0" (click)="go('nodes')" (keydown.enter)="go('nodes')">
        <div class="os-ov-gh">Nodes</div>
        <div class="os-ov-gsub">{{ nodeReady() }} / {{ nodes().length }} ready</div>
        <svg viewBox="0 0 120 120" class="os-gauge"><circle class="os-gtrack" cx="60" cy="60" r="52" pathLength="100"/><circle class="os-gval os-gval-nodes" cx="60" cy="60" r="52" pathLength="100" [attr.stroke-dasharray]="gd(nodeReadyPct())" transform="rotate(-90 60 60)"/><text x="60" y="66" class="os-gtxt">{{ nodeReadyPct() }}%</text></svg>
      </div>
    </div>

    <h3 class="os-ov-sech">클러스터 상세</h3>

    <div class="os-ov-grid">
      <!-- Pod 상태 분포 도넛 -->
      <div class="card">
        <div class="card-header">Pod Status Distribution</div>
        <div class="card-block os-ov-donutblock">
          <svg viewBox="0 0 120 120" class="os-gauge">
            <circle class="os-gtrack" cx="60" cy="60" r="52" pathLength="100"/>
            <circle *ngFor="let s of podSegs()" cx="60" cy="60" r="52" pathLength="100" fill="none" stroke-width="14" [attr.stroke]="s.color" [attr.stroke-dasharray]="s.dash" [attr.stroke-dashoffset]="s.offset" transform="rotate(-90 60 60)"/>
            <text x="60" y="58" class="os-gtxt">{{ pods().length }}</text><text x="60" y="74" class="os-gsmall">pods</text>
          </svg>
          <div class="os-ov-legend">
            <div *ngFor="let p of phaseList()"><span class="os-dot" [style.background]="phaseColor(p.k)"></span>{{ p.k }} <strong>{{ p.v }}</strong> <span class="os-muted">({{ pct(p.v, pods().length) }}%)</span></div>
          </div>
        </div>
      </div>

      <!-- 워크로드 상태 바 -->
      <div class="card">
        <div class="card-header os-ov-cardh" role="button" tabindex="0" (click)="go('deployments')" (keydown.enter)="go('deployments')">Workload Health</div>
        <div class="card-block">
          <div class="os-bar-row" *ngFor="let b of workloadBars()">
            <span class="os-bar-lbl">{{ b.label }}</span>
            <div class="os-bar-track"><i [style.width.%]="b.pct" [style.background]="b.color"></i></div>
            <span class="os-bar-val">{{ b.sub }}</span>
          </div>
          <div class="os-muted os-wl-summary">{{ workloadSummary() }}</div>
        </div>
      </div>
    </div>

    <div class="os-ov-grid">
      <!-- 네임스페이스별 Pod 수 -->
      <div class="card">
        <div class="card-header os-ov-cardh" role="button" tabindex="0" (click)="go('pods')" (keydown.enter)="go('pods')">Pods by Namespace (top 8)</div>
        <div class="card-block">
          <div class="os-bar-row" *ngFor="let b of nsBars()">
            <span class="os-bar-lbl" [title]="b.label">{{ b.label }}</span>
            <div class="os-bar-track"><i [style.width.%]="b.pct" [style.background]="b.color"></i></div>
            <span class="os-bar-val">{{ b.value }}</span>
          </div>
          <div *ngIf="!nsBars().length" class="os-muted">—</div>
        </div>
      </div>

      <!-- 컨테이너 재시작 Top -->
      <div class="card">
        <div class="card-header os-ov-cardh" role="button" tabindex="0" (click)="go('pods')" (keydown.enter)="go('pods')">Container Restarts <span class="os-muted">— {{ restartBars().length }} pods ({{ restartTotal() }} total)</span></div>
        <div class="card-block">
          <div class="os-bar-row" *ngFor="let b of restartBars()">
            <span class="os-bar-lbl" [title]="b.label">{{ b.label }}</span>
            <div class="os-bar-track"><i [style.width.%]="b.pct" [style.background]="b.color"></i></div>
            <span class="os-bar-val">{{ b.value }}</span>
          </div>
          <div *ngIf="!restartBars().length" class="os-muted">재시작 없음 👍</div>
        </div>
      </div>
    </div>

    <!-- 노드 표 -->
    <div class="card">
      <div class="card-header os-ov-cardh" role="button" tabindex="0" (click)="go('nodes')" (keydown.enter)="go('nodes')">노드</div>
      <clr-datagrid [clrDgLoading]="!loaded()">
        <clr-dg-column>Name</clr-dg-column><clr-dg-column>Status</clr-dg-column><clr-dg-column>Roles</clr-dg-column><clr-dg-column>Version</clr-dg-column><clr-dg-column>Internal IP</clr-dg-column>
        <clr-dg-row *clrDgItems="let n of nodes()">
          <clr-dg-cell><strong>{{ n.metadata?.name }}</strong></clr-dg-cell>
          <clr-dg-cell><span class="label" [ngClass]="ready(n) ? 'label-success' : 'label-danger'">{{ ready(n) ? 'Ready' : 'NotReady' }}</span></clr-dg-cell>
          <clr-dg-cell><span *ngFor="let r of roles(n)" class="label">{{ r }}</span><span *ngIf="!roles(n).length" class="os-muted">—</span></clr-dg-cell>
          <clr-dg-cell>{{ n.status?.nodeInfo?.kubeletVersion }}</clr-dg-cell>
          <clr-dg-cell>{{ internalIP(n) }}</clr-dg-cell>
        </clr-dg-row>
        <clr-dg-placeholder>No nodes.</clr-dg-placeholder>
      </clr-datagrid>
    </div>

    <!-- 최근 경고 -->
    <div class="card">
      <div class="card-header os-ov-cardh" role="button" tabindex="0" (click)="go('events')" (keydown.enter)="go('events')">최근 경고 (Warnings) <span class="os-muted">→ Events</span></div>
      <clr-datagrid [clrDgLoading]="!loaded()">
        <clr-dg-column>Reason</clr-dg-column><clr-dg-column>Object</clr-dg-column><clr-dg-column>Message</clr-dg-column><clr-dg-column>Age</clr-dg-column>
        <clr-dg-row *clrDgItems="let e of recentWarnings()">
          <clr-dg-cell><span class="label label-warning">{{ e.reason }}</span></clr-dg-cell>
          <clr-dg-cell>{{ e.involvedObject?.kind }}/{{ e.involvedObject?.name }}</clr-dg-cell>
          <clr-dg-cell>{{ e.message }}</clr-dg-cell>
          <clr-dg-cell>{{ age(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp) }}</clr-dg-cell>
        </clr-dg-row>
        <clr-dg-placeholder>경고 이벤트 없음.</clr-dg-placeholder>
      </clr-datagrid>
    </div>
  `,
})
export class OverviewComponent implements OnInit {
  @Output() open = new EventEmitter<string>();

  private k8s = inject(K8sService);
  readonly nodes = signal<any[]>([]);
  readonly namespaces = signal<any[]>([]);
  readonly pods = signal<any[]>([]);
  readonly deploys = signal<any[]>([]);
  readonly statefulsets = signal<any[]>([]);
  readonly daemonsets = signal<any[]>([]);
  readonly services = signal<any[]>([]);
  readonly events = signal<any[]>([]);
  readonly metrics = signal<any[] | null>(null);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void { this.loadAll(); }

  loadAll(): void {
    this.loaded.set(false);
    this.error.set(null);
    const safe = (p: string) => this.k8s.list(p).pipe(catchError(() => of({ items: [] as any[] })));
    forkJoin({
      nodes: safe('/api/v1/nodes'), namespaces: safe('/api/v1/namespaces'), pods: safe('/api/v1/pods'),
      deploys: safe('/apis/apps/v1/deployments'), statefulsets: safe('/apis/apps/v1/statefulsets'),
      daemonsets: safe('/apis/apps/v1/daemonsets'), services: safe('/api/v1/services'), events: safe('/api/v1/events'),
      metrics: this.k8s.list('/apis/metrics.k8s.io/v1beta1/nodes').pipe(catchError(() => of(null))),
    }).subscribe({
      next: r => {
        this.nodes.set(r.nodes.items || []); this.namespaces.set(r.namespaces.items || []); this.pods.set(r.pods.items || []);
        this.deploys.set(r.deploys.items || []); this.statefulsets.set(r.statefulsets.items || []); this.daemonsets.set(r.daemonsets.items || []);
        this.services.set(r.services.items || []); this.events.set(r.events.items || []);
        this.metrics.set(r.metrics ? (r.metrics.items || []) : null); this.loaded.set(true);
      },
      error: e => { this.error.set(e?.error?.error || e?.message || String(e)); this.loaded.set(true); },
    });
  }

  go(id: string) { this.open.emit(id); }
  ready = isNodeReady; roles = nodeRoles;
  internalIP(n: any) { return (n.status?.addresses || []).find((a: any) => a.type === 'InternalIP')?.address || '—'; }
  pct(v: number, t: number) { return t ? Math.round((v / t) * 100) : 0; }
  gd(p: number) { return `${Math.max(0, Math.min(100, p))} ${100 - Math.max(0, Math.min(100, p))}`; }
  phaseColor(k: string) { return PHASE_COLOR[k] || PHASE_COLOR['Unknown']; }

  // ── 게이지 (CPU/Mem: 사용량 or 요청량 ÷ 할당량) ──
  readonly metricsAvailable = computed(() => !!this.metrics()?.length);
  usageMode() { return this.metricsAvailable() ? '사용' : '요청'; }
  private allocCpuM = computed(() => this.nodes().reduce((s, n) => s + cpuM(n.status?.allocatable?.cpu ?? n.status?.capacity?.cpu), 0));
  private allocMemB = computed(() => this.nodes().reduce((s, n) => s + memB(n.status?.allocatable?.memory ?? n.status?.capacity?.memory), 0));
  private reqCpuM = computed(() => this.pods().reduce((s, p) => s + (p.spec?.containers || []).reduce((c: number, x: any) => c + cpuM(x.resources?.requests?.cpu), 0), 0));
  private reqMemB = computed(() => this.pods().reduce((s, p) => s + (p.spec?.containers || []).reduce((c: number, x: any) => c + memB(x.resources?.requests?.memory), 0), 0));
  private useCpuM = computed(() => (this.metrics() || []).reduce((s, m) => s + cpuM(m.usage?.cpu), 0));
  private useMemB = computed(() => (this.metrics() || []).reduce((s, m) => s + memB(m.usage?.memory), 0));
  private numCpuM = computed(() => this.metricsAvailable() ? this.useCpuM() : this.reqCpuM());
  private numMemB = computed(() => this.metricsAvailable() ? this.useMemB() : this.reqMemB());
  cpuNum() { return (this.numCpuM() / 1000).toFixed(2); }
  cpuDen() { return (this.allocCpuM() / 1000).toFixed(0); }
  memNum() { return (this.numMemB() / 1024 ** 3).toFixed(2); }
  memDen() { return (this.allocMemB() / 1024 ** 3).toFixed(2); }
  cpuPct() { const d = this.allocCpuM(); return d ? Math.round((this.numCpuM() / d) * 100) : 0; }
  memPct() { const d = this.allocMemB(); return d ? Math.round((this.numMemB() / d) * 100) : 0; }

  readonly nodeReady = computed(() => this.nodes().filter(isNodeReady).length);
  nodeReadyPct() { return this.pct(this.nodeReady(), this.nodes().length); }
  readonly podsScheduled = computed(() => this.pods().filter(p => !!p.spec?.nodeName).length);
  podSchedPct() { return this.pct(this.podsScheduled(), this.pods().length); }

  // ── Pod 상태 분포 ──
  readonly phaseList = computed(() => {
    const c: Record<string, number> = {};
    for (const p of this.pods()) { const k = p.status?.phase || 'Unknown'; c[k] = (c[k] || 0) + 1; }
    return Object.entries(c).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
  });
  readonly podSegs = computed<Seg[]>(() => {
    const total = this.pods().length || 1;
    let acc = 0;
    return this.phaseList().map(p => {
      const f = (p.v / total) * 100;
      const seg = { color: this.phaseColor(p.k), dash: `${f} ${100 - f}`, offset: `${-acc}` };
      acc += f; return seg;
    });
  });

  // ── 워크로드 상태 ──
  private dReady = (o: any) => o.status?.readyReplicas ?? o.status?.availableReplicas ?? 0;
  readonly workloadBars = computed<Bar[]>(() => {
    const items = [
      { label: 'Deployments', ready: this.deploys().reduce((s, o) => s + this.dReady(o), 0), total: this.deploys().reduce((s, o) => s + (o.spec?.replicas ?? 0), 0) },
      { label: 'StatefulSets', ready: this.statefulsets().reduce((s, o) => s + (o.status?.readyReplicas ?? 0), 0), total: this.statefulsets().reduce((s, o) => s + (o.spec?.replicas ?? 0), 0) },
      { label: 'DaemonSets', ready: this.daemonsets().reduce((s, o) => s + (o.status?.numberReady ?? 0), 0), total: this.daemonsets().reduce((s, o) => s + (o.status?.desiredNumberScheduled ?? 0), 0) },
    ];
    const max = Math.max(1, ...items.map(i => i.total));
    return items.map(i => ({ label: i.label, value: i.total, sub: `${i.ready}/${i.total}`, pct: (i.total / max) * 100, color: i.ready >= i.total && i.total > 0 ? 'var(--clr-color-success-600,#2ecc71)' : 'var(--clr-color-warning-700,#f1c40f)' }));
  });
  workloadSummary() { return this.workloadBars().map(b => `${b.label} ${b.sub}`).join(' · '); }

  // ── 네임스페이스별 Pod (top 8) ──
  readonly nsBars = computed<Bar[]>(() => {
    const c: Record<string, number> = {};
    for (const p of this.pods()) { const ns = p.metadata?.namespace || '—'; c[ns] = (c[ns] || 0) + 1; }
    const arr = Object.entries(c).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 8);
    const max = Math.max(1, ...arr.map(a => a.v));
    return arr.map((a, i) => ({ label: a.k, value: a.v, pct: (a.v / max) * 100, color: NS_PALETTE[i % NS_PALETTE.length] }));
  });

  // ── 컨테이너 재시작 Top ──
  private podRestarts = (p: any) => (p.status?.containerStatuses || []).reduce((s: number, c: any) => s + (c.restartCount || 0), 0);
  readonly restartTotal = computed(() => this.pods().reduce((s, p) => s + this.podRestarts(p), 0));
  readonly restartBars = computed<Bar[]>(() => {
    const arr = this.pods().map(p => ({ k: p.metadata?.name as string, v: this.podRestarts(p) })).filter(a => a.v > 0).sort((a, b) => b.v - a.v).slice(0, 6);
    const max = Math.max(1, ...arr.map(a => a.v));
    return arr.map(a => ({ label: a.k, value: a.v, pct: (a.v / max) * 100, color: 'var(--clr-color-warning-800,#e67e22)' }));
  });

  // ── 경고 ──
  readonly warnings = computed(() => this.events().filter(e => e.type === 'Warning'));
  readonly recentWarnings = computed(() => [...this.warnings()].sort((a, b) => this.ts(b) - this.ts(a)).slice(0, 12));
  private ts(e: any) { return new Date(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || 0).getTime(); }

  age(tsv: string): string {
    if (!tsv) return '—';
    const ms = Date.now() - new Date(tsv).getTime();
    const d = Math.floor(ms / 86400000); if (d > 0) return d + 'd';
    const h = Math.floor(ms / 3600000); if (h > 0) return h + 'h';
    const m = Math.floor(ms / 60000); return m > 0 ? m + 'm' : '<1m';
  }
}
