import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { K8sService } from '../core/k8s.service';

/** 메모리/스토리지 문자열 → bytes. */
function memBytes(v?: string): number {
  if (!v) return 0;
  const u: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, Pi: 1024 ** 5 };
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(String(v));
  if (!m) return 0;
  return m[2] && u[m[2]] ? parseFloat(m[1]) * u[m[2]] : parseFloat(m[1]);
}
/** VM의 vCPU 수(domain.cpu sockets*cores*threads, 없으면 resources.requests.cpu). */
function vmVcpu(v: any): number {
  const d = v.spec?.template?.spec?.domain;
  if (d?.cpu) { const c = d.cpu; return (c.sockets || 1) * (c.cores || 1) * (c.threads || 1); }
  const r = d?.resources?.requests?.cpu;
  if (r) return Math.ceil(parseFloat(String(r)) || 0);
  return 0;
}
/** VM의 메모리 bytes(domain.memory.guest, 없으면 resources.requests.memory). */
function vmMemBytes(v: any): number {
  const d = v.spec?.template?.spec?.domain;
  return memBytes(d?.memory?.guest || d?.resources?.requests?.memory);
}

const VM_STATUS_COLOR: Record<string, string> = {
  Running: 'var(--clr-color-success-600, #2ecc71)',
  Stopped: 'var(--clr-color-warning-700, #f1c40f)',
  Error:   'var(--clr-color-danger-700,  #e74c3c)',
  Other:   'var(--clr-color-neutral-500, #95a5a6)',
};
const NS_PALETTE = ['var(--os-brand-500,#4c6fff)', 'var(--clr-color-success-700,#1f7a4d)', 'var(--clr-color-action-800,#8e44ad)', 'var(--os-accent,#00bfa5)', 'var(--clr-color-warning-900,#b8860b)'];

interface Seg { color: string; dash: string; offset: string; }
interface Bar { label: string; value: number; pct: number; color: string; }

/**
 * 가상화 개요 대시보드(OpenShift Virtualization 개요 등가) — 실 KubeVirt 데이터.
 * VM 수·상태(Running/Stopped/Error)·vCPU/Memory/Storage 합계 + 상태 분포 도넛 + ns별 분포 + VM 표.
 * app.component capability-gate(kubevirt.io) 통과 시 nav에 노출. 라이브러리 무의존 SVG(overview.component 패턴).
 */
@Component({
  selector: 'app-vm-overview',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  styles: [`
    .vm-ov-gnum { font-size: 2.1rem; font-weight: 200; line-height: 1.1; margin: 0.2rem 0; }
  `],
  template: `
    <div class="os-title-row">
      <h2 class="os-h2">가상화 개요 <span class="label label-info">Virtualization</span></h2>
      <span class="os-sub" *ngIf="!loaded()">불러오는 중…</span>
      <button class="btn btn-sm btn-link os-ml-auto" (click)="loadAll()">새로고침</button>
    </div>

    <div *ngIf="error()" class="alert alert-warning" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div>
    </div>

    <!-- 합계 카드 -->
    <div class="os-ov-cards">
      <div class="os-ov-gcard">
        <div class="os-ov-gh">VirtualMachines</div>
        <div class="vm-ov-gnum">{{ vms().length }}</div>
        <div class="os-ov-gsub">{{ running() }} running · {{ stopped() }} stopped</div>
      </div>
      <div class="os-ov-gcard">
        <div class="os-ov-gh">vCPU <span class="os-muted">요청</span></div>
        <div class="vm-ov-gnum">{{ totalVcpu() }}</div>
        <div class="os-ov-gsub">running VMs 합계</div>
      </div>
      <div class="os-ov-gcard">
        <div class="os-ov-gh">Memory <span class="os-muted">요청</span></div>
        <div class="vm-ov-gnum">{{ totalMemGb() }}</div>
        <div class="os-ov-gsub">GB · running VMs</div>
      </div>
      <div class="os-ov-gcard">
        <div class="os-ov-gh">Storage</div>
        <div class="vm-ov-gnum">{{ totalStorageGb() }}</div>
        <div class="os-ov-gsub">GB · DataVolumes</div>
      </div>
    </div>

    <h3 class="os-ov-sech">VirtualMachine 상태</h3>
    <div class="os-ov-grid">
      <!-- 상태 분포 도넛 -->
      <div class="card">
        <div class="card-header">상태 분포</div>
        <div class="card-block os-ov-donutblock">
          <svg viewBox="0 0 120 120" class="os-gauge">
            <circle class="os-gtrack" cx="60" cy="60" r="52" pathLength="100"/>
            <circle *ngFor="let s of statusSegs()" cx="60" cy="60" r="52" pathLength="100" fill="none" stroke-width="14" [attr.stroke]="s.color" [attr.stroke-dasharray]="s.dash" [attr.stroke-dashoffset]="s.offset" transform="rotate(-90 60 60)"/>
            <text x="60" y="58" class="os-gtxt">{{ vms().length }}</text><text x="60" y="74" class="os-gsmall">VMs</text>
          </svg>
          <div class="os-ov-legend">
            <div *ngFor="let s of statusList()"><span class="os-dot" [style.background]="statusColor(s.k)"></span>{{ s.k }} <strong>{{ s.v }}</strong></div>
            <div *ngIf="!statusList().length" class="os-muted">VM 없음</div>
          </div>
        </div>
      </div>

      <!-- 네임스페이스별 VM -->
      <div class="card">
        <div class="card-header">네임스페이스별 VM (top 5)</div>
        <div class="card-block">
          <div class="os-bar-row" *ngFor="let b of nsBars()">
            <span class="os-bar-lbl" [title]="b.label">{{ b.label }}</span>
            <div class="os-bar-track"><i [style.width.%]="b.pct" [style.background]="b.color"></i></div>
            <span class="os-bar-val">{{ b.value }}</span>
          </div>
          <div *ngIf="!nsBars().length" class="os-muted">VM 없음</div>
        </div>
      </div>
    </div>

    <!-- VM 표 -->
    <div class="card">
      <div class="card-header">VirtualMachines</div>
      <clr-datagrid [clrDgLoading]="!loaded()">
        <clr-dg-column>Namespace</clr-dg-column><clr-dg-column>Name</clr-dg-column><clr-dg-column>Status</clr-dg-column><clr-dg-column>Ready</clr-dg-column><clr-dg-column>Node</clr-dg-column>
        <clr-dg-row *clrDgItems="let v of vms()">
          <clr-dg-cell>{{ v.metadata?.namespace }}</clr-dg-cell>
          <clr-dg-cell><strong>{{ v.metadata?.name }}</strong></clr-dg-cell>
          <clr-dg-cell><span class="label" [style.borderColor]="statusColor(bucket(v))" [style.color]="statusColor(bucket(v))">{{ v.status?.printableStatus || 'Unknown' }}</span></clr-dg-cell>
          <clr-dg-cell>{{ v.status?.ready ? 'True' : 'False' }}</clr-dg-cell>
          <clr-dg-cell>{{ v.status?.nodeName || '—' }}</clr-dg-cell>
        </clr-dg-row>
        <clr-dg-placeholder>VirtualMachine 없음.</clr-dg-placeholder>
      </clr-datagrid>
    </div>
  `,
})
export class VmOverviewComponent implements OnInit {
  private k8s = inject(K8sService);
  readonly vms = signal<any[]>([]);
  readonly dvs = signal<any[]>([]);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void { this.loadAll(); }

