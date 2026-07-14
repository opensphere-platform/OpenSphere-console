import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';
import { HttpService } from '../core/http.service';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsDatagrid, OsCellDef, OsColumn } from '../os/os-datagrid';
import { OsPanel } from '../os/os-panel';
import { OsActionDialog } from '../os/os-action-dialog';

interface Role {
  group: string;
  label: string;
  desc: string;
  members: string[];
}

// §3.2 same-origin: 셸 nginx가 /bff → opensphere-console-auth(BFF) 프록시.
const BFF = '';
const ADMIN_GROUP = 'opensphere-console-admins';

/**
 * 역할 정의·부여 (Phase 3) — 콘솔 역할 = Kanidm 그룹(opensphere-console-*).
 * 조회는 BFF /bff/roles, 부여/회수는 scoped write SA(console-rolemgr-svc)로 콘솔 역할 그룹에만 적용.
 * 인라인 입력 대신 역할별 "구성원 관리" → 우측 os-panel + Clarity form(기존 사용자 선택)으로 처리
 * (자유 입력 금지 → 유령 사용자 차단). admin 부여는 BFF에서 자가차단·강조 감사(AG-2). os CLI와 동일 창구.
 */
@Component({
  selector: 'os-admin-roles',
  imports: [ClarityModule, FormsModule, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef, OsPanel, OsActionDialog],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="역할" tag="Console Roles · 정의·부여">
        <p>
          콘솔 역할 = Kanidm 그룹(opensphere-console-*) 멤버십. 부여/회수는 scoped write SA로 적용.
          동일 동작을 <code>os role grant/revoke</code>로도 (console==cli).
        </p>
      </os-page-header>

      @if (down(); as d) {
        <os-backend-unavailable
          feature="역할 (Console Roles)"
          backend="opensphere-console-auth BFF (/bff/roles)"
          hint="opensphere-console-auth 배포 · rolemgr 시크릿(opensphere-rolemgr-kanidm) 확인 시 자동 복구됩니다."
          [detail]="d"
        />
      } @else {
        @if (msg(); as m) {
          <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)">
            <clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item>
          </clr-alert>
        }

        <os-datagrid [columns]="roleCols" [rows]="roles()" empty="역할 조회 중… (관리자 세션 필요)">
          <ng-template osCell="role" let-r><strong>{{ r.label }}</strong><br /><span class="os-mono">{{ r.group }}</span></ng-template>
          <ng-template osCell="desc" let-r>{{ r.desc }}</ng-template>
          <ng-template osCell="members" let-r>
            @for (m of r.members; track m) { <span class="label label-info">{{ m }}</span> } @empty { <span class="os-sub">(없음)</span> }
          </ng-template>
          <ng-template osCell="actions" let-r>
            <button class="btn btn-sm btn-outline" (click)="openManage(r)" [disabled]="busy()">구성원 관리</button>
          </ng-template>
        </os-datagrid>

        <os-panel
          [open]="panelOpen()"
          [title]="(selectedRole()?.label || '역할') + ' 구성원'"
          [subtitle]="selectedRole()?.group || ''"
          (closed)="closePanel()"
        >
          @if (selectedRole(); as r) {
            <p class="os-sub">{{ r.desc }}</p>

            <h4 class="detail-h">구성원 추가</h4>
            <form clrForm clrLayout="vertical">
              <clr-select-container>
                <label>사용자</label>
                <select clrSelect name="add-user" [(ngModel)]="addUser" [disabled]="busy()">
                  <option value="">사용자 선택…</option>
                  @for (u of availableUsers(); track u) { <option [value]="u">{{ u }}</option> }
                </select>
              </clr-select-container>
              <clr-textarea-container>
                <label>변경 사유</label>
                <textarea clrTextarea name="role-reason" [(ngModel)]="changeReason" maxlength="240" required></textarea>
                <clr-control-helper>영구 감사에 기록됩니다(8자 이상).</clr-control-helper>
              </clr-textarea-container>
            </form>
            <div class="panel-actions">
              <button class="btn btn-primary" (click)="grant()" [disabled]="busy() || !addUser || changeReason.trim().length < 8">부여</button>
              @if (r.group === adminGroup && addUser) { <span class="warn-tag">관리자 부여 — 강조 감사</span> }
            </div>
            @if (!availableUsers().length) {
              <p class="os-sub">추가할 수 있는 사용자가 없습니다(모두 멤버이거나 사용자 목록을 불러오지 못함).</p>
            }

            <h4 class="detail-h">현재 멤버 <span class="os-engine">({{ r.members.length }})</span></h4>
            @if (r.members.length) {
              <ul class="member-list">
                @for (m of r.members; track m) {
                  <li>
                    <span>{{ m }}</span>
                    <button class="btn btn-sm btn-danger-outline" (click)="revoke(m)" [disabled]="busy() || changeReason.trim().length < 8">회수</button>
                  </li>
                }
              </ul>
            } @else {
              <p class="os-sub">멤버가 없습니다.</p>
            }

            <div class="panel-actions">
              <button class="btn btn-outline" (click)="closePanel()">닫기</button>
            </div>
          }
        </os-panel>

        <os-action-dialog
          [open]="!!pendingRevoke()"
          title="역할 회수"
          [message]="pendingRevoke() && selectedRole() ? pendingRevoke() + ' 사용자의 ' + selectedRole()!.label + ' 역할을 회수합니다.' : ''"
          confirmLabel="회수"
          [danger]="true"
          [busy]="busy()"
          (confirmed)="confirmRevoke()"
          (cancelled)="pendingRevoke.set(null)"
        />
      }
    </div>
  `,
  styles: [
    `
      .os-sub { color: var(--os-muted); font-size: 0.7rem; margin: 0.3rem 0 0.8rem; }
      .os-engine { font-size: 0.6rem; color: var(--os-muted); font-weight: 400; margin-left: 0.4rem; }
      .os-mono { font-family: var(--os-font-mono, monospace); font-size: 0.62rem; color: var(--os-ink-muted); }
      .detail-h { font-size: 0.8rem; margin: 1.1rem 0 0.3rem; color: var(--os-ink); }
      .panel-actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
      .warn-tag { color: var(--os-ink-subtle); font-size: 0.66rem; }
      .label { margin: 0 0.25rem 0.25rem 0; }
      .member-list { list-style: none; margin: 0.2rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
      .member-list li { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.25rem 0; border-bottom: 1px solid var(--os-hairline); }
    `,
  ],
})
export class AdminRoles implements OnInit {
  private auth = inject(AuthService);
  private http = inject(HttpService);
  readonly adminGroup = ADMIN_GROUP;
  readonly roleCols: OsColumn[] = [
    { key: 'role', label: '역할 (그룹)' },
    { key: 'desc', label: '설명' },
    { key: 'members', label: '멤버' },
    { key: 'actions', label: '동작' },
  ];
  readonly roles = signal<Role[]>([]);
  readonly allUsers = signal<string[]>([]);
  readonly down = signal<string>('');
  readonly busy = signal(false);
  readonly panelOpen = signal(false);
  readonly selectedRole = signal<Role | null>(null);
  readonly pendingRevoke = signal<string | null>(null);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  addUser = '';
  changeReason = '';

  async ngOnInit(): Promise<void> {
    await Promise.all([this.refresh(), this.loadUsers()]);
  }

  private api(path: string, init?: RequestInit): Promise<Response> {
    return this.http.request(BFF + path, {
      ...init,
      headers: { authorization: 'Bearer ' + this.auth.token(), ...(init?.headers ?? {}) },
    });
  }

  availableUsers(): string[] {
    const members = new Set(this.selectedRole()?.members ?? []);
    return this.allUsers().filter((u) => !members.has(u));
  }

  openManage(role: Role): void {
    this.selectedRole.set(role);
    this.addUser = '';
    this.changeReason = '';
    this.msg.set(null);
    this.panelOpen.set(true);
  }

  closePanel(): void {
    this.panelOpen.set(false);
    this.selectedRole.set(null);
    this.addUser = '';
    this.changeReason = '';
  }

  async refresh(): Promise<void> {
    try {
      const r = await this.api('/bff/roles');
      if (r.status === 401) {
        this.msg.set({ type: 'danger', text: '관리자 권한이 필요합니다 (opensphere-console-admins).' });
        return;
      }
      const j = await r.json();
      this.roles.set(j.roles ?? []);
      // 패널이 열려 있으면 선택 역할을 갱신된 목록으로 재동기화(멤버 변경 반영).
      const sel = this.selectedRole();
      if (sel) {
        const fresh = (j.roles ?? []).find((x: Role) => x.group === sel.group);
        if (fresh) this.selectedRole.set(fresh);
      }
    } catch (e) {
      this.down.set('역할 조회 실패: ' + e);
    }
  }

  private async loadUsers(): Promise<void> {
    try {
      const r = await this.http.request('/api/identity');
      if (!r.ok) return;
      const d = (await r.json()) as { users?: { username?: string }[] };
      this.allUsers.set((d.users ?? []).map((u) => String(u.username || '')).filter(Boolean).sort());
    } catch {
      /* 사용자 목록 best-effort — 없으면 부여 select가 빈다 */
    }
  }

  async grant(): Promise<void> {
    const role = this.selectedRole();
    const user = this.addUser.trim();
    if (!role || !user || this.changeReason.trim().length < 8) return;
    await this.mutate('grant', user, role.group);
    this.addUser = '';
  }

  async revoke(user: string): Promise<void> {
    const role = this.selectedRole();
    if (!role || this.changeReason.trim().length < 8) return;
    this.pendingRevoke.set(user);
  }

  async confirmRevoke(): Promise<void> {
    const role = this.selectedRole();
    const user = this.pendingRevoke();
    if (!role || !user) return;
    this.pendingRevoke.set(null);
    await this.mutate('revoke', user, role.group);
  }

  private async mutate(action: 'grant' | 'revoke', user: string, group: string): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api('/bff/roles/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user, role: group, reason: this.changeReason.trim() }).toString(),
      });
      if (r.status === 403) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        this.msg.set({ type: 'danger', text: b.error === 'self_admin_change_forbidden' ? '관리자 권한은 본인에게 직접 변경할 수 없습니다(직무분리).' : `${action} 거부되었습니다.` });
        return;
      }
      if (r.status !== 200) {
        this.msg.set({ type: 'danger', text: `${action} 실패 (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: `${action} 완료: ${user} ↔ ${group}` });
      await this.refresh();
    } catch (e) {
      this.msg.set({ type: 'danger', text: `${action} 실패: ${e}` });
    } finally {
      this.busy.set(false);
    }
  }
}
