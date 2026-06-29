import { Component, OnInit, OnDestroy, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsDatagrid, OsCellDef, OsColumn } from '../os/os-datagrid';
import { AuthService } from '../core/auth.service';
import { BackboneGraph } from './backbone-graph';
import { BackboneSlice } from './backbone-slice';

interface BbComponent { key: string; name: string; role: string; kind: string; installed: boolean; ready: boolean; detail: string; }
interface BbState { namespace: string; nsExists: boolean; installed: boolean; ready: boolean; components: BbComponent[]; }
interface CtrlStatus { crdReady: boolean; dbConnected: boolean; runs: number; total: number; bound: number; lastRun: string; lastError: string; intervalSec: number; finalizer: string; }
interface Claim {
  namespace: string; name: string; phase: string; deleting: boolean; message: string;
  spec: { postgres: boolean; objectStore: boolean; gitOps: boolean };
  postgres: { secretRef: string; database: string } | null;
  objectStore: { bucket: string; state: string } | null;
}

/**
 * Backbone — 콘솔 제어평면 상태저장 스택(PostgreSQL · RustFS · Gitea) 설치/상태. **셸 네이티브** 페이지.
 * 백엔드 = dupa-registry-controller(/api/admin/backbone/{status,install}, admin 게이트). docs/BACKBONE-ARCHITECTURE.md.
 * Foundation(사용자 워크로드 지원)과 분리된 콘솔 전용 데이터 티어. 설치는 멱등(POST 409=보존).
 */
