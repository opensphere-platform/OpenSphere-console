import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnInit, Output, inject, signal, computed } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { firstValueFrom } from 'rxjs';
import { dump, load } from 'js-yaml';
import { K8sService } from '../core/k8s.service';
import { singleResourcePath } from './k8s-path';
import { errText as errTextOf } from './k8s-error';
import { diagnose } from './diagnose.rules';
import { DiagAction } from './diagnose.model';
import { DiagnoseCardComponent } from './diagnose-card.component';
import { CodeEditorComponent } from './code-editor.component';
import { LogViewerComponent } from './log-viewer.component';

// 인라인 SVG 아이콘(material 계열 path) — 웹컴포넌트 의존 없이 안전한 아이콘 액션.
const ICON = {
  eye: 'M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 110-10 5 5 0 010 10zm0-2a3 3 0 100-6 3 3 0 000 6z',
  download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
  pencil: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  resize: 'M22 3h-7v2h3.59L3 20.59V17H1v7h7v-2H4.41L20 6.41V10h2V3z',
  refresh: 'M17.65 6.35A8 8 0 1019 13h-2a6 6 0 11-1.76-4.24L13 11h7V4l-2.35 2.35z',
  trash: 'M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  logs: 'M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h12v2H3v-2z',
  terminal: 'M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V8h16v10zM6.5 9.5L10 13l-3.5 3.5L5.5 15 7.5 13l-2-2 1-1.5zM12 15h5v1.5h-5V15z',
  cordon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 2c1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.95 7.95 0 014 12a8 8 0 018-8zm0 16c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.95 7.95 0 0120 12a8 8 0 01-8 8z',
  uncordon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  drain: 'M20 3h-9v2h9v14h-9v2h9a2 2 0 002-2V5a2 2 0 00-2-2zM7 8l-1.41 1.41L8.17 12H1v2h7.17l-2.58 2.59L7 18l5-5-5-5z',
  play: 'M8 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
};

/** 단일 리소스 상세 + 액션(View/Download/Edit YAML, Delete, Scale, Restart).
 *  제네릭 — 모든 리소스 재사용. 쓰기는 K8sService(셸 토큰 주입 → 백엔드 JWKS 검증 → 임퍼소네이션). */
