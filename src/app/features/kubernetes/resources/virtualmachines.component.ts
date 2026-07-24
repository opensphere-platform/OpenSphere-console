import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';
import { VmCreateComponent } from './vm-create.component';
import { VmDetailComponent } from './vm-detail.component';
import { osIdFromImage } from '../shared/os-logo.component';
import { K8sService } from '../core/k8s.service';

const vmStatusColor = (s: string): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const v = s || '';
  if (v === 'Running') return 'success';
  if (v === 'Stopped' || v === 'Paused') return 'warning';
  if (v === 'Provisioning' || v === 'Starting' || v === 'Stopping' || v === 'Migrating' || v === 'WaitingForVolumeBinding') return 'info';
  if (v.startsWith('Error') || v === 'CrashLoopBackOff' || v === 'Unschedulable') return 'danger';
  return 'unknown';
};
function memBytes(v?: string): number {
  if (!v) return 0;
  const u: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9 };
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(String(v)); if (!m) return 0;
  return m[2] && u[m[2]] ? parseFloat(m[1]) * u[m[2]] : parseFloat(m[1]);
}
function vmVcpu(v: any): number { const c = v.spec?.template?.spec?.domain?.cpu; return c ? (c.sockets || 1) * (c.cores || 1) * (c.threads || 1) : 0; }
function vmMemBytes(v: any): number { const d = v.spec?.template?.spec?.domain; return memBytes(d?.memory?.guest || d?.resources?.requests?.memory); }

/**
 * KubeVirt VirtualMachine — OpenShift Virtualization 방식:
 * 목록(요약 밴드 + 테이블) ↔ 이름 클릭 시 **전체 페이지 상세**(드로어 아님, 목록 자리를 상세가 대체).
 * 상세는 URL ?...&name=<vm>에 반영되어 공유·뒤로가기 가능. ⋮ 행 액션(시작/정지/재시작/삭제).
 */
@Component({
  selector: 'app-res-virtualmachines',
  standalone: true,
  imports: [CommonModule, ClarityModule, ResourceListComponent, VmCreateComponent, VmDetailComponent],
  styles: [`
    .vm-summary { display: grid; grid-template-columns: 1fr 1.4fr 1.1fr; gap: 1rem; margin: .25rem 0 1rem; }
    .vm-sum-row { display: flex; gap: 1.5rem; flex-wrap: wrap; padding: .8rem 1rem; align-items: center; }
    .vm-sum-row .os-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: .35rem; }
    .vm-sum-row strong { font-size: 1.05rem; }
    .vm-crumb { display: flex; align-items: center; gap: .4rem; margin: .25rem 0 .75rem; font-size: .9rem; }
    @media (max-width: 1000px) { .vm-summary { grid-template-columns: 1fr; } }
  `],
  template: `
    <app-vm-create *ngIf="creating()" (created)="creating.set(false); reload()" (cancel)="creating.set(false)"></app-vm-create>

    <!-- ===== 전체 페이지 VM 상세 (OpenShift 방식) ===== -->
    <div *ngIf="!creating() && detailVm() as vm">
      <div class="vm-crumb">
        <a class="os-link" role="button" tabindex="0" (click)="closeDetail()" (keydown.enter)="closeDetail()">← Virtual Machines</a>
        <span class="os-muted">/ {{ vm.metadata?.name }}</span>
      </div>
      <app-vm-detail [item]="vm" (back)="closeDetail()" (changed)="reload()"></app-vm-detail>
    </div>

    <!-- ===== 목록 + 요약 밴드 ===== -->
    <div *ngIf="!creating() && !detailVm()">
      <div class="vm-summary">
        <div class="card">
          <div class="card-header">프로젝트</div>
          <div class="card-block vm-sum-row">
            <span *ngFor="let ns of namespaces()" class="label label-info">{{ ns }}</span>
            <span *ngIf="!namespaces().length" class="os-muted">—</span>
          </div>
        </div>
        <div class="card">
          <div class="card-header">가상 머신 ({{ vms().length }})</div>
          <div class="card-block vm-sum-row">
            <span><span class="os-dot" style="background:#e74c3c"></span>오류 <strong>{{ bucketCount('Error') }}</strong></span>
            <span><span class="os-dot" style="background:#2ecc71"></span>실행 중 <strong>{{ bucketCount('Running') }}</strong></span>
            <span><span class="os-dot" style="background:#f1c40f"></span>Stopped <strong>{{ bucketCount('Stopped') }}</strong></span>
            <span><span class="os-dot" style="background:#95a5a6"></span>기타 <strong>{{ bucketCount('Other') }}</strong></span>
          </div>
        </div>
        <div class="card">
          <div class="card-header">사용량 (실행 중)</div>
          <div class="card-block vm-sum-row">
            <span>CPU <strong>{{ totalVcpu() }}</strong> vCPU</span>
            <span>메모리 <strong>{{ totalMemGb() }}</strong> GiB</span>
          </div>
        </div>
      </div>

      <app-resource-list title="Virtual Machines" path="/apis/kubevirt.io/v1/virtualmachines" [namespaced]="true"
        kind="VirtualMachine" [vm]="true" [pageDetail]="true" (rowOpen)="openDetail($event)"
        createLabel="Create VirtualMachine" (create)="creating.set(true)"
        [columns]="cols" [rowActions]="vmActions"></app-resource-list>
    </div>
  `,
})
export class VirtualMachinesComponent implements OnInit, OnDestroy {
  private k8s = inject(K8sService);
  @ViewChild(ResourceListComponent) list?: ResourceListComponent;
  readonly creating = signal(false);
  readonly vms = signal<any[]>([]);
  readonly detailVm = signal<any | null>(null);
  private pendingName = '';

