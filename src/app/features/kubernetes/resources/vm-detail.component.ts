import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { dump } from 'js-yaml';
import { K8sService } from '../core/k8s.service';
import { CodeEditorComponent } from '../shared/code-editor.component';
import { OsLogoComponent, osIdFromImage } from '../shared/os-logo.component';
import { VmConsoleComponent } from './vm-console.component';
import { VmVncComponent } from './vm-vnc.component';

const ICON: Record<string, string> = {
  play: 'M8 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  refresh: 'M17.65 6.35A8 8 0 1019 13h-2a6 6 0 11-1.76-4.24L13 11h7V4l-2.35 2.35z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  trash: 'M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
};
const vmStatusClass = (s: string): string => {
  const v = s || '';
  if (v === 'Running') return 'label-success';
  if (v === 'Stopped' || v === 'Paused') return 'label-warning';
  if (v.startsWith('Error') || v === 'CrashLoopBackOff' || v === 'Unschedulable') return 'label-danger';
  return 'label-info';
};
/** CPU 수량 → cores. */
function cpuCores(v?: string): number {
  if (!v) return 0;
  if (v.endsWith('n')) return parseInt(v, 10) / 1e9;
  if (v.endsWith('u')) return parseInt(v, 10) / 1e6;
  if (v.endsWith('m')) return parseInt(v, 10) / 1e3;
  return parseFloat(v);
}
/** 메모리 → bytes. */
function memBytes(v?: string): number {
  if (!v) return 0;
  const u: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9 };
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(String(v));
  if (!m) return 0;
  return m[2] && u[m[2]] ? parseFloat(m[1]) * u[m[2]] : parseFloat(m[1]);
}

/**
 * KubeVirt VM 상세(OpenShift Virtualization VM 상세 등가) — 탭형: 개요·메트릭·YAML·설정·이벤트·콘솔·진단.
 * VM+VMI+virt-launcher 파드+서비스+메트릭을 조인. 콘솔 탭=VNC/Serial. 그룹 임퍼소네이션 write로 라이프사이클.
 */
