import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { K8sService } from '../core/k8s.service';

const isReady = (n: any) => !!n.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True');
const nodeRoles = (n: any) => Object.keys(n.metadata?.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).filter(Boolean).join(', ') || 'worker';
const kvm = (n: any) => !!(n.status?.allocatable?.['devices.kubevirt.io/kvm'] || n.status?.capacity?.['devices.kubevirt.io/kvm']);
function cpuM(v?: string): number { if (!v) return 0; if (v.endsWith('n')) return parseInt(v, 10) / 1e6; if (v.endsWith('u')) return parseInt(v, 10) / 1e3; if (v.endsWith('m')) return parseInt(v, 10); return parseFloat(v) * 1000; }
function memB(v?: string): number {
  if (!v) return 0;
  const u: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, Pi: 1024 ** 5 };
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(String(v)); if (!m) return 0;
  return m[2] && u[m[2]] ? parseFloat(m[1]) * u[m[2]] : parseFloat(m[1]);
}

/**
 * 운영 노드 중심 보기 — 각 노드에 어떤 VM·파드가 배치돼 있고 용량·할당률은 얼마인가(설치된 노드 개념).
 * nodes + pods(spec.nodeName 요청량 집계) + VMIs(status.nodeName). 사용률=요청량÷할당량(metrics-server 무의존).
 */
@Component({
  selector: 'app-node-workloads',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  styles: [`
    .nw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .nw-kv { display: grid; grid-template-columns: 90px 1fr; gap: .25rem .6rem; padding: .2rem 0; }
    .nw-kv dt { color: var(--clr-color-neutral-600, #666); }
    .nw-kv dd { margin: 0; }
    .nw-bar { display: flex; align-items: center; gap: .5rem; margin: .3rem 0; }
    .nw-bar-lbl { width: 56px; font-size: .78rem; color: var(--clr-color-neutral-600, #666); }
    .nw-bar-track { flex: 1; height: 9px; background: var(--clr-color-neutral-200, #e8e8e8); border-radius: 5px; overflow: hidden; }
    .nw-bar-track i { display: block; height: 100%; }
    .nw-bar-val { width: 110px; text-align: right; font-size: .76rem; color: var(--clr-color-neutral-700, #565656); }
    .nw-vms { margin-top: .6rem; display: flex; flex-wrap: wrap; gap: .3rem; }
  `],
  template: `
    <div class="os-title-row">
      <h2 class="os-h2">노드 워크로드 <span class="label label-info">Node-centric</span></h2>
      <span class="os-sub" *ngIf="!loaded()">불러오는 중…</span>
      <button class="btn btn-sm btn-link os-ml-auto" (click)="load()">새로고침</button>
    </div>
    <p class="os-sub">운영 노드별 배치 현황 — 각 노드의 VM·파드·용량·<strong>할당률</strong>(요청량÷할당량)·VM 가능 여부.</p>
    <div class="nw-grid">
      <div class="card" *ngFor="let n of nodeView()">
        <div class="card-header">
          {{ n.name }}
          <span class="label" [ngClass]="n.ready ? 'label-success' : 'label-danger'">{{ n.ready ? 'Ready' : 'NotReady' }}</span>
          <span class="label label-info" *ngIf="n.kvm">VM 가능</span>
        </div>
        <div class="card-block">
          <dl class="nw-kv">
            <dt>역할</dt><dd>{{ n.roles }}</dd>
            <dt>파드</dt><dd>{{ n.podCount }}</dd>
            <dt>VM</dt><dd><strong>{{ n.vms.length }}</strong></dd>
          </dl>
          <div class="nw-bar">
            <span class="nw-bar-lbl">CPU</span>
            <div class="nw-bar-track"><i [style.width.%]="n.cpuPct" [style.background]="barColor(n.cpuPct)"></i></div>
            <span class="nw-bar-val">{{ n.cpuPct }}% · {{ n.cpuReq }}/{{ n.cpuCap }}</span>
          </div>
          <div class="nw-bar">
            <span class="nw-bar-lbl">메모리</span>
            <div class="nw-bar-track"><i [style.width.%]="n.memPct" [style.background]="barColor(n.memPct)"></i></div>
            <span class="nw-bar-val">{{ n.memPct }}% · {{ n.memReq }}/{{ n.memCap }} GiB</span>
          </div>
          <div class="nw-vms" *ngIf="n.vms.length">
            <span class="label label-info" *ngFor="let v of n.vms">🖥 {{ v }}</span>
          </div>
          <div class="os-muted" *ngIf="!n.vms.length">이 노드에 VM 없음</div>
        </div>
      </div>
      <div *ngIf="!nodeView().length && loaded()" class="os-muted">노드 없음.</div>
    </div>
  `,
})
export class NodeWorkloadsComponent implements OnInit {
  private k8s = inject(K8sService);
  readonly nodes = signal<any[]>([]);
  readonly pods = signal<any[]>([]);
  readonly vmis = signal<any[]>([]);
  readonly loaded = signal(false);

  ngOnInit(): void { this.load(); }
  load(): void {
    this.loaded.set(false);
    const safe = (p: string) => this.k8s.list(p).pipe(catchError(() => of({ items: [] as any[] })));
    forkJoin({
      nodes: safe('/api/v1/nodes'),
      pods: safe('/api/v1/pods'),
      vmis: safe('/apis/kubevirt.io/v1/virtualmachineinstances'),
    }).subscribe(r => {
      this.nodes.set(r.nodes.items || []); this.pods.set(r.pods.items || []); this.vmis.set(r.vmis.items || []);
      this.loaded.set(true);
    });
  }

  barColor(pct: number): string {
    if (pct >= 90) return 'var(--clr-color-danger-700, #e74c3c)';
    if (pct >= 70) return 'var(--clr-color-warning-700, #f1c40f)';
    return 'var(--clr-color-success-600, #2ecc71)';
  }

  readonly nodeView = computed(() => this.nodes().map(n => {
    const name = n.metadata?.name;
    const podsOn = this.pods().filter(p => p.spec?.nodeName === name);
    const reqCpuM = podsOn.reduce((s, p) => s + (p.spec?.containers || []).reduce((c: number, x: any) => c + cpuM(x.resources?.requests?.cpu), 0), 0);
    const reqMemB = podsOn.reduce((s, p) => s + (p.spec?.containers || []).reduce((c: number, x: any) => c + memB(x.resources?.requests?.memory), 0), 0);
    const allocCpuM = cpuM(n.status?.allocatable?.cpu ?? n.status?.capacity?.cpu);
    const allocMemB = memB(n.status?.allocatable?.memory ?? n.status?.capacity?.memory);
    return {
      name, ready: isReady(n), roles: nodeRoles(n), kvm: kvm(n),
      podCount: podsOn.length,
      vms: this.vmis().filter(v => v.status?.nodeName === name).map(v => v.metadata?.name),
      cpuReq: (reqCpuM / 1000).toFixed(1), cpuCap: (allocCpuM / 1000).toFixed(0),
      cpuPct: allocCpuM ? Math.round((reqCpuM / allocCpuM) * 100) : 0,
      memReq: (reqMemB / 1024 ** 3).toFixed(1), memCap: (allocMemB / 1024 ** 3).toFixed(0),
      memPct: allocMemB ? Math.round((reqMemB / allocMemB) * 100) : 0,
    };
  }));
}
