import { Component, OnInit, signal, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsDatagrid, OsCellDef, OsColumn } from '../os/os-datagrid';
import { OsPanel } from '../os/os-panel';
import { AuthService } from '../core/auth.service';
import { HttpService } from '../core/http.service';

interface IdUser {
  id: string;
  username: string;
  email?: string;
  enabled: boolean;
  displayName?: string;
  groups?: string[];
}
interface IdMeta {
  realm?: string;
  idp?: string;
  writeEnabled?: boolean;
}
interface AuditEvent {
  time?: string;
  actor?: string;
  action?: string;
  target?: string;
  result?: string;
}
interface AuthPolicy {
  totpEnabled: boolean;
  environment: string;
  enforced?: boolean;
  updatedAt?: string | null;
  updatedBy?: string | null;
  source?: string;
}

/**
 * 콘솔 관리자 (Kanidm IGA) — **셸 네이티브** 페이지(ADR-UI-003 §3.2 Core≠Plugin).
 * 콘솔 자체 기능(운영관리자 identity)이므로 DUPA plugin이 아니라 mainShell에 내장.
 * 백엔드 = console-core 서비스 `console-identity-api`(셸 nginx가 /api/identity 프록시). console==cli: `os identity …`.
 *
 * 사용자 라이프사이클: 생성(그룹 없이) → 온보딩 링크(Kanidm credential update intent)로 비번/패스키 설정 →
 * 활성/비활성 토글. 권한(그룹) 부여는 별도 역할 화면(/manage/roles)에서 수행한다(생성 시 자동 권한 부여 없음).
 */