@Component({
  selector: 'app-resource-detail',
  standalone: true,
  imports: [CommonModule, ClarityModule, CodeEditorComponent, LogViewerComponent, DiagnoseCardComponent],
  template: `
    <div *ngIf="namespaced" class="os-sub os-sub-mb">namespace: {{ namespace }}</div>

    <div *ngIf="msg()" class="alert" [ngClass]="ok() ? 'alert-success' : 'alert-danger'" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ msg() }}</span></div></div>
    </div>

    <!-- 액션 바 (인라인 SVG 아이콘 + 툴팁) -->
    <div class="os-actions" *ngIf="obj()">
      <button class="os-iconbtn" title="View YAML" aria-label="View YAML" (click)="setMode('view')"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.eye"/></svg></button>
      <button class="os-iconbtn" title="Download" aria-label="Download" (click)="download()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.download"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly" title="Edit YAML" aria-label="Edit YAML" (click)="startEdit()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.pencil"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly && scalable" title="Scale" aria-label="Scale" (click)="scaleOpen.set(true)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.resize"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly && restartable" title="Restart" aria-label="Restart" (click)="restart()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.refresh"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly && vm && !vmRunning()" title="Start VM" aria-label="Start VM" [disabled]="busy()" (click)="vmStart()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.play"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly && vm && vmRunning()" title="Stop VM" aria-label="Stop VM" [disabled]="busy()" (click)="vmStop()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.stop"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly && vm" title="Restart VM" aria-label="Restart VM" [disabled]="busy()" (click)="vmRestart()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.refresh"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly && cordonable && !unschedulable()" title="Cordon (스케줄 차단)" aria-label="Cordon" (click)="cordon(true)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.cordon"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly && cordonable && unschedulable()" title="Uncordon (스케줄 허용)" aria-label="Uncordon" (click)="cordon(false)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.uncordon"/></svg></button>
      <button class="os-iconbtn os-iconbtn-danger" *ngIf="!readOnly && cordonable" title="Drain (파드 축출)" aria-label="Drain" (click)="drainOpen.set(true)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.drain"/></svg></button>
      <button class="os-iconbtn" *ngIf="kind === 'Pod'" title="Logs" aria-label="Logs" (click)="openLogs()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.logs"/></svg></button>
      <button class="os-iconbtn" *ngIf="!readOnly && kind === 'Pod'" title="Terminal (exec)" aria-label="Terminal" (click)="openExec()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.terminal"/></svg></button>
      <button class="os-iconbtn os-iconbtn-danger" *ngIf="!readOnly" title="Delete" aria-label="Delete" (click)="deleteOpen.set(true)"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.trash"/></svg></button>
    </div>

    <!-- C3 Diagnose — 문제 있을 때만 상세 최상단에 평문 진단+추천 액션(읽기). -->
    <app-diagnose-card *ngIf="mode() === 'view' && diagnoses().length" [diagnoses]="diagnoses()" (act)="onDiag($event)" />

    <!-- C5 PVC reclaimPolicy — 데이터 영속성 가시화(read만). -->
    <div *ngIf="mode() === 'view' && pvReclaim() as rp" class="os-pvrp" [class.os-pvrp-warn]="rp === 'Delete'">
      <span class="os-pvrp-k">디스크 삭제 정책</span>
      <span class="label" [class.label-warning]="rp === 'Delete'">{{ rp }}</span>
      <span class="os-pvrp-hint">{{ rp === 'Delete' ? 'PVC 삭제 시 디스크 데이터도 함께 삭제됩니다.' : rp === 'Retain' ? 'PVC를 삭제해도 디스크(PV)는 보존됩니다.' : '' }}</span>
    </div>

    <clr-datagrid *ngIf="obj() && mode() === 'view'" [clrDgLoading]="loading()">
      <clr-dg-column>Field</clr-dg-column>
      <clr-dg-column>Value</clr-dg-column>
      <clr-dg-row *ngFor="let r of info()">
        <clr-dg-cell><strong>{{ r.k }}</strong></clr-dg-cell>
        <clr-dg-cell>{{ r.v }}</clr-dg-cell>
      </clr-dg-row>
    </clr-datagrid>

    <!-- YAML 뷰 (읽기전용 + 검색 + 문법강조 + 줄번호) -->
    <div *ngIf="obj() && mode() === 'view'" class="os-card">
      <div class="os-card-h">YAML</div>
      <app-code-editor [value]="yaml()" language="yaml" [readOnly]="true" height="460px"></app-code-editor>
    </div>

    <!-- YAML 편집 (편집 + 검색 + 문법강조 + 줄번호) -->
    <div *ngIf="mode() === 'edit'" class="os-card">
      <div class="os-card-h">Edit YAML</div>
      <app-code-editor [value]="draft()" language="yaml" [readOnly]="false" height="420px" (valueChange)="draft.set($event)"></app-code-editor>
      <div class="os-actions">
        <button class="btn btn-sm btn-primary" [disabled]="busy()" (click)="saveEdit()">Save &amp; Apply</button>
        <button class="btn btn-sm btn-outline" (click)="setMode('view')">Cancel</button>
      </div>
    </div>

    <!-- Pod 로그 (tail) -->
    <div *ngIf="mode() === 'logs'" class="os-card">
      <div class="os-card-h os-logs-h">
        <span>Logs</span>
        <span class="os-logs-ctrls">
          <select [value]="container()" (change)="container.set($any($event.target).value); loadLogs()">
            <option *ngFor="let c of containers()" [value]="c">{{ c }}</option>
          </select>
          <select [value]="tail()" (change)="tail.set(+$any($event.target).value); loadLogs()">
            <option [value]="100">100 lines</option>
            <option [value]="500">500 lines</option>
            <option [value]="2000">2000 lines</option>
          </select>
          <button class="os-iconbtn" title="Refresh" (click)="loadLogs()"><svg viewBox="0 0 24 24" class="os-ic"><path [attr.d]="ic.refresh"/></svg></button>
          <button class="os-iconbtn" title="Close logs" (click)="setMode('view')"><svg viewBox="0 0 24 24" class="os-ic"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
        </span>
      </div>
      <!-- 로그: ANSI 색상 렌더 + 검색(노란 하이라이트·이전/다음) + 줄바꿈 토글 -->
      <app-log-viewer [text]="logsLoading() ? '불러오는 중…' : (logText() || '(로그 없음)')" height="520px"></app-log-viewer>
    </div>

    <!-- 이벤트 -->
    <div class="os-card" *ngIf="obj() && mode() === 'view'">
      <div class="os-card-h">Events</div>
      <clr-datagrid>
        <clr-dg-column>Type</clr-dg-column>
        <clr-dg-column>Reason</clr-dg-column>
        <clr-dg-column>Message</clr-dg-column>
        <clr-dg-column>Age</clr-dg-column>
        <clr-dg-row *ngFor="let e of events()">
          <clr-dg-cell><span class="label" [ngClass]="e.type === 'Warning' ? 'label-warning' : 'label-info'">{{ e.type }}</span></clr-dg-cell>
          <clr-dg-cell>{{ e.reason }}</clr-dg-cell>
          <clr-dg-cell>{{ e.message }}</clr-dg-cell>
          <clr-dg-cell>{{ age(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp) }}</clr-dg-cell>
        </clr-dg-row>
        <clr-dg-placeholder>No events.</clr-dg-placeholder>
      </clr-datagrid>
    </div>

    <!-- 삭제 확인 모달 -->
    <clr-modal [(clrModalOpen)]="deleteOpenModel" [clrModalSize]="'sm'">
      <h3 class="modal-title">Delete {{ kind }}</h3>
      <div class="modal-body">Delete <strong>{{ name }}</strong>{{ namespaced ? ' in ' + namespace : '' }}?</div>
      <div class="modal-footer">
        <button class="btn btn-outline" (click)="deleteOpen.set(false)">Cancel</button>
        <button class="btn btn-danger" [disabled]="busy()" (click)="doDelete()">Delete</button>
      </div>
    </clr-modal>

    <!-- 스케일 모달 -->
    <clr-modal [(clrModalOpen)]="scaleOpenModel" [clrModalSize]="'sm'">
      <h3 class="modal-title">Scale {{ kind }}</h3>
      <div class="modal-body">
        Replicas:
        <input type="number" min="0" class="os-num" [value]="replicas()" (input)="replicas.set(+$any($event.target).value)" />
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" (click)="scaleOpen.set(false)">Cancel</button>
        <button class="btn btn-primary" [disabled]="busy()" (click)="doScale()">Scale</button>
      </div>
    </clr-modal>

    <!-- 드레인 확인 모달 (코든 + 파드 축출; DaemonSet/미러 파드 제외) -->
    <clr-modal [(clrModalOpen)]="drainOpenModel" [clrModalSize]="'md'">
      <h3 class="modal-title">Drain {{ name }}</h3>
      <div class="modal-body">
        <p>노드 <strong>{{ name }}</strong>를 코든하고 파드를 축출(eviction)합니다.
           DaemonSet 소유·미러 파드와 이미 종료 중인 파드는 제외됩니다. PodDisruptionBudget이 적용됩니다.</p>
        <p *ngIf="drainMsg()" class="os-sub">{{ drainMsg() }}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" [disabled]="busy()" (click)="drainOpen.set(false)">Cancel</button>
        <button class="btn btn-danger" [disabled]="busy()" (click)="doDrain()">Drain</button>
      </div>
    </clr-modal>
  `,
})
export class ResourceDetailComponent implements OnInit {
  readonly readOnly = true;
  @Input({ required: true }) kind!: string;
  @Input({ required: true }) listPath!: string;
  @Input({ required: true }) namespaced!: boolean;
  @Input({ required: true }) item!: any;
  @Input() scalable = false;
  @Input() restartable = false;
  @Input() cordonable = false;
  /** KubeVirt VM — Start/Stop/Restart 라이프사이클 액션 노출 */
  @Input() vm = false;
  @Output() back = new EventEmitter<void>();
  @Output() changed = new EventEmitter<void>();

