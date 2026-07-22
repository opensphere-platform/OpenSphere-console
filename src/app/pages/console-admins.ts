import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsActionDialog } from '../os/os-action-dialog';
import { OsCellDef, OsColumn, OsDatagrid } from '../os/os-datagrid';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';

interface IdUser { id: string; username: string; email: string; enabled: boolean; displayName: string; groups: string[] }
interface AuditEvent { time?: string; actor?: string; action?: string; target?: string; result?: string }

/** Supabase Auth users projected through the Console's operator/role boundary. */
@Component({
  selector: 'os-console-admins',
  imports: [ClarityModule, FormsModule, RouterLink, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef, OsPanel, OsActionDialog],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="콘솔 관리자" tag="Supabase Auth · Console-native" />
      @if (down(); as detail) {
        <os-backend-unavailable feature="콘솔 관리자" backend="opensphere-console-backend (/api/identity)" hint="Supabase Auth·PostgREST와 Console backend 상태를 확인하세요." [detail]="detail" />
      } @else {
        <div class="manage-page-lead"><p>사용자 자격 증명은 Supabase Auth가, Console 역할은 <code>console.operator_role</code>이 소유합니다. 변경은 append-only 감사에 기록됩니다.</p><span>권위: Supabase Auth</span></div>
        <section class="manage-status-rail" aria-label="Console 관리자 상태">
          <div><span>Identities</span><strong>{{ users().length }}</strong><small>Console 운영자 범위</small></div>
          <div><span>Active</span><strong class="ok">{{ activeUsers() }}</strong><small>로그인 허용</small></div>
          <div><span>Disabled</span><strong [class.warn]="disabledUsers() > 0">{{ disabledUsers() }}</strong><small>세션 차단 대상</small></div>
          <div><span>Administrators</span><strong>{{ roleMemberCount('console-admins') }}</strong><small>고권한 역할</small></div>
          <div><span>Role contracts</span><strong>{{ consoleRoles.length }}</strong><small>Supabase RLS 평가</small></div>
        </section>
        @if (msg(); as item) { <clr-alert [clrAlertType]="item.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)"><clr-alert-item><span class="alert-text">{{ item.text }}</span></clr-alert-item></clr-alert> }
        <div class="manage-toolbar"><div class="manage-toolbar-copy"><strong>사용자 관리</strong><small>계정·프로필·역할 변경에는 감사 사유가 필요합니다.</small></div><div class="manage-toolbar-group"><button class="btn btn-sm btn-outline" [disabled]="loading()" (click)="loadIdentity()">새로고침</button><button class="btn btn-sm btn-primary" (click)="openCreate()">사용자 생성</button></div></div>
        <os-datagrid [columns]="userCols" [rows]="users()" [loading]="loading()" empty="등록된 사용자가 없습니다">
          <ng-template osCell="username" let-user><strong>{{ user.username }}</strong></ng-template><ng-template osCell="displayName" let-user>{{ user.displayName || '—' }}</ng-template><ng-template osCell="email" let-user>{{ user.email || '—' }}</ng-template>
          <ng-template osCell="status" let-user><span class="label" [class.label-success]="user.enabled">{{ user.enabled ? '활성' : '비활성' }}</span></ng-template>
          <ng-template osCell="roles" let-user>@for (role of user.groups; track role) { <span class="label label-info">{{ role }}</span> } @empty { <span class="os-sub">—</span> }</ng-template>
          <ng-template osCell="actions" let-user><button class="btn btn-sm btn-outline" (click)="openDetail(user)" [disabled]="busy()">관리</button></ng-template>
        </os-datagrid>
        <p class="os-sub">역할의 일괄 관리는 <a routerLink="/manage/roles">역할</a>, 전체 변경 이력은 <a routerLink="/manage/audit">감사 로그</a>에서 확인합니다.</p>
      }

      <os-panel [open]="panelOpen()" [title]="panelMode() === 'create' ? '사용자 생성' : (selectedUser()?.username || '사용자 관리')" [subtitle]="'Supabase Auth · Console roles'" (closed)="closePanel()">
        @if (panelMode() === 'create') {
          <p class="os-sub">Supabase Auth 계정을 만들고 선택한 Console 역할을 부여합니다. 회복 링크는 비밀번호 설정을 위해 한 번만 사용합니다.</p>
          <form clrForm clrLayout="vertical">
            <clr-input-container><label>사용자명</label><input clrInput [(ngModel)]="draft.username" name="username" [disabled]="busy()" maxlength="63"></clr-input-container>
            <clr-input-container><label>표시이름</label><input clrInput [(ngModel)]="draft.displayName" name="displayName" [disabled]="busy()" maxlength="120"></clr-input-container>
            <clr-input-container><label>이메일</label><input clrInput type="email" [(ngModel)]="draft.email" name="email" [disabled]="busy()" maxlength="200" required></clr-input-container>
            <clr-checkbox-container><label>역할 (선택)</label>@for (role of consoleRoles; track role.group) { <clr-checkbox-wrapper><input type="checkbox" clrCheckbox [name]="'role-' + role.group" [(ngModel)]="roleSelection[role.group]" [disabled]="busy()"><label>{{ role.label }}</label></clr-checkbox-wrapper> }</clr-checkbox-container>
            <clr-input-container><label>사유</label><input clrInput [(ngModel)]="draft.reason" name="reason" [disabled]="busy()" maxlength="200"></clr-input-container>
          </form>
          <div class="panel-actions"><button class="btn btn-primary" (click)="createUser()" [disabled]="busy() || !validDraft()">계정 생성</button><button class="btn btn-outline" (click)="closePanel()">닫기</button></div>
        }
        @if (panelMode() === 'detail' && selectedUser(); as user) {
          <h4 class="detail-h">속성</h4><form clrForm clrLayout="vertical"><clr-input-container><label>표시이름</label><input clrInput [(ngModel)]="attrs.displayName" name="edit-name" [disabled]="busy()"></clr-input-container><clr-input-container><label>이메일</label><input clrInput type="email" [(ngModel)]="attrs.email" name="edit-email" [disabled]="busy()"></clr-input-container></form>
          <div class="panel-actions"><button class="btn btn-sm btn-primary" (click)="saveAttrs(user)" [disabled]="busy() || !attrs.displayName.trim()">속성 저장</button><button class="btn btn-sm" [class.btn-danger-outline]="user.enabled" [class.btn-outline]="!user.enabled" (click)="setEnabled(user, !user.enabled)" [disabled]="busy()">{{ user.enabled ? '비활성' : '활성' }}</button><button class="btn btn-sm btn-link" (click)="recovery(user)" [disabled]="busy()">회복 링크</button></div>
          <h4 class="detail-h">역할</h4><clr-checkbox-container>@for (role of consoleRoles; track role.group) { <clr-checkbox-wrapper><input type="checkbox" clrCheckbox [name]="'edit-role-' + role.group" [(ngModel)]="roleSelection[role.group]" [disabled]="busy()"><label>{{ role.label }}</label></clr-checkbox-wrapper> }</clr-checkbox-container>
          <div class="panel-actions"><button class="btn btn-sm btn-primary" (click)="saveRoles(user)" [disabled]="busy()">역할 저장</button></div>
          <h4 class="detail-h">최근 이력</h4><clr-datagrid [clrDgLoading]="auditBusy()"><clr-dg-column>시각</clr-dg-column><clr-dg-column>행위자</clr-dg-column><clr-dg-column>동작</clr-dg-column><clr-dg-column>결과</clr-dg-column>@for (event of userAudit(); track $index) { <clr-dg-row><clr-dg-cell>{{ event.time }}</clr-dg-cell><clr-dg-cell>{{ event.actor }}</clr-dg-cell><clr-dg-cell><code>{{ event.action }}</code></clr-dg-cell><clr-dg-cell>{{ event.result }}</clr-dg-cell></clr-dg-row> }<clr-dg-placeholder>관련 이력이 없습니다.</clr-dg-placeholder></clr-datagrid>
          <div class="panel-actions"><button class="btn btn-outline" (click)="closePanel()">닫기</button></div>
        }
        @if (recoveryUrl(); as recovery) { <div class="recovery"><strong>회복 링크</strong><pre>{{ recovery }}</pre><button class="btn btn-sm btn-primary" (click)="copy(recovery)">링크 복사</button></div> }
      </os-panel>
      <os-action-dialog [open]="reasonOpen()" [title]="reasonTitle()" [message]="reasonMessage()" [confirmLabel]="reasonConfirm()" [danger]="reasonDanger()" [busy]="busy()" [reasonRequired]="true" (confirmed)="confirmReason($event)" (cancelled)="closeReason()" />
    </div>
  `,
  styles: [`
    .os-sub{color:var(--os-muted);font-size:.7rem;margin:.3rem 0 .8rem}.os-engine{font-size:.6rem;color:var(--os-muted)}.detail-h{font-size:.8rem;margin:1.1rem 0 .3rem}.panel-actions{display:flex;gap:.5rem;align-items:center;margin-top:.6rem}.label{margin:0 .25rem .25rem 0}.recovery{margin-top:.8rem;padding:.7rem;border:1px dashed var(--os-hairline)}.recovery pre{white-space:pre-wrap;word-break:break-all;font-size:.68rem}
  `],
})
export class ConsoleAdmins implements OnInit {
  private readonly http = inject(HttpService);
  readonly userCols: OsColumn[] = [{ key: 'username', label: '사용자명' }, { key: 'displayName', label: '표시이름' }, { key: 'email', label: '이메일' }, { key: 'status', label: '상태' }, { key: 'roles', label: '역할' }, { key: 'actions', label: '동작' }];
  readonly users = signal<IdUser[]>([]); readonly loading = signal(true); readonly busy = signal(false); readonly down = signal(''); readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  readonly panelOpen = signal(false); readonly panelMode = signal<'create' | 'detail'>('create'); readonly selectedUser = signal<IdUser | null>(null); readonly recoveryUrl = signal(''); readonly userAudit = signal<AuditEvent[]>([]); readonly auditBusy = signal(false);
  readonly reasonOpen = signal(false); readonly reasonTitle = signal('변경 확인'); readonly reasonMessage = signal(''); readonly reasonConfirm = signal('적용'); readonly reasonDanger = signal(false);
  readonly consoleRoles = [{ group: 'console-admins', label: '관리자' }, { group: 'console-operators', label: '운영자' }, { group: 'console-viewers', label: '뷰어' }];
  draft = { username: '', displayName: '', email: '', reason: '' }; attrs = { displayName: '', email: '' }; roleSelection: Record<string, boolean> = {};
  private pendingAction: ((reason: string) => Promise<void>) | null = null;

  async ngOnInit(): Promise<void> { await this.loadIdentity(); }
  validDraft(): boolean { return !!this.draft.username.trim() && !!this.draft.displayName.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.draft.email.trim()) && this.draft.reason.trim().length >= 8; }
  openCreate(): void { this.draft = { username: '', displayName: '', email: '', reason: '' }; this.roleSelection = {}; this.recoveryUrl.set(''); this.panelMode.set('create'); this.panelOpen.set(true); }
  openDetail(user: IdUser): void { this.selectedUser.set(user); this.attrs = { displayName: user.displayName, email: user.email }; this.roleSelection = Object.fromEntries(this.consoleRoles.map((role) => [role.group, user.groups.includes(role.group)])); this.recoveryUrl.set(''); this.panelMode.set('detail'); this.panelOpen.set(true); void this.loadAudit(user); }
  closePanel(): void { this.panelOpen.set(false); this.selectedUser.set(null); this.recoveryUrl.set(''); }

  activeUsers(): number { return this.users().filter((user) => user.enabled).length; }
  disabledUsers(): number { return this.users().filter((user) => !user.enabled).length; }
  roleMemberCount(role: string): number { return this.users().filter((user) => user.groups.includes(role)).length; }

  async loadIdentity(): Promise<void> {
    this.loading.set(true); this.down.set('');
    try {
      const response = await this.http.request('/api/identity');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { users?: Array<Omit<IdUser, 'groups'> & { groups?: unknown[] }> };
      this.users.set((body.users || []).map((user) => ({ ...user, groups: (user.groups || []).map((group) => typeof group === 'string' ? group : String((group as { name?: unknown })?.name || '')).filter(Boolean) })));
    } catch (error) { this.down.set(`Supabase identity 조회 실패: ${String(error)}`); }
    finally { this.loading.set(false); }
  }
  private openReason(title: string, message: string, confirm: string, danger: boolean, action: (reason: string) => Promise<void>): void { this.reasonTitle.set(title); this.reasonMessage.set(message); this.reasonConfirm.set(confirm); this.reasonDanger.set(danger); this.pendingAction = action; this.reasonOpen.set(true); }
  closeReason(): void { if (!this.busy()) { this.reasonOpen.set(false); this.pendingAction = null; } }
  async confirmReason(reason: string): Promise<void> { const action = this.pendingAction; if (!action) return; this.reasonOpen.set(false); this.pendingAction = null; await action(reason); }
  async createUser(): Promise<void> { if (!this.validDraft()) return; this.busy.set(true); try { const roles = this.consoleRoles.filter((role) => this.roleSelection[role.group]).map((role) => role.group); const response = await this.http.request('/api/identity/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...this.draft, username: this.draft.username.trim(), displayName: this.draft.displayName.trim(), email: this.draft.email.trim(), roles }) }); const body = await response.json().catch(() => ({})) as { error?: string; onboardingPath?: string }; if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); this.recoveryUrl.set(body.onboardingPath ? new URL(body.onboardingPath, window.location.origin).toString() : ''); this.msg.set({ type: 'success', text: 'Supabase Console 계정을 생성했습니다.' }); await this.loadIdentity(); } catch (error) { this.msg.set({ type: 'danger', text: `계정 생성 실패: ${String(error)}` }); } finally { this.busy.set(false); } }
  saveAttrs(user: IdUser): void { const displayName = this.attrs.displayName.trim(); const email = this.attrs.email.trim(); if (!displayName || !email) return; this.openReason('사용자 속성 변경', `${user.username} 사용자의 Supabase 프로필을 변경합니다.`, '저장', false, (reason) => this.write(`/api/identity/users/${user.id}/attrs`, { displayName, email, reason }, '속성을 갱신했습니다.')); }
  setEnabled(user: IdUser, enabled: boolean): void { this.openReason(`계정 ${enabled ? '활성화' : '비활성화'}`, `${user.username} 계정을 ${enabled ? '활성화' : '비활성화'}합니다.`, enabled ? '활성화' : '비활성화', !enabled, (reason) => this.write(`/api/identity/users/${user.id}/enabled`, { enabled, reason }, '계정 상태를 변경했습니다.')); }
  recovery(user: IdUser): void { this.openReason('회복 링크 발급', `${user.username}의 Supabase 비밀번호 회복 링크를 발급합니다.`, '발급', false, async (reason) => { const response = await this.http.request(`/api/identity/users/${user.id}/onboarding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }); const body = await response.json().catch(() => ({})) as { error?: string; onboardingPath?: string }; if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); this.recoveryUrl.set(body.onboardingPath ? new URL(body.onboardingPath, window.location.origin).toString() : ''); this.msg.set({ type: 'success', text: '회복 링크를 발급했습니다.' }); }); }
  saveRoles(user: IdUser): void { const desired = this.consoleRoles.filter((role) => this.roleSelection[role.group]).map((role) => role.group); const add = desired.filter((role) => !user.groups.includes(role)); const remove = user.groups.filter((role) => this.consoleRoles.some((candidate) => candidate.group === role) && !desired.includes(role)); if (!add.length && !remove.length) return; this.openReason('사용자 역할 변경', `${user.username}의 Supabase Console 역할을 변경합니다.`, '저장', true, async (reason) => { for (const group of add) await this.write(`/api/identity/users/${user.id}/group`, { op: 'add', group, reason }, '', false); for (const group of remove) await this.write(`/api/identity/users/${user.id}/group`, { op: 'remove', group, reason }, '', false); this.msg.set({ type: 'success', text: '역할을 갱신했습니다.' }); await this.loadIdentity(); }); }
  private async write(path: string, payload: unknown, success: string, refresh = true): Promise<void> { this.busy.set(true); try { const response = await this.http.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); const body = await response.json().catch(() => ({})) as { error?: string }; if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); if (success) this.msg.set({ type: 'success', text: success }); if (refresh) await this.loadIdentity(); } finally { this.busy.set(false); } }
  private async loadAudit(user: IdUser): Promise<void> { this.auditBusy.set(true); try { const response = await this.http.request('/api/identity/audit'); const body = await response.json().catch(() => ({})) as { items?: AuditEvent[] }; this.userAudit.set((body.items || []).filter((event) => (event.target || '').includes(user.id) || (event.target || '').includes(user.username) || event.actor === user.id).slice(0, 50)); } finally { this.auditBusy.set(false); } }
  async copy(value: string): Promise<void> { await navigator.clipboard.writeText(value).catch(() => this.msg.set({ type: 'danger', text: '클립보드 복사 실패' })); }
}