@Component({
  selector: 'os-console-admins',
  imports: [ClarityModule, FormsModule, RouterLink, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef, OsPanel],
  template: `
    <div class="os-page">
      <os-page-header title="콘솔 관리자" tag="Kanidm IGA · 내장(core-native)" />
      @if (down(); as d) {
      <os-backend-unavailable
        feature="콘솔 관리자"
        backend="console-identity-api (Kanidm IGA)"
        hint="console-identity-api 배포 · Kanidm 시크릿(opensphere-identity-kanidm) 확인 시 자동 복구됩니다."
        [detail]="d"
      />
    } @else {
    <p class="os-sub">
      콘솔 운영관리자 = Kanidm 사용자/그룹. 셸 네이티브 — DUPA plugin 아님(ADR-UI-003 §3.2).
      @if (meta(); as mt) {
        · realm <code>{{ mt.realm }}</code> · idp {{ mt.idp }} · write {{ mt.writeEnabled ? 'on' : 'off' }}
      }
    </p>

    @if (msg(); as m) {
      <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)">
        <clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item>
      </clr-alert>
    }

    <section class="policy-card" aria-labelledby="auth-policy-title">
      <div>
        <h2 id="auth-policy-title">Console 로그인 보안</h2>
        <p class="os-sub">
          개발 환경 기본값은 비밀번호 로그인입니다. 운영 전환 시 TOTP를 활성화하면 이후 로그인과 신규 온보딩에 인증 앱 코드가 필수입니다.
        </p>
        @if (authPolicy(); as policy) {
          <p class="os-mono">
            environment={{ policy.environment }} · source={{ policy.source || 'configmap' }}
            @if (policy.updatedAt) { · updated {{ policy.updatedAt }} by {{ policy.updatedBy || 'unknown' }} }
          </p>
        }
      </div>
      <div class="policy-controls">
        <clr-input-container>
          <label>정책 변경 사유</label>
          <input clrInput [(ngModel)]="policyReason" name="policy-reason" maxlength="240" />
          <clr-control-helper>영구 감사에 기록됩니다(8자 이상).</clr-control-helper>
        </clr-input-container>
        <clr-toggle-wrapper>
          <input
          type="checkbox" clrToggle
          [checked]="authPolicy()?.totpEnabled === true"
          [disabled]="policyBusy() || !authPolicy() || authPolicy()?.enforced === true || policyReason.trim().length < 8"
          (change)="setTotpEnabled($any($event.target).checked)"
          />
          <label>
          <strong>TOTP 로그인 활성화</strong>
          @if (authPolicy()?.enforced) {
            <small>운영 환경 — 강제 활성(관리자가 끌 수 없음)</small>
          } @else {
            <small>{{ authPolicy()?.totpEnabled ? '활성 — 인증 앱 코드 필수' : '비활성 — 개발용 비밀번호 로그인' }}</small>
          }
          </label>
        </clr-toggle-wrapper>
      </div>
      <p class="policy-warning">
        기존에 TOTP가 등록된 계정은 잠금 방지를 위해 등록된 코드를 계속 요구할 수 있습니다. 비밀번호 전용으로 바꾸려면 비활성 상태에서 해당 계정을 재온보딩하세요.
      </p>
    </section>

    <div class="users-head">
      <h2>사용자 <span class="os-engine">({{ users().length }})</span></h2>
      <button class="btn btn-sm btn-primary" (click)="openCreate()">사용자 생성</button>
    </div>
    <os-datagrid [columns]="userCols" [rows]="users()" empty="사용자 조회 중…">
      <ng-template osCell="username" let-u><strong>{{ u.username }}</strong></ng-template>
      <ng-template osCell="displayName" let-u>{{ u.displayName || '—' }}</ng-template>
      <ng-template osCell="email" let-u>{{ u.email || '—' }}</ng-template>
      <ng-template osCell="status" let-u>
        @if (u.enabled) { <span class="label label-success">활성</span> } @else { <span class="label">비활성</span> }
      </ng-template>
      <ng-template osCell="groups" let-u>
        @for (g of u.groups; track g) { <span class="label label-info">{{ g }}</span> } @empty { <span class="os-sub">—</span> }
      </ng-template>
      <ng-template osCell="actions" let-u>
        <button class="btn btn-sm btn-outline" (click)="openDetail(u)" [disabled]="busy()">관리</button>
      </ng-template>
    </os-datagrid>

    <p class="os-sub">계정·역할·정책 변경 이력은 <a routerLink="/manage/audit">감사 로그</a> 화면에서 전역으로 조회합니다.</p>
      }

      <!-- 우측 슬라이딩 패널 — 사용자 생성 / 온보딩 링크 (인라인 폼 대신 공용 os-panel) -->
      <os-panel
        [open]="panelOpen()"
        [title]="panelMode() === 'create' ? '사용자 생성' : panelMode() === 'detail' ? (selectedUser()?.username || '사용자 관리') : '온보딩 링크'"
        [subtitle]="panelMode() === 'detail' ? '역할·활성·온보딩·이력' : 'Kanidm IGA · 신규 계정은 그룹 없이 생성'"
        (closed)="closePanel()"
      >
        @if (panelMode() === 'create') {
          <p class="os-sub">
            역할을 선택하면 생성과 동시에 부여됩니다(콘솔 역할만). 선택하지 않으면 <strong>권한 없이</strong> 생성되고
            역할은 나중에 <code>역할</code> 화면에서 부여할 수 있습니다. 생성 후 온보딩 링크를 당사자에게 전달하세요.
          </p>
          <form clrForm clrLayout="vertical">
            <clr-input-container>
              <label>사용자명</label>
              <input clrInput [(ngModel)]="draft.username" name="c-username" placeholder="예: hchoi" [disabled]="busy()" maxlength="63" />
            </clr-input-container>
            <clr-input-container>
              <label>표시이름</label>
              <input clrInput [(ngModel)]="draft.displayName" name="c-display" placeholder="예: Hwa Sung Choi" [disabled]="busy()" maxlength="120" />
            </clr-input-container>
            <clr-input-container>
              <label>이메일 (선택)</label>
              <input clrInput type="email" [(ngModel)]="draft.email" name="c-email" placeholder="예: hchoi@triangles.co.kr" [disabled]="busy()" maxlength="200" />
            </clr-input-container>
            <clr-checkbox-container>
              <label>역할 (선택 — 생성 시 부여)</label>
              @for (r of consoleRoles; track r.group) {
                <clr-checkbox-wrapper>
                  <input type="checkbox" clrCheckbox [name]="'role-' + r.group" [(ngModel)]="roleSel[r.group]" [disabled]="busy()" />
                  <label>{{ r.label }}@if (r.admin) { <span class="role-admin-tag">· 강조 감사</span> }</label>
                </clr-checkbox-wrapper>
              }
            </clr-checkbox-container>
            <clr-input-container>
              <label>사유 (IGA 필수)</label>
              <input clrInput [(ngModel)]="draft.reason" name="c-reason" placeholder="생성 사유" [disabled]="busy()" maxlength="200" (keyup.enter)="createUser()" />
            </clr-input-container>
          </form>
          <div class="panel-actions">
            <button class="btn btn-primary" (click)="createUser()" [disabled]="busy() || !draft.username.trim() || !draft.displayName.trim() || !draft.reason.trim()">계정 생성</button>
            <button class="btn btn-outline" (click)="closePanel()" [disabled]="busy()">닫기</button>
          </div>
        }

        @if (panelMode() === 'detail' && selectedUser(); as u) {
          <div class="detail-info">
            <div>
              <strong>{{ u.username }}</strong>
              @if (u.enabled) { <span class="label label-success">활성</span> } @else { <span class="label">비활성</span> }
            </div>
          </div>

          <h4 class="detail-h">속성</h4>
          <form clrForm clrLayout="vertical">
            <clr-input-container>
              <label>표시이름</label>
              <input clrInput [(ngModel)]="detailAttrs.displayName" name="d-display" [disabled]="busy()" maxlength="120" />
            </clr-input-container>
            <clr-input-container>
              <label>이메일 (비우면 제거)</label>
              <input clrInput type="email" [(ngModel)]="detailAttrs.email" name="d-email" [disabled]="busy()" maxlength="200" placeholder="예: hchoi@triangles.co.kr" />
            </clr-input-container>
          </form>
          <div class="panel-actions">
            <button class="btn btn-sm btn-primary" (click)="saveAttrs(u)" [disabled]="busy() || !detailAttrs.displayName.trim()">속성 저장</button>
          </div>

          <h4 class="detail-h">역할</h4>
          <form clrForm clrLayout="vertical">
            <clr-checkbox-container>
              @for (r of consoleRoles; track r.group) {
                <clr-checkbox-wrapper>
                  <input type="checkbox" clrCheckbox [name]="'d-role-' + r.group" [(ngModel)]="detailRoleSel[r.group]" [disabled]="busy()" />
                  <label>{{ r.label }}@if (r.admin) { <span class="role-admin-tag">· 강조 감사</span> }</label>
                </clr-checkbox-wrapper>
              }
            </clr-checkbox-container>
          </form>
          <div class="panel-actions">
            <button class="btn btn-sm btn-primary" (click)="saveRoles(u)" [disabled]="busy()">역할 저장</button>
            @if (u.enabled) {
              <button class="btn btn-sm btn-danger-outline" (click)="setEnabled(u, false)" [disabled]="busy()">비활성</button>
            } @else {
              <button class="btn btn-sm btn-outline" (click)="setEnabled(u, true)" [disabled]="busy()">활성</button>
            }
            <button class="btn btn-sm btn-link" (click)="regenOnboarding(u)" [disabled]="busy()">온보딩 링크</button>
          </div>

          <h4 class="detail-h">최근 이력 <span class="os-engine">(이 사용자)</span></h4>
          <clr-datagrid [clrDgLoading]="auditBusy()">
            <clr-dg-column>시각</clr-dg-column>
            <clr-dg-column>행위자</clr-dg-column>
            <clr-dg-column>동작</clr-dg-column>
            <clr-dg-column>결과</clr-dg-column>
            @for (e of userAudit(); track $index) {
              <clr-dg-row>
                <clr-dg-cell><span class="os-mono">{{ e.time }}</span></clr-dg-cell>
                <clr-dg-cell>{{ e.actor }}</clr-dg-cell>
                <clr-dg-cell><code>{{ e.action }}</code></clr-dg-cell>
                <clr-dg-cell>{{ e.result }}</clr-dg-cell>
              </clr-dg-row>
            }
            <clr-dg-placeholder>이 사용자 관련 이력이 없습니다</clr-dg-placeholder>
            <clr-dg-footer><a routerLink="/manage/audit" (click)="closePanel()">전체 감사 로그 →</a></clr-dg-footer>
          </clr-datagrid>

          <div class="panel-actions">
            <button class="btn btn-outline" (click)="closePanel()">닫기</button>
          </div>
        }

        @if (onboarding(); as ob) {
          <div class="onboard-box">
            <div><strong>{{ ob.username }}</strong> 온보딩 링크 — 당사자에게 전달하세요(만료 전 1회 설정).</div>
            @if (ob.url) {
              <pre class="link">{{ ob.url }}</pre>
              <div class="onboard-actions">
                <button class="btn btn-sm btn-primary" (click)="copy(ob.url)">링크 복사</button>
                @if (copied()) { <span class="copied">복사됨 ✓</span> }
              </div>
            } @else {
              <div class="warn">온보딩 링크를 발급하지 못했습니다(Kanidm credential intent 실패). 다시 시도하거나 재발급하세요.</div>
            }
          </div>
        }
      </os-panel>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub { color: var(--os-muted); font-size: 0.7rem; margin: 0.3rem 0 0.8rem; }
      .os-engine { font-size: 0.6rem; color: var(--os-muted); font-weight: 400; margin-left: 0.4rem; }
      .os-mono { font-family: monospace; font-size: 0.62rem; color: var(--os-muted); }
      .table .left { text-align: left; }
      .label { margin: 0 0.25rem 0.25rem 0; }
      .policy-card { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.7rem 1.4rem; align-items:center; border:1px solid var(--os-hairline); border-radius:.25rem; padding:1rem 1.2rem; margin:1rem 0 1.4rem; background:var(--os-canvas); }
      .policy-card h2 { margin:0 0 .25rem; }
      .policy-toggle { display:flex; align-items:center; gap:.6rem; cursor:pointer; min-width:14rem; }
      .policy-toggle input { width:1.1rem; height:1.1rem; }
      .policy-toggle span { display:flex; flex-direction:column; gap:.15rem; }
      .policy-toggle small { color:var(--os-muted); }
      .policy-warning { grid-column:1/-1; margin:0; color:var(--os-ink-muted); font-size:.68rem; }
      .users-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin:1.2rem 0 .3rem; }
      .users-head h2 { margin:0; }
      .panel-actions { display:flex; gap:.5rem; align-items:center; margin-top:.6rem; }
      .role-admin-tag { color:var(--os-ink-subtle); font-size:.62rem; }
      .detail-info { margin-bottom:.6rem; }
      .detail-h { font-size:.8rem; margin:1.1rem 0 .3rem; color:var(--os-ink); }
      .onboard-box { margin-top:.8rem; padding:.7rem .8rem; border:1px dashed var(--os-hairline); border-radius:.25rem; display:flex; flex-direction:column; gap:.4rem; }
      .onboard-box .link { background:var(--os-surface-1); color:var(--os-ink); font-family:var(--os-font-mono, monospace); padding:.5rem .6rem; border-radius:3px; font-size:.7rem; white-space:pre-wrap; word-break:break-all; margin:0; }
      .onboard-actions { display:flex; gap:.4rem; align-items:center; }
      .onboard-box .warn { color:var(--os-error); font-size:.72rem; }
      .copied { color:var(--os-success); font-size:.72rem; }
      @media (max-width: 760px) { .policy-card { grid-template-columns:1fr; } }
    `,
  ],
})
export class ConsoleAdmins implements OnInit {
  readonly userCols: OsColumn[] = [
    { key: 'username', label: '사용자명' },
    { key: 'displayName', label: '표시이름' },
    { key: 'email', label: '이메일' },
    { key: 'status', label: '상태' },
    { key: 'groups', label: '그룹' },
    { key: 'actions', label: '동작' },
  ];
  readonly users = signal<IdUser[]>([]);
  readonly meta = signal<IdMeta | null>(null);
  readonly authPolicy = signal<AuthPolicy | null>(null);
  readonly policyBusy = signal(false);
  readonly busy = signal(false);
  readonly copied = signal(false);
  readonly onboarding = signal<{ username: string; url: string } | null>(null);
  readonly panelOpen = signal(false);
  readonly panelMode = signal<'create' | 'link' | 'detail'>('create');
  readonly selectedUser = signal<IdUser | null>(null);
  readonly userAudit = signal<AuditEvent[]>([]);
  readonly auditBusy = signal(false);
  detailRoleSel: Record<string, boolean> = {};
  detailAttrs = { displayName: '', email: '' };
  readonly down = signal<string>(''); // 백엔드 미배포/불건전 → graceful degradation
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  // 생성 시 선택 가능한 콘솔 역할(백엔드 CONSOLE_ROLE_GROUPS allowlist와 일치). admin은 강조 감사.
  readonly consoleRoles: { group: string; label: string; admin: boolean }[] = [
    { group: 'opensphere-console-admins', label: '관리자 (Admin)', admin: true },
    { group: 'opensphere-console-operators', label: '운영자 (Operator)', admin: false },
    { group: 'opensphere-console-viewers', label: '뷰어 (Viewer)', admin: false },
  ];
  roleSel: Record<string, boolean> = {};
  policyReason = '';
  draft = { username: '', displayName: '', email: '', reason: '' };