  private k8s = inject(K8sService);
  readonly ic = ICON;
  readonly obj = signal<any>(null);
  readonly loading = signal(true);
  readonly mode = signal<'view' | 'edit' | 'logs' | 'exec'>('view');
  readonly draft = signal('');
  readonly events = signal<any[]>([]);
  /** C3 — 읽은 obj()·events()로 규칙기반 진단(네트워크 0). length>0이면 상세 최상단 카드. */
  readonly diagnoses = computed(() => diagnose(this.obj(), this.events()));
  /** C5 — PVC가 바인딩된 PV의 reclaimPolicy(Retain/Delete/Recycle). read만. */
  readonly pvReclaim = signal<string | null>(null);
  // Pod 로그(tail)
  readonly container = signal('');
  readonly tail = signal(500);
  readonly logText = signal('');
  readonly logsLoading = signal(false);
  // Pod exec 터미널
  readonly execContainer = signal('');
  readonly execShown = signal(false);
  readonly busy = signal(false);
  readonly msg = signal<string | null>(null);
  readonly ok = signal(false);
  readonly deleteOpen = signal(false);
  readonly scaleOpen = signal(false);
  readonly drainOpen = signal(false);
  readonly drainMsg = signal('');
  readonly replicas = signal(0);

  /** Node가 스케줄 차단(cordoned) 상태인가 */
  unschedulable(): boolean { return !!this.obj()?.spec?.unschedulable; }