@Component({
  selector: 'os-admin-backbone',
  imports: [ClarityModule, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef, BackboneGraph, BackboneSlice],
  template: `
    <div class="os-page">
      <os-page-header title="Backbone" tag="Core·Admin · 콘솔 데이터 티어" />
      @if (down(); as d) {
      <os-backend-unavailable
        feature="Backbone"
        backend="dupa-registry-controller (/api/admin/backbone)"
        hint="dupa-registry-controller 배포 · ClusterRole(dupa-backbone-installer) 적용 시 복구됩니다."
        [detail]="d"
      />
    } @else {
    <p class="os-sub">
      콘솔 제어평면 상태저장 스택 — PostgreSQL · RustFS · Gitea. Foundation(사용자 워크로드 지원)과 분리된 콘솔 전용 데이터 티어.
      @if (state(); as s) { · ns <code>{{ s.namespace }}</code> · {{ s.installed ? '설치됨' : '미설치' }} · {{ s.ready ? '정상(Ready)' : '준비중' }} }
    </p>

    @if (msg(); as m) {
      <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)">
        <clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item>
      </clr-alert>
    }

    <clr-tabs>
      <!-- 탭1: 구성요소 -->
      <clr-tab>
        <button clrTabLink>구성요소</button>
        <clr-tab-content>
          <div class="os-actions">
            <button class="btn btn-primary" [disabled]="busy()" (click)="install()">{{ state()?.installed ? 'Backbone 재적용' : 'Backbone 설치' }}</button>
            <button class="btn btn-outline" [disabled]="busy()" (click)="refresh()">새로고침</button>
            @if (busy()) { <span class="spinner spinner-inline"></span> }
          </div>
          <p class="os-sub">행을 클릭하면 우측 슬라이스에서 일반정보·Contents·YAML·이벤트를 봅니다(읽기 전용).</p>
          <os-datagrid [columns]="cols" [rows]="components()" [selected]="selectedRow()" (rowClick)="openDetail($event)" empty="상태 조회 중…">
            <ng-template osCell="name" let-c><strong>{{ c.name }}</strong> <span class="os-mono">· {{ c.kind }}</span></ng-template>
            <ng-template osCell="status" let-c>
              @if (c.ready) { <span class="label label-success">Ready</span> }
              @else if (c.installed) { <span class="label label-warning">NotReady</span> }
              @else { <span class="label">미설치</span> }
            </ng-template>
            <ng-template osCell="detail" let-c><span class="os-mono">{{ c.detail }}</span></ng-template>
          </os-datagrid>
          <p class="os-sub">⚠️ 로컬(local-path) 단일노드: 단일 replica · 논리 백업 전용(스냅샷 불가). 운영은 네트워크 스토리지로 격상. 설계: <code>docs/BACKBONE-ARCHITECTURE.md</code></p>
        </clr-tab-content>
      </clr-tab>

      <!-- 탭2: 의존 관계 -->
      <clr-tab>
        <button clrTabLink>의존 관계</button>
        <clr-tab-content>
          <p class="os-sub">콘솔 서비스가 어느 데이터티어에 연결되는지(누가 무엇을). 점선 = 예정. 데이터티어 색 = 라이브 상태.</p>
          <os-backbone-graph [statusByKey]="statusByKey()" />
        </clr-tab-content>
      </clr-tab>

      <!-- 탭3: 컨트롤러 (BackboneClaim 할당 reconciler 상태 + 테넌트 요청 목록) -->
      <clr-tab>
        <button clrTabLink (click)="loadController()">컨트롤러</button>
        <clr-tab-content>
          @if (ctrl(); as c) {
            <div class="os-actions"><button class="btn btn-sm btn-outline" (click)="loadController()">새로고침</button></div>
            <h2>할당 컨트롤러 <span class="os-engine">· BackboneClaim reconciler (dupa)</span></h2>
            <clr-datagrid>
              <clr-dg-column>항목</clr-dg-column>
              <clr-dg-column>상태</clr-dg-column>
              <clr-dg-row><clr-dg-cell>CRD</clr-dg-cell><clr-dg-cell>@if (c.crdReady) { <span class="label label-success">installed</span> } @else { <span class="label label-warning">미설치 — backboneclaim-crd.yaml apply 필요</span> }</clr-dg-cell></clr-dg-row>
              <clr-dg-row><clr-dg-cell>PostgreSQL 연결</clr-dg-cell><clr-dg-cell>@if (c.dbConnected) { <span class="label label-success">connected</span> } @else { <span class="label label-warning">미연결</span> }</clr-dg-cell></clr-dg-row>
              <clr-dg-row><clr-dg-cell>Claims (bound/total)</clr-dg-cell><clr-dg-cell>{{ c.bound }} / {{ c.total }}</clr-dg-cell></clr-dg-row>
              <clr-dg-row><clr-dg-cell>Reconcile</clr-dg-cell><clr-dg-cell class="os-mono">runs {{ c.runs }} · 주기 {{ c.intervalSec }}s · last {{ c.lastRun || '—' }}</clr-dg-cell></clr-dg-row>
              @if (c.lastError) { <clr-dg-row><clr-dg-cell>Last error</clr-dg-cell><clr-dg-cell class="os-mono">{{ c.lastError }}</clr-dg-cell></clr-dg-row> }
              <clr-dg-row><clr-dg-cell>Finalizer</clr-dg-cell><clr-dg-cell class="os-mono">{{ c.finalizer }}</clr-dg-cell></clr-dg-row>
            </clr-datagrid>

            <h2>BackboneClaim <span class="os-engine">· 테넌트 요청 ({{ claims().length }})</span></h2>
            <clr-datagrid>
              <clr-dg-column>Namespace</clr-dg-column>
              <clr-dg-column>Name</clr-dg-column>
              <clr-dg-column>Phase</clr-dg-column>
              <clr-dg-column>요청</clr-dg-column>
              <clr-dg-column>바인딩(secretRef)</clr-dg-column>
              @for (cl of claims(); track cl.namespace + cl.name) {
                <clr-dg-row>
                  <clr-dg-cell>{{ cl.namespace }}</clr-dg-cell>
                  <clr-dg-cell>{{ cl.name }}{{ cl.deleting ? ' (deleting)' : '' }}</clr-dg-cell>
                  <clr-dg-cell><span class="label" [class.label-success]="cl.phase === 'Bound'" [class.label-warning]="cl.phase !== 'Bound'">{{ cl.phase }}</span></clr-dg-cell>
                  <clr-dg-cell class="os-mono">{{ specStr(cl) }}</clr-dg-cell>
                  <clr-dg-cell class="os-mono">{{ bindStr(cl) }}</clr-dg-cell>
                </clr-dg-row>
              }
              <clr-dg-placeholder>BackboneClaim 없음 — 소비자(OAH 등)가 CR을 생성하면 여기 표시됩니다.</clr-dg-placeholder>
            </clr-datagrid>
            <p class="os-sub">소비자 NS에 <code>BackboneClaim</code>(spec.postgres.enabled) 생성 → 컨트롤러가 DB·Secret 발급 후 status 바인딩. 명령형 대안: <code>tools/local-dev/provision-backbone-tenant.sh</code></p>
          } @else { <p class="os-sub">불러오는 중…</p> }
        </clr-tab-content>
      </clr-tab>
    </clr-tabs>
      }
    </div>

    @if (selectedRow(); as r) {
      <os-backbone-slice [row]="r" (closed)="closeDetail()" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub { color: var(--os-muted); font-size: 0.7rem; margin: 0.3rem 0 0.8rem; }
      .os-engine { font-size: 0.6rem; color: var(--os-muted); font-weight: 400; margin-left: 0.4rem; }
      .os-mono { font-family: monospace; font-size: 0.62rem; color: var(--os-muted); }
      .os-actions { display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0 1rem; }
      .label { margin: 0 0.25rem 0.25rem 0; }
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
  readonly components = computed<BbComponent[]>(() => this.state()?.components ?? []);
  readonly statusByKey = computed<Record<string, { installed: boolean; ready: boolean }>>(() => {
    const m: Record<string, { installed: boolean; ready: boolean }> = {};
    for (const c of this.components()) m[c.key] = { installed: c.installed, ready: c.ready };
    return m;
  });
  readonly down = signal<string>('');
  readonly busy = signal<boolean>(false);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  readonly selectedRow = signal<BbComponent | null>(null);
  readonly ctrl = signal<CtrlStatus | null>(null);
  readonly claims = signal<Claim[]>([]);
  private timer: ReturnType<typeof setInterval> | null = null;

  private auth = inject(AuthService);
  private authGet(): RequestInit {
    return { cache: 'no-store', headers: { authorization: 'Bearer ' + (this.auth.token() || '') } };
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => this.refresh(true), 8000); // 목록 상태 자동 갱신(슬라이스는 자체 로드)
  }
  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(silent = false): Promise<void> {
    try {
      const r = await fetch('/api/admin/backbone/status', this.authGet());
      if (r.status === 401 || r.status === 403) {
        if (!silent) this.msg.set({ type: 'danger', text: '관리자 권한이 필요합니다 (opensphere-console-admins).' });
        return;
      }
      if (!r.ok) {
        this.down.set(`status HTTP ${r.status}`);
        return;
      }
      this.down.set('');
      this.state.set(await r.json());
    } catch (e) {
      this.down.set('조회 실패: ' + e);
    }
  }

  openDetail(c: BbComponent): void { this.selectedRow.set(c); } // 슬라이스가 detail/yaml/pg를 자체 로드
  closeDetail(): void { this.selectedRow.set(null); }

  /** 컨트롤러 탭 — reconciler 상태 + BackboneClaim 목록 조회. */
  async loadController(): Promise<void> {
    try {
      const [cr, cl] = await Promise.all([
        fetch('/api/admin/backbone/controller', this.authGet()),
        fetch('/api/admin/backbone/claims', this.authGet()),
      ]);
      if (cr.ok) this.ctrl.set(await cr.json());
      if (cl.ok) this.claims.set((await cl.json()).items || []);
    } catch { /* 컨트롤러 조회 실패 무시 */ }
  }
  specStr(cl: Claim): string {
    return [cl.spec.postgres ? 'postgres' : '', cl.spec.objectStore ? 'objectStore' : '', cl.spec.gitOps ? 'gitOps' : ''].filter(Boolean).join(', ') || '—';
  }
  bindStr(cl: Claim): string {
    const parts: string[] = [];
    if (cl.postgres) parts.push(`pg:${cl.postgres.database} → ${cl.postgres.secretRef}`);
    if (cl.objectStore) parts.push(`s3:${cl.objectStore.bucket}(${cl.objectStore.state})`);
    return parts.join(' · ') || (cl.message || '—');
  }

  async install(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.msg.set({ type: 'info', text: 'Backbone 설치 적용 중… (이미지 풀·기동에 수 분 소요)' });
    try {
      const r = await fetch('/api/admin/backbone/install', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (this.auth.token() || ''), 'content-type': 'application/json' },
        body: '{}',
      });
      if (r.status === 401 || r.status === 403) {
        this.msg.set({ type: 'danger', text: '관리자 권한이 필요합니다.' });
        return;
      }
      if (!r.ok) {
        this.msg.set({ type: 'danger', text: `설치 실패 (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: 'Backbone 설치를 적용했습니다. 컴포넌트가 기동되며 상태가 자동 갱신됩니다.' });
      this.state.set(await r.json());
    } catch (e) {
      this.msg.set({ type: 'danger', text: '설치 요청 실패: ' + e });
    } finally {
      this.busy.set(false);
    }
  }
}
