import { CommonModule } from '@angular/common';
import { Component, EventEmitter, OnInit, Output, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { dump } from 'js-yaml';
import { K8sService } from '../core/k8s.service';
import { CodeEditorComponent } from '../shared/code-editor.component';
import { OsLogoComponent, osIdFromImage } from '../shared/os-logo.component';

// InstanceType 시리즈(이름 접두사) → 라벨. (OpenShift Virtualization 시리즈 대응)
const SERIES: Record<string, string> = {
  u1: 'General Purpose · U', o1: 'Overcommitted · O', cx1: 'Compute Exclusive · CX',
  m1: 'Memory Intensive · M', n1: 'Network · N', rt1: 'Realtime · RT', gn1: 'GPU · GN',
};
const SERIES_ICON: Record<string, string> = {
  u1: 'M4 13h6V4H4v9zm0 7h6v-5H4v5zm8 0h6V11h-6v9zm0-16v5h6V4h-6z',     // grid
  o1: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',        // layers
  cx1: 'M9 3H5a2 2 0 00-2 2v4m6-6h6m-6 0v18m6-18h4a2 2 0 012 2v4M3 9v6m18-6v6M3 15v4a2 2 0 002 2h4m6 0h4a2 2 0 002-2v-4', // chip
  m1: 'M6 4h12v4H6zM6 10h12v4H6zM6 16h12v4H6z',                          // memory
  n1: 'M5 12h14M5 12a2 2 0 100-4 2 2 0 000 4zm0 0a2 2 0 110 4 2 2 0 010-4zm14 0a2 2 0 100-4 2 2 0 000 4z', // network
  rt1: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',                    // clock
  gn1: 'M4 6h16v12H4zM8 18v2m8-2v2',                                     // gpu
};

interface ITItem { name: string; cpu: number; mem: string; series: string; }
interface BootVol { name: string; kind: string; os: string; sc: string; size: string; raw: any; }

/**
 * VirtualMachine 생성 — InstanceTypes 플로우(OpenShift Virtualization 등가 UX, 우리 Angular/Clarity 구현).
 * 1) 부팅할 볼륨 선택(DataVolume/PVC 표) 2) InstanceType 선택(클러스터 instancetype을 시리즈별 카드+사이즈 드롭다운)
 * 3) 세부 정보. 생성 시 VM이 spec.instancetype 참조 + dataVolumeTemplate(부팅 볼륨 클론). 실 CRD 쿼리.
 */
@Component({
  selector: 'app-vm-create-instancetype',
  standalone: true,
  imports: [CommonModule, ClarityModule, CodeEditorComponent, OsLogoComponent],
  styles: [`
    .it-step { display: flex; align-items: center; gap: .5rem; margin: 1.25rem 0 .5rem; }
    .it-num { width: 22px; height: 22px; border-radius: 50%; background: var(--os-brand-600,#2563eb); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:.8rem; font-weight:700; }
    .it-step h3 { margin: 0; font-size: 1rem; }
    .it-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: .75rem; margin: .5rem 0; }
    .it-card { border: 1px solid var(--clr-color-neutral-300,#cdcdcd); border-radius: 8px; padding: .9rem; }
    .it-card.sel { border-color: var(--os-brand-600,#2563eb); box-shadow: 0 0 0 2px var(--os-brand-500,#4c6fff); }
    .it-card .ic { color: var(--clr-color-neutral-700,#565656); }
    .it-card .nm { font-weight: 700; font-size: .92rem; margin: .35rem 0; }
    .it-card select { width: 100%; }
    .it-grid { display: grid; grid-template-columns: 150px 1fr; gap: .6rem 1rem; align-items: center; max-width: 620px; }
  `],
  template: `
    <div *ngIf="msg()" class="alert" [ngClass]="ok() ? 'alert-success' : 'alert-danger'" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ msg() }}</span></div></div>
    </div>

    <!-- ── 1. 부팅할 볼륨 선택 ── -->
    <div class="it-step"><span class="it-num">1</span><h3>부팅할 볼륨 선택</h3></div>
    <clr-datagrid [clrDgLoading]="loading()">
      <clr-dg-column>선택</clr-dg-column><clr-dg-column>볼륨 이름</clr-dg-column><clr-dg-column>운영 체제</clr-dg-column><clr-dg-column>스토리지 클래스</clr-dg-column><clr-dg-column>크기</clr-dg-column>
      <clr-dg-row *clrDgItems="let v of bootVols()">
        <clr-dg-cell><input type="radio" name="bootvol" [checked]="selVol()?.name === v.name" (change)="selVol.set(v)" /></clr-dg-cell>
        <clr-dg-cell><app-os-logo [os]="v.os" [size]="20"></app-os-logo> {{ v.name }} <span class="label">{{ v.kind }}</span></clr-dg-cell>
        <clr-dg-cell>{{ v.os }}</clr-dg-cell><clr-dg-cell>{{ v.sc }}</clr-dg-cell><clr-dg-cell>{{ v.size }}</clr-dg-cell>
      </clr-dg-row>
      <clr-dg-placeholder>부팅 가능한 볼륨이 없습니다 — DataVolume/PVC를 추가하거나(예: ISO 업로드) 카탈로그(containerDisk)를 사용하세요.</clr-dg-placeholder>
    </clr-datagrid>

    <!-- ── 2. InstanceType 선택 ── -->
    <div class="it-step"><span class="it-num">2</span><h3>InstanceType 선택 <span class="os-muted">({{ instancetypes().length }}개 · {{ seriesList().length }} 시리즈)</span></h3></div>
    <div class="it-cards">
      <div class="it-card" *ngFor="let s of seriesList()" [class.sel]="selSeries() === s.key">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" class="ic"><path [attr.d]="icon(s.key)"/></svg>
        <div class="nm">{{ s.label }}</div>
        <select (change)="pickIt(s.key, $any($event.target).value)">
          <option value="">사이즈 선택…</option>
          <option *ngFor="let it of s.items" [value]="it.name" [selected]="selIt()===it.name">{{ it.name }} · {{ it.cpu }} vCPU · {{ it.mem }}</option>
        </select>
      </div>
      <div *ngIf="!seriesList().length" class="os-muted">InstanceType 없음.</div>
    </div>

    <!-- ── 3. VirtualMachine 세부 정보 ── -->
    <div class="it-step"><span class="it-num">3</span><h3>VirtualMachine 세부 정보</h3></div>
    <div class="it-grid">
      <label>이름</label><input type="text" class="os-search" [value]="name()" (input)="name.set($any($event.target).value)" placeholder="my-vm" />
      <label>InstanceType</label><span>{{ selIt() || '—' }} <span class="os-muted" *ngIf="selItObj() as o">({{ o.cpu }} vCPU · {{ o.mem }})</span></span>
      <label>부팅 볼륨</label><span>{{ selVol()?.name || '—' }}</span>
      <label>디스크 크기 (Gi)</label><input type="number" min="10" class="os-num" [value]="disk()" (input)="disk.set(+$any($event.target).value)" />
      <label>스토리지 클래스</label><input type="text" class="os-search" [value]="sc()" (input)="sc.set($any($event.target).value)" />
      <label>노드 *</label>
      <select class="os-search" style="max-width: 360px" (change)="selNode.set($any($event.target).value)">
        <option value="">— 배치할 노드 선택 (필수) —</option>
        <option *ngFor="let n of nodes()" [value]="n" [selected]="selNode() === n">{{ n }}</option>
      </select>
      <label>생성 후 시작</label><span><input type="checkbox" [checked]="start()" (change)="start.set($any($event.target).checked)" /></span>
    </div>

    <div class="os-actions" style="margin-top: 1rem">
      <button class="btn btn-sm btn-primary" [disabled]="busy() || !canCreate()" (click)="submit()">VirtualMachine 생성</button>
      <button class="btn btn-sm btn-outline" (click)="showYaml.set(!showYaml())">{{ showYaml() ? 'YAML 숨기기' : 'YAML 및 CLI 보기' }}</button>
      <button class="btn btn-sm btn-link" [disabled]="busy()" (click)="cancel.emit()">취소</button>
    </div>
    <div *ngIf="showYaml()" style="margin-top: .5rem; max-width: 760px">
      <app-code-editor [value]="yamlPreview()" language="yaml" [readOnly]="true" height="360px"></app-code-editor>
    </div>
  `,
})
export class VmCreateInstancetypeComponent implements OnInit {
  @Output() created = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  private k8s = inject(K8sService);
  readonly loading = signal(true);
  readonly instancetypes = signal<ITItem[]>([]);
  readonly bootVols = signal<BootVol[]>([]);
  readonly selVol = signal<BootVol | null>(null);
  readonly selSeries = signal('');
  readonly selIt = signal('');
  readonly name = signal('');
  readonly disk = signal(40);
  readonly sc = signal('standard');
  readonly nodes = signal<string[]>([]);
  readonly selNode = signal('');
  readonly start = signal(true);
  readonly showYaml = signal(false);
  readonly busy = signal(false);
  readonly msg = signal<string | null>(null);
  readonly ok = signal(false);

  ngOnInit(): void {
    const safe = (p: string) => this.k8s.list(p).pipe(catchError(() => of({ items: [] as any[] })));
    forkJoin({
      its: safe('/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterinstancetypes'),
      dvs: safe('/apis/cdi.kubevirt.io/v1beta1/namespaces/default/datavolumes'),
      pvcs: safe('/api/v1/namespaces/default/persistentvolumeclaims'),
      nodes: safe('/api/v1/nodes'),
    }).subscribe(r => {
      this.nodes.set((r.nodes.items || []).map((n: any) => n.metadata?.name).filter(Boolean));
      this.instancetypes.set((r.its.items || []).map((i: any) => ({
        name: i.metadata?.name, cpu: i.spec?.cpu?.guest ?? 0, mem: i.spec?.memory?.guest ?? '—', series: (i.metadata?.name || '').split('.')[0],
      })).sort((a: ITItem, b: ITItem) => a.name.localeCompare(b.name)));
      const vols: BootVol[] = [];
      for (const d of r.dvs.items || []) vols.push({ name: d.metadata?.name, kind: 'DataVolume', os: osIdFromImage(d.metadata?.name), sc: d.spec?.storage?.storageClassName || d.spec?.pvc?.storageClassName || '—', size: d.spec?.storage?.resources?.requests?.storage || d.spec?.pvc?.resources?.requests?.storage || '—', raw: d });
      for (const p of r.pvcs.items || []) if (!vols.find(v => v.name === p.metadata?.name)) vols.push({ name: p.metadata?.name, kind: 'PVC', os: osIdFromImage(p.metadata?.name), sc: p.spec?.storageClassName || '—', size: p.spec?.resources?.requests?.storage || '—', raw: p });
      this.bootVols.set(vols);
      this.loading.set(false);
    });
  }

  readonly seriesList = computed(() => {
    const m: Record<string, ITItem[]> = {};
    for (const it of this.instancetypes()) (m[it.series] = m[it.series] || []).push(it);
    return Object.keys(m).sort().map(key => ({ key, label: SERIES[key] || key, items: m[key] }));
  });
  icon(s: string) { return SERIES_ICON[s] || SERIES_ICON['u1']; }
  pickIt(series: string, name: string) { this.selSeries.set(series); this.selIt.set(name); }
  selItObj() { return this.instancetypes().find(i => i.name === this.selIt()); }
  canCreate() { return !!this.name().trim() && !!this.selIt() && !!this.selVol() && !!this.selNode(); }

  private buildVm(): any {
    const nm = this.name().trim() || 'my-vm';
    const vol = this.selVol();
    return {
      apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine',
      metadata: { name: nm, namespace: 'default', labels: { app: nm } },
      spec: {
        running: this.start(),
        instancetype: { kind: 'VirtualMachineClusterInstancetype', name: this.selIt() },
        dataVolumeTemplates: [{
          metadata: { name: `${nm}-disk` },
          spec: {
            storage: { resources: { requests: { storage: `${this.disk()}Gi` } }, storageClassName: this.sc() },
            source: vol ? { pvc: { namespace: 'default', name: vol.name } } : { blank: {} },
          },
        }],
        template: {
          metadata: { labels: { 'kubevirt.io/domain': nm } },
          spec: {
            nodeSelector: { 'kubernetes.io/hostname': this.selNode() },
            domain: { devices: { disks: [{ name: 'rootdisk', disk: { bus: 'virtio' } }], interfaces: [{ name: 'default', masquerade: {} }] } },
            networks: [{ name: 'default', pod: {} }],
            volumes: [{ name: 'rootdisk', dataVolume: { name: `${nm}-disk` } }],
          },
        },
      },
    };
  }
  yamlPreview(): string { try { return dump(this.buildVm()); } catch { return ''; } }

  submit(): void {
    const nm = this.name().trim();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(nm)) { this.ok.set(false); this.msg.set('이름은 소문자/숫자/하이픈만.'); return; }
    this.busy.set(true); this.msg.set(null);
    this.k8s.post('/apis/kubevirt.io/v1/namespaces/default/virtualmachines', this.buildVm()).subscribe({
      next: () => { this.busy.set(false); this.ok.set(true); this.msg.set('생성됨.'); this.created.emit(); },
      error: e => { this.busy.set(false); this.ok.set(false); this.msg.set(e?.error?.message || e?.error?.error || e?.message || String(e)); },
    });
  }
}