  get name() { return this.item?.metadata?.name; }
  get namespace() { return this.item?.metadata?.namespace; }
  // clr-modal 양방향 바인딩 어댑터(signal ↔ [(clrModalOpen)])
  get deleteOpenModel() { return this.deleteOpen(); }
  set deleteOpenModel(v: boolean) { this.deleteOpen.set(v); }
  get scaleOpenModel() { return this.scaleOpen(); }
  set scaleOpenModel(v: boolean) { this.scaleOpen.set(v); }
  get drainOpenModel() { return this.drainOpen(); }
  set drainOpenModel(v: boolean) { this.drainOpen.set(v); }

  private singlePath(): string {
    return singleResourcePath(this.listPath, this.namespace, this.name, this.namespaced);
  }

  ngOnInit(): void {
    this.k8s.get(this.singlePath()).subscribe({
      next: o => {
        this.obj.set(o); this.replicas.set(o?.spec?.replicas ?? 0); this.loading.set(false);
        // C5 — PVC면 bound PV의 reclaimPolicy 조회(read만).
        if (/persistentvolumeclaims/i.test(this.listPath) && o?.spec?.volumeName) this.loadPvReclaim(o.spec.volumeName);
      },
      error: e => { this.obj.set(this.item); this.loading.set(false); this.flash(this.errText(e), false); },
    });
    const evNs = this.namespaced ? `/api/v1/namespaces/${this.namespace}/events` : `/api/v1/events`;
    this.k8s.list(evNs, { fieldSelector: `involvedObject.name=${this.name}` }).subscribe({
      next: r => this.events.set(r.items || []),
      error: () => this.events.set([]),
    });
  }

  yaml(): string { try { return dump(this.obj()); } catch { return ''; } }
  info() {
    const o = this.obj() || {};
    const rows: { k: string; v: any }[] = [
      { k: 'Name', v: o.metadata?.name },
      { k: 'Namespace', v: o.metadata?.namespace },
      { k: 'Created', v: o.metadata?.creationTimestamp },
      { k: 'UID', v: o.metadata?.uid },
      { k: 'Resource Version', v: o.metadata?.resourceVersion },
      { k: 'Labels', v: Object.entries(o.metadata?.labels || {}).map(([a, b]) => `${a}=${b}`).join(', ') },
      { k: 'Annotations', v: Object.keys(o.metadata?.annotations || {}).join(', ') },
    ];
    return rows.filter(r => r.v != null && r.v !== '');
  }

  setMode(m: 'view' | 'edit' | 'logs' | 'exec') { this.mode.set(m); }
  startEdit() { this.draft.set(this.yaml()); this.mode.set('edit'); }

  openExec() {
    const cs = this.containers();
    this.execContainer.set(cs[0] || '');
    this.mode.set('exec');
    this.execShown.set(true);
  }
  reExec(c: string) {
    this.execContainer.set(c);
    this.execShown.set(false);
    setTimeout(() => this.execShown.set(true), 0); // 컨테이너 변경 시 터미널 재생성
  }

  containers(): string[] {
    const o = this.obj() || {};
    return [
      ...(o.spec?.containers || []).map((c: any) => c.name),
      ...(o.spec?.initContainers || []).map((c: any) => c.name),
    ];
  }
  /** C5 — bound PV의 reclaimPolicy 조회(read만). */
  private loadPvReclaim(pvName: string): void {
    this.k8s.get(`/api/v1/persistentvolumes/${pvName}`).subscribe({
      next: (pv: any) => this.pvReclaim.set(pv?.spec?.persistentVolumeReclaimPolicy ?? null),
      error: () => this.pvReclaim.set(null),
    });
  }

