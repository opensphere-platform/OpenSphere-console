import { Component, OnInit, OnDestroy, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsDatagrid, OsCellDef, OsColumn } from '../os/os-datagrid';
import { AuthService } from '../core/auth.service';

interface BbComponent { key: string; name: string; role: string; kind: string; installed: boolean; ready: boolean; detail: string; }
interface BbState { namespace: string; nsExists: boolean; installed: boolean; ready: boolean; components: BbComponent[]; }

/**
 * Backbone — 콘솔 제어평면 상태저장 스택(PostgreSQL · RustFS · Gitea) 설치/상태. **셸 네이티브** 페이지.
 * 백엔드 = dupa-registry-controller(/api/admin/backbone/{status,install}, admin 게이트). docs/BACKBONE-ARCHITECTURE.md.
 * Foundation(사용자 워크로드 지원)과 분리된 콘솔 전용 데이터 티어. 설치는 멱등(POST 409=보존).
 */
@Component({
  selector: 'os-admin-backbone',
  imports: [ClarityModule, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef],
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

    <div class="os-actions">
      <button class="btn btn-primary" [disabled]="busy()" (click)="install()">{{ state()?.installed ? 'Backbone 재적용' : 'Backbone 설치' }}</button>
      <button class="btn btn-outline" [disabled]="busy()" (click)="refresh()">새로고침</button>
      @if (busy()) { <span class="spinner spinner-inline"></span> }
    </div>

    <h2>구성요소 <span class="os-engine">({{ components().length }})</span></h2>
    <os-datagrid [columns]="cols" [rows]="components()" empty="상태 조회 중…">
      <ng-template osCell="name" let-c><strong>{{ c.name }}</strong> <span class="os-mono">· {{ c.kind }}</span></ng-template>
      <ng-template osCell="status" let-c>
        @if (c.ready) { <span class="label label-success">Ready</span> }
        @else if (c.installed) { <span class="label label-warning">NotReady</span> }
        @else { <span class="label">미설치</span> }
      </ng-template>
      <ng-template osCell="detail" let-c><span class="os-mono">{{ c.detail }}</span></ng-template>
    </os-datagrid>

    <p class="os-sub">
      ⚠️ 로컬(local-path) 단일노드: 단일 replica · 논리 백업 전용(스냅샷 불가). 운영은 네트워크 스토리지로 격상.
      설계: <code>docs/BACKBONE-ARCHITECTURE.md</code>
    </p>
      }
    </div>
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
  readonly down = signal<string>('');
  readonly busy = signal<boolean>(false);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;

  private auth = inject(AuthService);
  private authGet(): RequestInit {
    return { cache: 'no-store', headers: { authorization: 'Bearer ' + (this.auth.token() || '') } };
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => this.refresh(true), 8000); // 상태 자동 갱신(기동 추적)
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