  private auth = inject(AuthService);
  private http = inject(HttpService);
  // 감사 B: /api/identity 읽기도 인증 필수 → 검증된 id_token(Bearer) 첨부.
  private authGet(): RequestInit {
    return { cache: 'no-store', headers: { authorization: 'Bearer ' + (this.auth.token() || '') } };
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadIdentity(), this.loadAuthPolicy()]);
  }

  private originLink(path: string): string {
    return path ? window.location.origin + path : '';
  }

  openCreate(): void {
    this.draft = { username: '', displayName: '', email: '', reason: '' };
    this.roleSel = {};
    this.onboarding.set(null);
    this.panelMode.set('create');
    this.panelOpen.set(true);
  }

  closePanel(): void {
    this.panelOpen.set(false);
    this.onboarding.set(null);
    this.selectedUser.set(null);
    this.userAudit.set([]);
  }

  // 사용자 행 "관리" → 상세 패널(역할 편집 + 활성/온보딩 + 이 사용자 문맥 감사).
  openDetail(u: IdUser): void {
    this.selectedUser.set(u);
    this.syncDetailRoleSel(u);
    this.detailAttrs = { displayName: u.displayName ?? '', email: u.email ?? '' };
    this.onboarding.set(null);
    this.userAudit.set([]);
    this.msg.set(null);
    this.panelMode.set('detail');
    this.panelOpen.set(true);
    void this.loadUserAudit(u.username);
  }

  private syncDetailRoleSel(u: IdUser): void {
    const sel: Record<string, boolean> = {};
    for (const r of this.consoleRoles) sel[r.group] = (u.groups ?? []).includes(r.group);
    this.detailRoleSel = sel;
  }

  // 전역 감사에서 이 사용자 관련(대상 또는 행위자) 이벤트만 문맥 슬라이스로 필터(클라이언트 측, 최근 500건 기준).
  private async loadUserAudit(username: string): Promise<void> {
    this.auditBusy.set(true);
    try {
      const r = await this.http.request('/api/admin/plugins/events');
      if (!r.ok) return;
      const j = (await r.json()) as { items?: AuditEvent[] };
      const items = Array.isArray(j.items) ? j.items : [];
      this.userAudit.set(items.filter((e) => (e.target ?? '').includes(username) || e.actor === username).slice(0, 50));
    } catch {
      /* 문맥 감사 best-effort */
    } finally {
      this.auditBusy.set(false);
    }
  }

  async saveAttrs(u: IdUser): Promise<void> {
    const displayName = this.detailAttrs.displayName.trim();
    const email = this.detailAttrs.email.trim();
    if (!displayName) return;
    if (displayName === (u.displayName ?? '') && email === (u.email ?? '')) { this.msg.set({ type: 'info', text: '속성 변경 사항이 없습니다.' }); return; }
    const reason = prompt(`${u.username} 속성 변경 사유 (IGA 필수):`);
    if (!reason || !reason.trim()) return;
    this.busy.set(true);
    this.msg.set(null);
    try {
      const r = await this.http.request(`/api/identity/users/${u.id}/attrs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, email, reason: reason.trim() }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) { this.msg.set({ type: 'danger', text: `속성 저장 실패: ${body.error || 'HTTP ' + r.status}` }); return; }
      this.msg.set({ type: 'success', text: `${u.username} 속성을 갱신했습니다.` });
      await this.loadIdentity();
      const fresh = this.selectedUser();
      if (fresh) this.detailAttrs = { displayName: fresh.displayName ?? '', email: fresh.email ?? '' };
    } catch (e) {
      this.msg.set({ type: 'danger', text: `속성 저장 실패: ${e}` });
    } finally {
      this.busy.set(false);
    }
  }

  async saveRoles(u: IdUser): Promise<void> {
    const desired = this.consoleRoles.filter((r) => this.detailRoleSel[r.group]).map((r) => r.group);
    const current = this.consoleRoles.filter((r) => (u.groups ?? []).includes(r.group)).map((r) => r.group);
    const toAdd = desired.filter((g) => !current.includes(g));
    const toRemove = current.filter((g) => !desired.includes(g));
    if (!toAdd.length && !toRemove.length) { this.msg.set({ type: 'info', text: '역할 변경 사항이 없습니다.' }); return; }
    const reason = prompt(`${u.username} 역할 변경 사유 (IGA 필수):`);
    if (!reason || !reason.trim()) return;
    this.busy.set(true);
    this.msg.set(null);
    try {
      for (const g of toAdd) await this.groupChange(u.id, g, 'add', reason.trim());
      for (const g of toRemove) await this.groupChange(u.id, g, 'remove', reason.trim());
      this.msg.set({ type: 'success', text: `${u.username} 역할을 갱신했습니다.` });
      await this.loadIdentity();
      const fresh = this.selectedUser();
      if (fresh) this.syncDetailRoleSel(fresh);
    } catch (e) {
      this.msg.set({ type: 'danger', text: `역할 저장 실패: ${e}` });
    } finally {
      this.busy.set(false);
    }
  }

  private async groupChange(userId: string, group: string, op: 'add' | 'remove', reason: string): Promise<void> {
    const r = await this.http.request(`/api/identity/users/${userId}/group`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group, op, reason }),
    });
    if (!r.ok) { const b = (await r.json().catch(() => ({}))) as { error?: string }; throw new Error(b.error || `HTTP ${r.status}`); }
  }

  async createUser(): Promise<void> {
    const { username, displayName, email, reason } = this.draft;
    if (!username.trim() || !displayName.trim() || !reason.trim() || this.busy()) return;
    const roles = this.consoleRoles.filter((r) => this.roleSel[r.group]).map((r) => r.group);
    this.busy.set(true);
    this.msg.set(null);
    try {
      const r = await this.http.request('/api/identity/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), displayName: displayName.trim(), email: email.trim(), reason: reason.trim(), roles }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) { this.msg.set({ type: 'danger', text: '계정 생성에는 관리자 권한이 필요합니다.' }); return; }
      if (!r.ok) { this.msg.set({ type: 'danger', text: `계정 생성 실패: ${body.error || 'HTTP ' + r.status}` }); return; }
      // 성공 — 패널은 열어둔 채 온보딩 링크를 표시(관리자가 복사 후 닫음).
      this.onboarding.set({ username: body.username, url: this.originLink(body.onboardingPath || '') });
      const rolesTxt = Array.isArray(body.roles) && body.roles.length ? ` · 역할: ${body.roles.join(', ')}` : '';
      this.msg.set({ type: 'success', text: `${body.username} 계정을 생성했습니다${rolesTxt}. 온보딩 링크를 전달하세요.` });
      this.draft = { username: '', displayName: '', email: '', reason: '' };
      this.roleSel = {};
      await this.loadIdentity();
    } catch (e) {
      this.msg.set({ type: 'danger', text: '계정 생성 실패: ' + e });
    } finally {
      this.busy.set(false);
    }
  }

  async setEnabled(u: IdUser, enabled: boolean): Promise<void> {
    const reason = prompt(`${u.username} 계정을 ${enabled ? '활성' : '비활성'}화하는 사유 (IGA 필수):`);
    if (!reason || !reason.trim()) return;
    await this.userWrite(`/api/identity/users/${u.id}/enabled`, { enabled, reason: reason.trim() }, `${u.username} ${enabled ? '활성' : '비활성'}화`);
  }

  async regenOnboarding(u: IdUser): Promise<void> {
    const reason = prompt(`${u.username} 온보딩 링크를 재발급하는 사유 (IGA 필수):`);
    if (!reason || !reason.trim()) return;
    this.busy.set(true);
    this.msg.set(null);
    try {
      const r = await this.http.request(`/api/identity/users/${u.id}/onboarding`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { this.msg.set({ type: 'danger', text: `링크 재발급 실패: ${body.error || 'HTTP ' + r.status}` }); return; }
      // 재발급 결과도 우측 슬라이딩 패널(링크 모드)로 표시.
      this.onboarding.set({ username: body.username || u.username, url: this.originLink(body.onboardingPath || '') });
      this.panelMode.set('link');
      this.panelOpen.set(true);
      this.msg.set({ type: 'success', text: `${u.username} 온보딩 링크를 재발급했습니다.` });
    } catch (e) {
      this.msg.set({ type: 'danger', text: '링크 재발급 실패: ' + e });
    } finally {
      this.busy.set(false);
    }
  }

  private async userWrite(path: string, payload: unknown, label: string): Promise<void> {
    this.busy.set(true);
    this.msg.set(null);
    try {
      const r = await this.http.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { this.msg.set({ type: 'danger', text: `${label} 실패: ${body.error || 'HTTP ' + r.status}` }); return; }
      this.msg.set({ type: 'success', text: `${label} 완료` });
      await this.loadIdentity();
    } catch (e) {
      this.msg.set({ type: 'danger', text: `${label} 실패: ` + e });
    } finally {
      this.busy.set(false);
    }
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      window.setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.msg.set({ type: 'danger', text: '클립보드 복사 실패 — 수동으로 선택해 복사하세요.' });
    }
  }

  async setTotpEnabled(enabled: boolean): Promise<void> {
    const previous = this.authPolicy();
    const reason = this.policyReason.trim();
    if (reason.length < 8) {
      this.authPolicy.set(previous);
      this.msg.set({ type: 'danger', text: '정책 변경 사유를 8자 이상 입력하세요.' });
      return;
    }
    this.policyBusy.set(true);
    try {
      const r = await this.http.request('/bff/auth-policy', {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer ' + (this.auth.token() || ''),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ totpEnabled: enabled, reason }),
      });
      if (r.status === 403) {
        this.authPolicy.set(previous);
        this.msg.set({ type: 'danger', text: '운영 환경에서는 TOTP를 비활성화할 수 없습니다(강제).' });
        return;
      }
      if (!r.ok) throw new Error(`auth policy HTTP ${r.status}`);
      this.authPolicy.set(await r.json());
      this.policyReason = '';
      this.msg.set({
        type: 'success',
        text: enabled ? 'TOTP 로그인을 활성화했습니다. TOTP 미등록 계정은 재온보딩이 필요합니다.' : '개발용 비밀번호 로그인을 활성화했습니다.',
      });
    } catch (error) {
      this.authPolicy.set(previous);
      this.msg.set({ type: 'danger', text: 'TOTP 정책 변경 실패: ' + error });
    } finally {
      this.policyBusy.set(false);
    }
  }

  private async loadIdentity(): Promise<void> {
    try {
      const r = await this.http.request('/api/identity', this.authGet());
      if (!r.ok) {
        this.down.set(`identity HTTP ${r.status}`);
        return;
      }
      const d = await r.json();
      this.meta.set(d.meta ?? null);
      this.users.set(d.users ?? []);
      // 상세 패널이 열려 있으면 갱신된 목록으로 선택 사용자 재동기화(활성/역할 변경 반영).
      const sel = this.selectedUser();
      if (sel) {
        const fresh = (d.users ?? []).find((u: IdUser) => u.username === sel.username);
        if (fresh) this.selectedUser.set(fresh);
      }
    } catch (e) {
      this.down.set('조회 실패: ' + e);
    }
  }

  private async loadAuthPolicy(): Promise<void> {
    try {
      const r = await this.http.request('/bff/auth-policy', this.authGet());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.authPolicy.set(await r.json());
    } catch (error) {
      this.msg.set({ type: 'danger', text: 'TOTP 정책 조회 실패: ' + error });
    }
  }
}