  /** C3 — 진단 카드 액션 라우팅. logs=로그 열기(기존), explain=AI Phase0 스텁(write·LLM 0), navigate/editField=후속 단계 안내. */
  onDiag(a: DiagAction): void {
    if (a.kind === 'logs') { if (a.hint) this.container.set(a.hint); this.openLogs(); return; }
    if (a.kind === 'explain') { this.flash('AI 설명은 곧 제공됩니다(현재는 진단 규칙 기반).', true); return; }
    this.flash(`추천 조치: ${a.label}${a.hint ? ' (' + a.hint + ')' : ''} — 후속 단계(폼/이동)에서 연결됩니다.`, true);
  }
  openLogs() {
    const cs = this.containers();
    if (!this.container() || !cs.includes(this.container())) this.container.set(cs[0] || '');
    this.mode.set('logs');
    this.loadLogs();
  }
  loadLogs() {
    if (!this.container()) return;
    this.logsLoading.set(true);
    const path = `/api/v1/namespaces/${this.namespace}/pods/${this.name}/log`;
    this.k8s.getText(path, { container: this.container(), tailLines: String(this.tail()), timestamps: 'true' }).subscribe({
      next: t => { this.logText.set(t); this.logsLoading.set(false); },
      error: e => { this.logText.set(this.errText(e)); this.logsLoading.set(false); },
    });
  }

  saveEdit() {
    let parsed: any;
    try { parsed = load(this.draft()); } catch (e) { return this.flash('YAML 파싱 오류: ' + e, false); }
    this.busy.set(true);
    this.k8s.replace(this.singlePath(), parsed).subscribe({
      next: o => { this.obj.set(o); this.busy.set(false); this.mode.set('view'); this.flash('적용됨(Save & Apply).', true); this.changed.emit(); },
      error: e => { this.busy.set(false); this.flash(this.errText(e), false); },
    });
  }

  doDelete() {
    this.busy.set(true);
    this.k8s.remove(this.singlePath()).subscribe({
      next: () => { this.busy.set(false); this.deleteOpen.set(false); this.flash('삭제됨.', true); this.changed.emit(); this.back.emit(); },
      error: e => { this.busy.set(false); this.flash(this.errText(e), false); },
    });
  }

  doScale() {
    this.busy.set(true);
    this.k8s.patchMerge(this.singlePath(), { spec: { replicas: this.replicas() } }).subscribe({
      next: o => { this.obj.set(o); this.busy.set(false); this.scaleOpen.set(false); this.flash(`replicas=${this.replicas()}로 스케일.`, true); this.changed.emit(); },
      error: e => { this.busy.set(false); this.flash(this.errText(e), false); },
    });
  }