@Component({
  selector: 'app-vm-detail',
  standalone: true,
  imports: [CommonModule, ClarityModule, CodeEditorComponent, OsLogoComponent, VmConsoleComponent, VmVncComponent],
  styles: [`
    .vm-title-h { display: inline-flex; align-items: center; gap: .4rem; }
    .vm-tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--clr-color-neutral-300, #ccc); margin: .25rem 0 1rem; flex-wrap: wrap; }
    .vm-tab { padding: .4rem .9rem; cursor: pointer; border: none; background: none; font-size: .9rem; color: var(--clr-color-neutral-700, #565656); border-bottom: 2px solid transparent; }
    .vm-tab.active { color: var(--os-brand-600, #2563eb); border-bottom-color: var(--os-brand-600, #2563eb); font-weight: 600; }
    .vm-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
    .vm-kv { display: grid; grid-template-columns: 150px 1fr; gap: .35rem .75rem; padding: .25rem 0; }
    .vm-kv dt { color: var(--clr-color-neutral-600, #666); }
    .vm-kv dd { margin: 0; word-break: break-all; }
    .vm-metric { display: flex; gap: 1.5rem; flex-wrap: wrap; padding: 1rem; }
    .vm-metric .m { min-width: 140px; }
    .vm-metric .mv { font-size: 1.6rem; font-weight: 200; }
    @media (max-width: 900px) { .vm-grid2 { grid-template-columns: 1fr; } }
  `],
  template: `
    <div class="os-title-row">
      <h2 class="os-h2 vm-title-h">
        <app-os-logo [os]="osId()" [size]="26"></app-os-logo>
        <span class="label label-info">VM</span> {{ name }}
        <span class="label" [ngClass]="statusClass()">{{ status() }}</span>
      </h2>
      <span class="os-actions os-ml-auto">
        <button class="os-iconbtn" *ngIf="!running()" title="Start" [disabled]="busy()" (click)="setRunning(true)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.play"/></svg></button>
        <button class="os-iconbtn" *ngIf="running()" title="Stop" [disabled]="busy()" (click)="setRunning(false)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.stop"/></svg></button>
        <button class="os-iconbtn" *ngIf="running()" title="Restart" [disabled]="busy()" (click)="restart()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.refresh"/></svg></button>
        <button class="os-iconbtn" *ngIf="running() && !paused()" title="Pause" [disabled]="busy()" (click)="pause(true)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.pause"/></svg></button>
        <button class="os-iconbtn" *ngIf="paused()" title="Unpause" [disabled]="busy()" (click)="pause(false)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.play"/></svg></button>
        <button class="os-iconbtn os-iconbtn-danger" title="Delete" [disabled]="busy()" (click)="deleteOpen.set(true)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.trash"/></svg></button>
      </span>
    </div>

    <div *ngIf="msg()" class="alert" [ngClass]="ok() ? 'alert-success' : 'alert-danger'" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ msg() }}</span></div></div>
    </div>

    <div class="vm-tabs">
      <button class="vm-tab" [class.active]="tab() === 'overview'" (click)="tab.set('overview')">개요</button>
      <button class="vm-tab" [class.active]="tab() === 'metrics'" (click)="tab.set('metrics')">메트릭</button>
      <button class="vm-tab" [class.active]="tab() === 'yaml'" (click)="tab.set('yaml')">YAML</button>
      <button class="vm-tab" [class.active]="tab() === 'settings'" (click)="tab.set('settings')">설정</button>
      <button class="vm-tab" [class.active]="tab() === 'events'" (click)="tab.set('events')">이벤트</button>
      <button class="vm-tab" [class.active]="tab() === 'console'" (click)="tab.set('console')">콘솔</button>
      <button class="vm-tab" [class.active]="tab() === 'diagnostics'" (click)="tab.set('diagnostics')">진단</button>
    </div>

    <!-- ===== 개요 ===== -->
    <div *ngIf="tab() === 'overview'" class="vm-grid2">
      <div>
        <div class="card">
          <div class="card-header">세부 정보</div>
          <div class="card-block">
            <dl class="vm-kv">
              <dt>이름</dt><dd>{{ name }}</dd>
              <dt>상태</dt><dd><span class="label" [ngClass]="statusClass()">{{ status() }}</span></dd>
              <dt>작성</dt><dd>{{ vm()?.metadata?.creationTimestamp | date:'medium' }}</dd>
              <dt>운영체제</dt><dd>{{ os() }}</dd>
              <dt>CPU | 메모리</dt><dd>{{ cpu() }} CPU | {{ memory() }} 메모리</dd>
              <dt>템플릿</dt><dd>{{ template() }}</dd>
              <dt>호스트이름</dt><dd>{{ hostname() }}</dd>
            </dl>
          </div>
        </div>
        <div class="card">
          <div class="card-header">네트워크 ({{ networks().length }})</div>
          <clr-datagrid>
            <clr-dg-column>이름</clr-dg-column><clr-dg-column>IP 주소</clr-dg-column>
            <clr-dg-row *clrDgItems="let n of networks()"><clr-dg-cell>{{ n.name }}</clr-dg-cell><clr-dg-cell>{{ n.ip || '—' }}</clr-dg-cell></clr-dg-row>
            <clr-dg-placeholder>네트워크 없음.</clr-dg-placeholder>
          </clr-datagrid>
          <div class="card-block os-muted">내부 FQDN: {{ fqdn() || '—' }}</div>
        </div>
        <div class="card">
          <div class="card-header">콘솔</div>
          <div class="card-block">
            <button class="btn btn-sm btn-outline" [disabled]="!vmi()" (click)="tab.set('console')">콘솔 열기 (VNC / Serial)</button>
            <span class="os-muted" *ngIf="!vmi()"> — VM이 실행 중이 아닙니다.</span>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-header">일반</div>
          <div class="card-block">
            <dl class="vm-kv">
              <dt>네임스페이스</dt><dd>{{ namespace }}</dd>
              <dt>VirtualMachineInstance</dt><dd>{{ vmi() ? name : '—' }}</dd>
              <dt>Pod</dt><dd>{{ pod()?.metadata?.name || '—' }}</dd>
              <dt>노드</dt><dd>{{ vmi()?.status?.nodeName || '—' }}</dd>
              <dt>소유자</dt><dd>{{ owner() }}</dd>
            </dl>
          </div>
        </div>
        <div class="card">
          <div class="card-header">스토리지 ({{ disks().length }})</div>
          <clr-datagrid>
            <clr-dg-column>이름</clr-dg-column><clr-dg-column>드라이브</clr-dg-column><clr-dg-column>인터페이스</clr-dg-column><clr-dg-column>소스</clr-dg-column>
            <clr-dg-row *clrDgItems="let d of disks()"><clr-dg-cell>{{ d.name }}</clr-dg-cell><clr-dg-cell>{{ d.drive }}</clr-dg-cell><clr-dg-cell>{{ d.bus }}</clr-dg-cell><clr-dg-cell>{{ d.source }}</clr-dg-cell></clr-dg-row>
            <clr-dg-placeholder>디스크 없음.</clr-dg-placeholder>
          </clr-datagrid>
        </div>
        <div class="card">
          <div class="card-header">서비스 ({{ services().length }})</div>
          <clr-datagrid>
            <clr-dg-column>이름</clr-dg-column><clr-dg-column>타입</clr-dg-column><clr-dg-column>Cluster IP</clr-dg-column>
            <clr-dg-row *clrDgItems="let s of services()"><clr-dg-cell>{{ s.metadata?.name }}</clr-dg-cell><clr-dg-cell>{{ s.spec?.type || 'ClusterIP' }}</clr-dg-cell><clr-dg-cell>{{ s.spec?.clusterIP }}</clr-dg-cell></clr-dg-row>
            <clr-dg-placeholder>서비스 없음.</clr-dg-placeholder>
          </clr-datagrid>
        </div>
      </div>
    </div>

    <!-- ===== 메트릭 ===== -->
    <div *ngIf="tab() === 'metrics'" class="card">
      <div class="card-header">사용량 (virt-launcher 파드)</div>
      <div class="vm-metric" *ngIf="vmi(); else metNoRun">
        <div class="m"><div class="os-muted">CPU 사용</div><div class="mv">{{ cpuUsage() }}</div><div class="os-muted">cores</div></div>
        <div class="m"><div class="os-muted">메모리 사용</div><div class="mv">{{ memUsage() }}</div><div class="os-muted">MiB</div></div>
        <div class="m"><div class="os-muted">CPU 요청</div><div class="mv">{{ cpu() }}</div><div class="os-muted">vCPU</div></div>
        <div class="m"><div class="os-muted">메모리 요청</div><div class="mv">{{ memory() }}</div><div class="os-muted">guest</div></div>
      </div>
      <ng-template #metNoRun><div class="card-block os-muted">VirtualMachine이 실행되고 있지 않음 — 메트릭은 실행 시 표시됩니다.</div></ng-template>
      <div class="card-block os-muted" *ngIf="vmi() && !hasMetrics()">라이브 사용량 데이터 없음(metrics-server 미설치 시 요청량만 표시).</div>
    </div>

    <!-- ===== YAML ===== -->
    <div *ngIf="tab() === 'yaml'" class="os-card">
      <app-code-editor [value]="yaml()" language="yaml" [readOnly]="true" height="560px"></app-code-editor>
    </div>

    <!-- ===== 설정 ===== -->
    <div *ngIf="tab() === 'settings'" class="vm-grid2">
      <div class="card">
        <div class="card-header">실행 / 스케줄링</div>
        <div class="card-block">
          <dl class="vm-kv">
            <dt>Run Strategy</dt><dd>{{ runStrategy() }}</dd>
            <dt>게스트 에이전트</dt><dd>{{ guestAgent() }}</dd>
            <dt>노드 셀렉터</dt><dd>{{ nodeSelector() }}</dd>
            <dt>QOS</dt><dd>{{ vmi()?.status?.qosClass || '—' }}</dd>
          </dl>
        </div>
      </div>
      <div class="card">
        <div class="card-header">레이블 / 어노테이션</div>
        <div class="card-block">
          <div><strong>레이블</strong></div>
          <div><span class="label" *ngFor="let l of labels()">{{ l }}</span><span *ngIf="!labels().length" class="os-muted">—</span></div>
          <div class="os-sub-mb"></div>
          <div><strong>어노테이션</strong></div>
          <div><span class="label" *ngFor="let a of annotations()">{{ a }}</span><span *ngIf="!annotations().length" class="os-muted">—</span></div>
        </div>
      </div>
    </div>

    <!-- ===== 이벤트 ===== -->
    <div *ngIf="tab() === 'events'" class="card">
      <clr-datagrid [clrDgLoading]="loading()">
        <clr-dg-column>Type</clr-dg-column><clr-dg-column>Reason</clr-dg-column><clr-dg-column>Message</clr-dg-column><clr-dg-column>Age</clr-dg-column>
        <clr-dg-row *clrDgItems="let e of events()">
          <clr-dg-cell><span class="label" [ngClass]="e.type === 'Warning' ? 'label-warning' : 'label-info'">{{ e.type }}</span></clr-dg-cell>
          <clr-dg-cell>{{ e.reason }}</clr-dg-cell><clr-dg-cell>{{ e.message }}</clr-dg-cell>
          <clr-dg-cell>{{ age(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp) }}</clr-dg-cell>
        </clr-dg-row>
        <clr-dg-placeholder>이벤트 없음.</clr-dg-placeholder>
      </clr-datagrid>
    </div>

    <!-- ===== 콘솔 (VNC / serial) ===== -->
    <div *ngIf="tab() === 'console'" class="os-card">
      <div class="card-block os-muted" *ngIf="!vmi()">이 VirtualMachine이 중단되었습니다. 콘솔에 액세스하려면 VirtualMachine을 시작하십시오.</div>
      <div *ngIf="vmi()" style="padding: .25rem 0">
        <div class="vm-tabs" style="margin-top: 0">
          <button class="vm-tab" [class.active]="consoleType() === 'vnc'" (click)="consoleType.set('vnc')">VNC 콘솔</button>
          <button class="vm-tab" [class.active]="consoleType() === 'serial'" (click)="consoleType.set('serial')">Serial 콘솔</button>
        </div>
        <app-vm-vnc *ngIf="consoleType() === 'vnc'" [ns]="namespace" [name]="name"></app-vm-vnc>
        <app-vm-console *ngIf="consoleType() === 'serial'" [ns]="namespace" [name]="name"></app-vm-console>
      </div>
    </div>

    <!-- ===== 진단 ===== -->
    <div *ngIf="tab() === 'diagnostics'">
      <div class="card">
        <div class="card-header">VMI 상태 — phase: {{ vmi()?.status?.phase || '—' }}</div>
        <clr-datagrid>
          <clr-dg-column>Condition</clr-dg-column><clr-dg-column>Status</clr-dg-column><clr-dg-column>Reason</clr-dg-column><clr-dg-column>Message</clr-dg-column>
          <clr-dg-row *clrDgItems="let c of conditions()">
            <clr-dg-cell>{{ c.type }}</clr-dg-cell>
            <clr-dg-cell><span class="label" [ngClass]="c.status === 'True' ? 'label-success' : 'label-warning'">{{ c.status }}</span></clr-dg-cell>
            <clr-dg-cell>{{ c.reason || '—' }}</clr-dg-cell><clr-dg-cell>{{ c.message || '—' }}</clr-dg-cell>
          </clr-dg-row>
          <clr-dg-placeholder>VMI 조건 없음(VM 중단 상태).</clr-dg-placeholder>
        </clr-datagrid>
      </div>
      <div class="card">
        <div class="card-header">virt-launcher 파드</div>
        <div class="card-block">
          <dl class="vm-kv">
            <dt>Pod</dt><dd>{{ pod()?.metadata?.name || '—' }}</dd>
            <dt>Phase</dt><dd>{{ pod()?.status?.phase || '—' }}</dd>
            <dt>Pod IP</dt><dd>{{ pod()?.status?.podIP || '—' }}</dd>
            <dt>노드</dt><dd>{{ pod()?.spec?.nodeName || '—' }}</dd>
            <dt>마이그레이션</dt><dd>{{ migration() }}</dd>
          </dl>
        </div>
      </div>
    </div>

    <!-- 삭제 확인 -->
    <clr-modal [(clrModalOpen)]="deleteOpenModel" [clrModalSize]="'sm'">
      <h3 class="modal-title">Delete VirtualMachine</h3>
      <div class="modal-body">Delete <strong>{{ name }}</strong> in {{ namespace }}?</div>
      <div class="modal-footer">
        <button class="btn btn-outline" (click)="deleteOpen.set(false)">Cancel</button>
        <button class="btn btn-danger" [disabled]="busy()" (click)="doDelete()">Delete</button>
      </div>
    </clr-modal>
  `,
})
export class VmDetailComponent implements OnInit {
  @Input({ required: true }) item!: any;
  @Input() listPath = '/apis/kubevirt.io/v1/virtualmachines';
  @Input() namespaced = true;
  @Output() back = new EventEmitter<void>();
  @Output() changed = new EventEmitter<void>();

