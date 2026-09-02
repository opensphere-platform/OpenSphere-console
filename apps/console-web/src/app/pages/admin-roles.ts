import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsActionDialog } from '../os/os-action-dialog';
import { OsCellDef, OsColumn, OsDatagrid } from '../os/os-datagrid';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';

interface Role { group: string; label: string; desc: string; members: string[] }
interface IdentityUser { id: string; username: string; groups: { name: string }[] }
interface IdentityPayload { users?: IdentityUser[]; groups?: { name: string; description?: string }[] }

/** Supabase Console RBAC: console.role + console.operator_role, never a parallel IdP group. */
@Component({
  selector: 'os-admin-roles',
  imports: [ClarityModule, FormsModule, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef, OsPanel, OsActionDialog],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="역할" tag="Supabase Console RBAC">
        <p><code>console.role</code>과 <code>console.operator_role</code>이 Console 접근을 결정합니다. 모든 변경은 Supabase 감사 이벤트로 남습니다.</p>
      </os-page-header>
      @if (down(); as detail) {
        <os-backend-unavailable feature="Console 역할" backend="opensphere-console-backend (/api/identity)" hint="Supabase Auth·PostgREST와 Console backend 상태를 확인하세요." [detail]="detail" />
      } @else {
        <section class="manage-status-rail" aria-label="Console 역할 상태">
          <div><span>Role contracts</span><strong>{{ roles().length }}</strong><small>console.role 정본</small></div>
          <div><span>Assigned roles</span><strong>{{ assignedRoleCount() }}</strong><small>구성원이 있는 역할</small></div>
          <div><span>Total memberships</span><strong>{{ membershipCount() }}</strong><small>operator_role 연결</small></div>
          <div><span>Administrators</span><strong>{{ roleSize(adminGroup) }}</strong><small>고권한 구성원</small></div>
          <div><span>Audit authority</span><strong class="ok">Supabase</strong><small>append-only event</small></div>
        </section>
        @if (msg(); as item) { <clr-alert [clrAlertType]="item.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)"><clr-alert-item><span class="alert-text">{{ item.text }}</span></clr-alert-item></clr-alert> }
        <div class="manage-toolbar"><div class="manage-toolbar-copy"><strong>역할 구성</strong><small>부여·회수는 8자 이상의 감사 사유와 함께 기록됩니다.</small></div><button class="btn btn-sm btn-outline" [disabled]="busy()" (click)="refresh()">새로고침</button></div>
        <os-datagrid [columns]="roleCols" [rows]="roles()" empty="Supabase 역할 조회 중…">
          <ng-template osCell="role" let-role><strong>{{ role.label }}</strong><br><span class="os-mono">{{ role.group }}</span></ng-template>
          <ng-template osCell="desc" let-role>{{ role.desc }}</ng-template>
          <ng-template osCell="members" let-role>@for (member of role.members; track member) { <span class="label label-info">{{ usernameFor(member) }}</span> } @empty { <span class="os-sub">(없음)</span> }</ng-template>
          <ng-template osCell="actions" let-role><button class="btn btn-sm btn-outline" (click)="openManage(role)" [disabled]="busy()">구성원 관리</button></ng-template>
        </os-datagrid>
        <os-panel [open]="panelOpen()" [title]="(selectedRole()?.label || '역할') + ' 구성원'" [subtitle]="selectedRole()?.group || ''" (closed)="closePanel()">
          @if (selectedRole(); as role) {
            <p class="os-sub">{{ role.desc }}</p>
            <form clrForm clrLayout="vertical">
              <clr-select-container><label>사용자</label><select clrSelect name="add-user" [(ngModel)]="addUser" [disabled]="busy()"><option value="">사용자 선택…</option>@for (user of availableUsers(); track user.id) { <option [value]="user.id">{{ user.username }}</option> }</select></clr-select-container>
              <clr-textarea-container><label>변경 사유</label><textarea clrTextarea name="role-reason" [(ngModel)]="changeReason" maxlength="240" required></textarea><clr-control-helper>감사 로그에 기록됩니다(8자 이상).</clr-control-helper></clr-textarea-container>
            </form>
            <div class="panel-actions"><button class="btn btn-primary" (click)="grant()" [disabled]="busy() || !addUser || changeReason.trim().length < 8">부여</button>@if (role.group === adminGroup && addUser) { <span class="warn-tag">관리자 부여 — 강조 감사</span> }</div>
            <h4 class="detail-h">현재 멤버 ({{ role.members.length }})</h4>
            @if (role.members.length) { <ul class="member-list">@for (member of role.members; track member) { <li><span>{{ usernameFor(member) }}</span><button class="btn btn-sm btn-danger-outline" (click)="revoke(member)" [disabled]="busy() || changeReason.trim().length < 8">회수</button></li> }</ul> } @else { <p class="os-sub">멤버가 없습니다.</p> }
            <div class="panel-actions"><button class="btn btn-outline" (click)="closePanel()">닫기</button></div>
          }
        </os-panel>
        <os-action-dialog [open]="!!pendingRevoke()" title="역할 회수" [message]="revokeMessage()" confirmLabel="회수" [danger]="true" [busy]="busy()" (confirmed)="confirmRevoke()" (cancelled)="pendingRevoke.set(null)" />
      }
    </div>
  `,
  styles: [`
    .os-sub { color:var(--os-muted); font-size:.7rem; margin:.3rem 0 .8rem; }.os-mono { font-family:monospace; font-size:.62rem; color:var(--os-ink-muted); }.detail-h { font-size:.8rem; margin:1.1rem 0 .3rem; }.panel-actions { display:flex; gap:.5rem; align-items:center; margin-top:.6rem; }.warn-tag { color:var(--os-ink-subtle); font-size:.66rem; }.label { margin:0 .25rem .25rem 0; }.member-list { list-style:none; margin:.2rem 0; padding:0; display:flex; flex-direction:column; gap:.3rem; }.member-list li { display:flex; justify-content:space-between; gap:.6rem; padding:.25rem 0; border-bottom:1px solid var(--os-hairline); }
  `],
})
export class AdminRoles implements OnInit {
  private readonly http = inject(HttpService);
  readonly adminGroup = 'console-admins';
  readonly roleCols: OsColumn[] = [{ key: 'role', label: '역할' }, { key: 'desc', label: '설명' }, { key: 'members', label: '멤버' }, { key: 'actions', label: '동작' }];
  readonly roles = signal<Role[]>([]);
  readonly users = signal<IdentityUser[]>([]);
  readonly down = signal(''); readonly busy = signal(false); readonly panelOpen = signal(false);
  readonly selectedRole = signal<Role | null>(null); readonly pendingRevoke = signal<string | null>(null);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  addUser = ''; changeReason = '';

  async ngOnInit(): Promise<void> { await this.refresh(); }
  availableUsers(): IdentityUser[] { const members = new Set(this.selectedRole()?.members || []); return this.users().filter((user) => !members.has(user.id)); }
  assignedRoleCount(): number { return this.roles().filter((role) => role.members.length > 0).length; }
  membershipCount(): number { return this.roles().reduce((total, role) => total + role.members.length, 0); }
  roleSize(group: string): number { return this.roles().find((role) => role.group === group)?.members.length || 0; }
  usernameFor(id: string): string { return this.users().find((user) => user.id === id)?.username || id; }
  revokeMessage(): string { const user = this.pendingRevoke(); const role = this.selectedRole(); return user && role ? `${this.usernameFor(user)} 사용자의 ${role.label} 역할을 회수합니다.` : ''; }
  openManage(role: Role): void { this.selectedRole.set(role); this.addUser = ''; this.changeReason = ''; this.msg.set(null); this.panelOpen.set(true); }
  closePanel(): void { this.panelOpen.set(false); this.selectedRole.set(null); this.addUser = ''; this.changeReason = ''; }

  async refresh(): Promise<void> {
    try {
      const response = await this.http.request('/api/identity');
      if (response.status === 401 || response.status === 403) { this.msg.set({ type: 'danger', text: 'console-admins 역할이 필요합니다.' }); return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as IdentityPayload;
      const users = (payload.users || []).map((user) => ({ ...user, groups: Array.isArray(user.groups) ? user.groups : [] }));
      this.users.set(users);
      this.roles.set((payload.groups || []).map((group) => ({ group: group.name, label: group.name, desc: group.description || 'Supabase Console role', members: users.filter((user) => user.groups.some((membership) => membership.name === group.name)).map((user) => user.id) })));
      const selected = this.selectedRole();
      if (selected) this.selectedRole.set(this.roles().find((role) => role.group === selected.group) || null);
      this.down.set('');
    } catch (error) { this.down.set(`역할 조회 실패: ${String(error)}`); }
  }

  async grant(): Promise<void> { const role = this.selectedRole(); if (!role || !this.addUser || this.changeReason.trim().length < 8) return; await this.mutate('add', this.addUser, role.group); this.addUser = ''; }
  revoke(userId: string): void { if (this.selectedRole() && this.changeReason.trim().length >= 8) this.pendingRevoke.set(userId); }
  async confirmRevoke(): Promise<void> { const userId = this.pendingRevoke(); const role = this.selectedRole(); if (!userId || !role) return; this.pendingRevoke.set(null); await this.mutate('remove', userId, role.group); }
  private async mutate(op: 'add' | 'remove', userId: string, group: string): Promise<void> {
    this.busy.set(true);
    try {
      const response = await this.http.request(`/api/identity/users/${encodeURIComponent(userId)}/group`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, group, reason: this.changeReason.trim() }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      this.msg.set({ type: 'success', text: `${op === 'add' ? '부여' : '회수'} 완료: ${this.usernameFor(userId)} ↔ ${group}` });
      await this.refresh();
    } catch (error) { this.msg.set({ type: 'danger', text: `역할 변경 실패: ${String(error)}` }); }
    finally { this.busy.set(false); }
  }
}