  loadAll(): void {
    this.loaded.set(false);
    this.error.set(null);
    const safe = (p: string) => this.k8s.list(p).pipe(catchError(() => of({ items: [] as any[] })));
    forkJoin({
      vms: this.k8s.list('/apis/kubevirt.io/v1/virtualmachines').pipe(
        catchError(e => { this.error.set('VirtualMachine 조회 실패: ' + (e?.error?.error || e?.error?.message || e?.status || e?.message)); return of({ items: [] as any[] }); }),
      ),
      dvs: safe('/apis/cdi.kubevirt.io/v1beta1/datavolumes'),
    }).subscribe({
      next: r => { this.vms.set(r.vms.items || []); this.dvs.set(r.dvs.items || []); this.loaded.set(true); },
      error: e => { this.error.set(String(e)); this.loaded.set(true); },
    });
  }

  bucket(v: any): string {
    const s = String(v.status?.printableStatus || '');
    if (s === 'Running') return 'Running';
    if (s === 'Stopped' || s === 'Paused') return 'Stopped';
    if (s.startsWith('Error') || s === 'CrashLoopBackOff' || s === 'Unschedulable') return 'Error';
    return 'Other';
  }
  statusColor(k: string): string { return VM_STATUS_COLOR[k] || VM_STATUS_COLOR['Other']; }

  readonly running = computed(() => this.vms().filter(v => this.bucket(v) === 'Running').length);
  readonly stopped = computed(() => this.vms().filter(v => this.bucket(v) === 'Stopped').length);

  readonly statusList = computed(() => {
    const order = ['Running', 'Stopped', 'Error', 'Other'];
    const c: Record<string, number> = {};
    for (const v of this.vms()) { const b = this.bucket(v); c[b] = (c[b] || 0) + 1; }
    return order.filter(k => c[k]).map(k => ({ k, v: c[k] }));
  });
  readonly statusSegs = computed<Seg[]>(() => {
    const total = this.vms().length || 1;
    let acc = 0;
    return this.statusList().map(s => {
      const f = (s.v / total) * 100;
      const seg = { color: this.statusColor(s.k), dash: `${f} ${100 - f}`, offset: `${-acc}` };
      acc += f; return seg;
    });
  });

  readonly totalVcpu = computed(() => this.vms().filter(v => this.bucket(v) === 'Running').reduce((s, v) => s + vmVcpu(v), 0));
  readonly totalMemGb = computed(() => (this.vms().filter(v => this.bucket(v) === 'Running').reduce((s, v) => s + vmMemBytes(v), 0) / 1024 ** 3).toFixed(1));
  readonly totalStorageGb = computed(() => (this.dvs().reduce((s, d) => s + memBytes(d.spec?.storage?.resources?.requests?.storage || d.spec?.pvc?.resources?.requests?.storage), 0) / 1024 ** 3).toFixed(1));

  readonly nsBars = computed<Bar[]>(() => {
    const c: Record<string, number> = {};
    for (const v of this.vms()) { const ns = v.metadata?.namespace || '—'; c[ns] = (c[ns] || 0) + 1; }
    const arr = Object.entries(c).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 5);
    const max = Math.max(1, ...arr.map(a => a.v));
    return arr.map((a, i) => ({ label: a.k, value: a.v, pct: (a.v / max) * 100, color: NS_PALETTE[i % NS_PALETTE.length] }));
  });
}