  private k8s = inject(K8sService);
  readonly ic = ICON;
  readonly tab = signal<'overview' | 'metrics' | 'yaml' | 'settings' | 'events' | 'console' | 'diagnostics'>('overview');
  readonly consoleType = signal<'vnc' | 'serial'>('vnc');
  readonly vm = signal<any>(null);
  readonly vmi = signal<any>(null);
  readonly pod = signal<any>(null);
  readonly events = signal<any[]>([]);
  readonly servicesRaw = signal<any[]>([]);
  readonly podMetrics = signal<any[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly msg = signal<string | null>(null);
  readonly ok = signal(false);
  readonly deleteOpen = signal(false);
  get deleteOpenModel() { return this.deleteOpen(); }
  set deleteOpenModel(v: boolean) { this.deleteOpen.set(v); }

  get name() { return this.item?.metadata?.name; }
  get namespace() { return this.item?.metadata?.namespace; }
  private vmPath() { return `/apis/kubevirt.io/v1/namespaces/${this.namespace}/virtualmachines/${this.name}`; }
  private vmiPath() { return `/apis/kubevirt.io/v1/namespaces/${this.namespace}/virtualmachineinstances/${this.name}`; }
  private subPath(sub: string) { return `/apis/subresources.kubevirt.io/v1/namespaces/${this.namespace}/virtualmachineinstances/${this.name}/${sub}`; }

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    const safe = (p: string) => this.k8s.list(p).pipe(catchError(() => of({ items: [] as any[] })));
    forkJoin({
      vm: this.k8s.get(this.vmPath()).pipe(catchError(() => of(this.item))),
      vmi: this.k8s.get(this.vmiPath()).pipe(catchError(() => of(null))),
      pods: safe('/api/v1/namespaces/' + this.namespace + '/pods'),
      events: this.k8s.list(`/api/v1/namespaces/${this.namespace}/events`, { fieldSelector: `involvedObject.name=${this.name}` }).pipe(catchError(() => of({ items: [] as any[] }))),
      services: safe('/api/v1/namespaces/' + this.namespace + '/services'),
      metrics: safe('/apis/metrics.k8s.io/v1beta1/namespaces/' + this.namespace + '/pods'),
    }).subscribe({
      next: r => {
        this.vm.set(r.vm); this.vmi.set(r.vmi);
        const launcher = (r.pods.items || []).find((p: any) => (p.metadata?.name || '').startsWith(`virt-launcher-${this.name}-`));
        this.pod.set(launcher || null);
        this.events.set(r.events.items || []);
        this.servicesRaw.set(r.services.items || []);
        this.podMetrics.set(r.metrics.items || []);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  // ── 파생: 기본 ──
  status() { return this.vm()?.status?.printableStatus || 'Unknown'; }
  statusClass() { return vmStatusClass(this.status()); }
  osId() { const img = (this.vm()?.spec?.template?.spec?.volumes || []).map((v: any) => v.containerDisk?.image).find(Boolean); return osIdFromImage(this.vm()?.spec?.template?.metadata?.annotations?.['vm.kubevirt.io/os'] || img); }
  running(): boolean {
    const s = this.vm()?.spec || {};
    if (typeof s.running === 'boolean') return s.running;
    if (s.runStrategy) return s.runStrategy !== 'Halted' && s.runStrategy !== 'Manual';
    return this.status() === 'Running';
  }
  paused(): boolean { return (this.vmi()?.status?.conditions || []).some((c: any) => c.type === 'Paused' && c.status === 'True'); }
  private dom() { return this.vm()?.spec?.template?.spec?.domain || {}; }
  cpu() { const c = this.dom().cpu || {}; return (c.sockets || 1) * (c.cores || 1) * (c.threads || 1); }
  memory() { return this.dom().memory?.guest || this.dom().resources?.requests?.memory || '—'; }
  os() {
    const a = this.vm()?.spec?.template?.metadata?.annotations || {};
    return a['vm.kubevirt.io/os'] || this.vmi()?.status?.guestOSInfo?.prettyName || '게스트 에이전트 필요';
  }
  template() {
    const l = this.vm()?.metadata?.labels || {};
    return l['vm.kubevirt.io/template'] || Object.keys(l).find(k => k.startsWith('os.template')) || '—';
  }
  hostname() { return this.vm()?.spec?.template?.spec?.hostname || this.vmi()?.status?.guestOSInfo?.hostname || '게스트 에이전트 필요'; }
  owner() { const o = this.vm()?.metadata?.ownerReferences?.[0]; return o ? `${o.kind}/${o.name}` : '소유자 없음'; }
  networks() {
    const ifaces = this.vmi()?.status?.interfaces || [];
    const specNets = this.vm()?.spec?.template?.spec?.networks || [];
    if (ifaces.length) return ifaces.map((i: any) => ({ name: i.name, ip: i.ipAddress }));
    return specNets.map((n: any) => ({ name: n.name, ip: '' }));
  }
  fqdn() { return this.vmi()?.spec?.hostname ? `${this.vmi().spec.hostname}.${this.namespace}` : (this.vmi()?.status?.fqdn || ''); }
  disks() {
    const t = this.vm()?.spec?.template?.spec || {};
    const vols: Record<string, any> = {};
    for (const v of t.volumes || []) vols[v.name] = v;
    return (t.domain?.devices?.disks || []).map((d: any) => {
      const v = vols[d.name] || {};
      const source = v.containerDisk ? `containerDisk: ${v.containerDisk.image}` :
        v.dataVolume ? `DataVolume: ${v.dataVolume.name}` :
        v.persistentVolumeClaim ? `PVC: ${v.persistentVolumeClaim.claimName}` :
        v.cloudInitNoCloud ? 'cloud-init' : Object.keys(v).filter(k => k !== 'name')[0] || '—';
      return { name: d.name, drive: d.disk ? 'Disk' : d.cdrom ? 'CD-ROM' : 'Disk', bus: (d.disk || d.cdrom)?.bus || '—', source };
    });
  }
  yaml(): string { try { return dump(this.vm()); } catch { return ''; } }

  // ── 파생: 서비스 ──
  services() {
    const nm = this.name;
    return this.servicesRaw().filter((s: any) => {
      const sel = s.spec?.selector || {};
      return Object.entries(sel).some(([k, v]) => (k.includes('kubevirt') && v === nm) || (k === 'vm.kubevirt.io/name' && v === nm) || v === nm);
    });
  }

  // ── 파생: 메트릭 ──
  private launcherMetric() { const p = this.pod(); return p ? this.podMetrics().find((m: any) => m.metadata?.name === p.metadata?.name) : null; }
  hasMetrics() { return !!this.launcherMetric(); }
  cpuUsage() { const m = this.launcherMetric(); if (!m) return '—'; return (m.containers || []).reduce((s: number, c: any) => s + cpuCores(c.usage?.cpu), 0).toFixed(2); }
  memUsage() { const m = this.launcherMetric(); if (!m) return '—'; return ((m.containers || []).reduce((s: number, c: any) => s + memBytes(c.usage?.memory), 0) / 1024 ** 2).toFixed(0); }

  // ── 파생: 설정 ──
  runStrategy() { const s = this.vm()?.spec || {}; return s.runStrategy || (typeof s.running === 'boolean' ? `running=${s.running}` : '—'); }
  guestAgent() { const c = (this.vmi()?.status?.conditions || []).find((x: any) => x.type === 'AgentConnected'); return c ? (c.status === 'True' ? '연결됨' : '연결 안 됨') : '게스트 에이전트 필요'; }
  nodeSelector() { const ns = this.vm()?.spec?.template?.spec?.nodeSelector; return ns ? Object.entries(ns).map(([k, v]) => `${k}=${v}`).join(', ') : '—'; }
  labels() { return Object.entries(this.vm()?.metadata?.labels || {}).map(([k, v]) => `${k}=${v}`); }
  annotations() { return Object.keys(this.vm()?.metadata?.annotations || {}); }

  // ── 파생: 진단 ──
  conditions() { return this.vmi()?.status?.conditions || []; }
  migration() { const m = this.vmi()?.status?.migrationState; return m ? `${m.completed ? '완료' : '진행중'} ${m.targetNode ? '→ ' + m.targetNode : ''}` : '없음'; }

  // ── 라이프사이클 ──
  setRunning(on: boolean) {
    const s = this.vm()?.spec || {};
    const patch = (s.runStrategy && typeof s.running !== 'boolean') ? { spec: { runStrategy: on ? 'Always' : 'Halted' } } : { spec: { running: on } };
    this.busy.set(true);
    this.k8s.patchMerge(this.vmPath(), patch).subscribe({
      next: () => { this.busy.set(false); this.flash(on ? 'VM 시작 요청.' : 'VM 정지 요청.', true); this.changed.emit(); setTimeout(() => this.load(), 700); },
      error: e => { this.busy.set(false); this.flash(this.err(e), false); },
    });
  }
  restart() {
    this.busy.set(true);
    this.k8s.post(this.subPath('restart'), {}).subscribe({
      next: () => { this.busy.set(false); this.flash('VM 재시작 요청.', true); this.changed.emit(); setTimeout(() => this.load(), 700); },
      error: e => { this.busy.set(false); this.flash('재시작 실패: ' + this.err(e), false); },
    });
  }
  pause(on: boolean) {
    this.busy.set(true);
    this.k8s.post(this.subPath(on ? 'pause' : 'unpause'), {}).subscribe({
      next: () => { this.busy.set(false); this.flash(on ? 'VM 일시정지.' : 'VM 재개.', true); this.changed.emit(); setTimeout(() => this.load(), 700); },
      error: e => { this.busy.set(false); this.flash((on ? '일시정지' : '재개') + ' 실패: ' + this.err(e), false); },
    });
  }
  doDelete() {
    this.busy.set(true);
    this.k8s.remove(this.vmPath()).subscribe({
      next: () => { this.busy.set(false); this.deleteOpen.set(false); this.flash('삭제됨.', true); this.changed.emit(); this.back.emit(); },
      error: e => { this.busy.set(false); this.flash(this.err(e), false); },
    });
  }

  private flash(m: string, ok: boolean) { this.ok.set(ok); this.msg.set(m); }
  private err(e: any): string { return e?.error?.message || e?.error?.error || e?.message || String(e); }
  age(ts: string): string {
    if (!ts) return '—';
    const ms = Date.now() - new Date(ts).getTime();
    const d = Math.floor(ms / 86400000); if (d > 0) return d + 'd';
    const h = Math.floor(ms / 3600000); if (h > 0) return h + 'h';
    const m = Math.floor(ms / 60000); return m > 0 ? m + 'm' : '<1m';
  }
}