  restart() {
    this.busy.set(true);
    const patch = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } };
    this.k8s.patchStrategic(this.singlePath(), patch).subscribe({
      next: o => { this.obj.set(o); this.busy.set(false); this.flash('롤링 재시작 트리거.', true); this.changed.emit(); },
      error: e => { this.busy.set(false); this.flash(this.errText(e), false); },
    });
  }

  // ── KubeVirt VM 라이프사이클 ──
  /** VM 희망 가동 상태(spec.running bool 우선, 없으면 runStrategy). */
  vmRunning(): boolean {
    const s = this.obj()?.spec || {};
    if (typeof s.running === 'boolean') return s.running;
    if (s.runStrategy) return s.runStrategy !== 'Halted' && s.runStrategy !== 'Manual';
    return false;
  }
  vmStart() { this.vmSetRunning(true); }
  vmStop() { this.vmSetRunning(false); }
  /** spec.running(또는 runStrategy) merge-patch로 시작/정지 — VM 컨트롤러가 VMI를 조정. 콘솔 임퍼소네이션 write. */
  private vmSetRunning(on: boolean) {
    const s = this.obj()?.spec || {};
    const patch = (s.runStrategy && typeof s.running !== 'boolean')
      ? { spec: { runStrategy: on ? 'Always' : 'Halted' } }
      : { spec: { running: on } };
    this.busy.set(true);
    this.k8s.patchMerge(this.singlePath(), patch).subscribe({
      next: o => { this.obj.set(o); this.busy.set(false); this.flash(on ? 'VM 시작 요청.' : 'VM 정지 요청.', true); this.changed.emit(); },
      error: e => { this.busy.set(false); this.flash(this.errText(e), false); },
    });
  }
  /** VM 재시작 — KubeVirt restart 서브리소스(virt-api 필요; 미설치 클러스터에선 404). */
  vmRestart() {
    this.busy.set(true);
    const sub = `/apis/subresources.kubevirt.io/v1/namespaces/${this.namespace}/virtualmachines/${this.name}/restart`;
    this.k8s.post(sub, {}).subscribe({
      next: () => { this.busy.set(false); this.flash('VM 재시작 요청.', true); this.changed.emit(); },
      error: e => { this.busy.set(false); this.flash('재시작 실패(KubeVirt virt-api 필요): ' + this.errText(e), false); },
    });
  }

  /** Node 코든/언코든 — spec.unschedulable 토글(단일 merge-patch, 임퍼소네이션). */
  cordon(on: boolean) {
    this.busy.set(true);
    this.k8s.patchMerge(this.singlePath(), { spec: { unschedulable: on } }).subscribe({
      next: o => { this.obj.set(o); this.busy.set(false); this.flash(on ? '코든됨(스케줄 차단).' : '언코든됨(스케줄 허용).', true); this.changed.emit(); },
      error: e => { this.busy.set(false); this.flash(this.errText(e), false); },
    });
  }

  /** Node 드레인 — 코든 후, 노드의 파드를 eviction(축출). DaemonSet 소유·미러·종료중 파드는 제외. */
  async doDrain() {
    this.busy.set(true);
    this.drainMsg.set('코든 중…');
    try {
      // 1) 코든
      const node = await firstValueFrom(this.k8s.patchMerge(this.singlePath(), { spec: { unschedulable: true } }));
      this.obj.set(node);
      // 2) 노드의 파드 조회
      this.drainMsg.set('파드 조회 중…');
      const res = await firstValueFrom(this.k8s.list('/api/v1/pods', { fieldSelector: `spec.nodeName=${this.name}` }));
      const pods = (res.items || []).filter((p: any) => {
        if (p.metadata?.deletionTimestamp) return false; // 이미 종료 중
        const owners = p.metadata?.ownerReferences || [];
        if (owners.some((r: any) => r.kind === 'DaemonSet')) return false; // DaemonSet 파드 제외
        if (p.metadata?.annotations?.['kubernetes.io/config.mirror']) return false; // 미러(static) 파드 제외
        return true;
      });
      // 3) 각 파드 eviction
      let ok = 0; const fails: string[] = [];
      for (const p of pods) {
        const ns = p.metadata.namespace, nm = p.metadata.name;
        this.drainMsg.set(`축출 중… (${ok + fails.length + 1}/${pods.length}) ${ns}/${nm}`);
        try {
          await firstValueFrom(this.k8s.post(`/api/v1/namespaces/${ns}/pods/${nm}/eviction`,
            { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: nm, namespace: ns } }));
          ok++;
        } catch (e: any) { fails.push(`${ns}/${nm}: ${this.errText(e)}`); }
      }
      this.busy.set(false);
      this.drainOpen.set(false);
      this.drainMsg.set('');
      const msg = `드레인: 코든 + ${ok}개 파드 축출` + (fails.length ? `, 실패 ${fails.length}개 (${fails.slice(0, 3).join('; ')}${fails.length > 3 ? '…' : ''})` : '');
      this.flash(msg, fails.length === 0);
      this.changed.emit();
    } catch (e) {
      this.busy.set(false);
      this.drainOpen.set(false);
      this.drainMsg.set('');
      this.flash('드레인 실패: ' + this.errText(e), false);
    }
  }

  download() {
    const blob = new Blob([this.yaml()], { type: 'text/yaml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.name}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private flash(m: string, ok: boolean) { this.ok.set(ok); this.msg.set(m); }
  private errText(e: any): string { return errTextOf(e); }
  age(ts: string): string {
    if (!ts) return '—';
    const ms = Date.now() - new Date(ts).getTime();
    const d = Math.floor(ms / 86400000); if (d > 0) return d + 'd';
    const h = Math.floor(ms / 3600000); if (h > 0) return h + 'h';
    const m = Math.floor(ms / 60000); return m > 0 ? m + 'm' : '<1m';
  }
}