  ngOnInit(): void {
    try { this.pendingName = new URLSearchParams(location.search).get('name') || ''; } catch { /* noop */ }
    this.reload();
  }
  ngOnDestroy(): void { this.clearNameParam(); }

  reload(): void {
    this.k8s.list('/apis/kubevirt.io/v1/virtualmachines').pipe(catchError(() => of({ items: [] as any[] })))
      .subscribe((r: any) => {
        const items = r.items || [];
        this.vms.set(items);
        // 공유 URL(&name=)로 진입 시 해당 VM 상세를 전체 페이지로 연다.
        if (this.pendingName) {
          const vm = items.find((v: any) => v.metadata?.name === this.pendingName);
          this.pendingName = '';
          if (vm) this.openDetail(vm, false);
        }
      });
  }

  // ── 전체 페이지 상세 (드로어 아님) ──
  openDetail(vm: any, sync = true): void { this.detailVm.set(vm); if (sync) this.setNameParam(vm?.metadata?.name); }
  closeDetail(): void { this.detailVm.set(null); this.clearNameParam(); this.reload(); }
  private setNameParam(name: string): void { try { const p = new URLSearchParams(location.search); p.set('name', name); history.replaceState(history.state, '', location.pathname + '?' + p.toString()); } catch { /* noop */ } }
  private clearNameParam(): void { try { const p = new URLSearchParams(location.search); if (p.has('name')) { p.delete('name'); history.replaceState(history.state, '', location.pathname + (p.toString() ? '?' + p.toString() : '')); } } catch { /* noop */ } }

  private bucket(v: any): string {
    const s = String(v.status?.printableStatus || '');
    if (s === 'Running') return 'Running';
    if (s === 'Stopped' || s === 'Paused') return 'Stopped';
    if (s.startsWith('Error') || s === 'CrashLoopBackOff' || s === 'Unschedulable') return 'Error';
    return 'Other';
  }
  bucketCount(b: string): number { return this.vms().filter(v => this.bucket(v) === b).length; }
  totalVcpu(): number { return this.vms().filter(v => this.bucket(v) === 'Running').reduce((s, v) => s + vmVcpu(v), 0); }
  totalMemGb(): string { return (this.vms().filter(v => this.bucket(v) === 'Running').reduce((s, v) => s + vmMemBytes(v), 0) / 1024 ** 3).toFixed(1); }
  namespaces(): string[] { return [...new Set(this.vms().map(v => v.metadata?.namespace).filter(Boolean))]; }

  // ── 행 액션(⋮): 시작/정지/재시작/삭제 ──
  private isRunning(v: any): boolean {
    const s = v.spec || {};
    if (typeof s.running === 'boolean') return s.running;
    if (s.runStrategy) return s.runStrategy !== 'Halted' && s.runStrategy !== 'Manual';
    return v.status?.printableStatus === 'Running';
  }
  private runPatch(v: any, on: boolean): any {
    const s = v.spec || {};
    return (s.runStrategy && typeof s.running !== 'boolean') ? { spec: { runStrategy: on ? 'Always' : 'Halted' } } : { spec: { running: on } };
  }
  vmActions = (vm: any): Array<{ label: string; danger?: boolean; run: () => void }> => {
    const ns = vm.metadata?.namespace, name = vm.metadata?.name;
    const path = `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines/${name}`;
    const sub = (s: string) => `/apis/subresources.kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances/${name}/${s}`;
    const after = () => { setTimeout(() => { this.list?.load(); this.reload(); }, 500); };
    const running = this.isRunning(vm);
    const acts: Array<{ label: string; danger?: boolean; run: () => void }> = [];
    if (!running) acts.push({ label: '시작', run: () => this.k8s.patchMerge(path, this.runPatch(vm, true)).subscribe(after) });
    if (running) acts.push({ label: '정지', run: () => this.k8s.patchMerge(path, this.runPatch(vm, false)).subscribe(after) });
    if (running) acts.push({ label: '재시작', run: () => this.k8s.post(sub('restart'), {}).subscribe(after) });
    acts.push({ label: '삭제', danger: true, run: () => this.k8s.remove(path).subscribe(after) });
    return acts;
  };

  cols: ColumnDef[] = [
    { id: 'os', label: '', kind: 'logo', get: o => osIdFromImage(o.spec?.template?.metadata?.annotations?.['vm.kubevirt.io/os'] || (o.spec?.template?.spec?.volumes || []).map((v: any) => v.containerDisk?.image).find(Boolean)) },
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status?.printableStatus || 'Unknown', statusOf: o => vmStatusColor(o.status?.printableStatus) },
    { id: 'conditions', label: 'Conditions', kind: 'tags', get: o => (o.status?.conditions || []).filter((c: any) => c.status === 'True').map((c: any) => c.type) },
    { id: 'node', label: 'Node', get: o => o.status?.nodeName || '—', facet: true },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
