import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';

interface Role {
  group: string;
  label: string;
  desc: string;
  members: string[];
}

// 콘솔 IdP(BFF) origin — auth.service authority와 동일 호스트.
const BFF = 'https://localhost:8444';

/**
 * 역할 정의·부여 (Phase 3) — 콘솔 역할 = Kanidm 그룹(opensphere-console-*).
 * 조회/부여/회수를 BFF /bff/roles로만 수행(admin id_token). grant/revoke는
 * scoped write SA(console-rolemgr-svc)가 콘솔 역할 그룹에만 적용 — 시스템 그룹 불가.
 * os CLI(`os role …`)와 동일 창구 소비(console==cli).
 */
@Component({
  selector: 'os-admin-roles',
  imports: [ClarityModule, FormsModule],
  template: `
    <h1>역할 <span class="os-engine">Console Roles · 정의·부여</span></h1>
    <p class="os-sub">
      콘솔 역할 = Kanidm 그룹(opensphere-console-*) 멤버십. 부여/회수는 scoped write SA로 적용.
      동일 동작을 <code>os role grant/revoke</code>로도 (console==cli).
    </p>

    @if (msg(); as m) {
      <clr-alert [clrAlertType]="m.type" [clrAlertClosable]="true" (clrAlertClosedChange)="msg.set(null)">
        <clr-alert-item><span class="alert-text">{{ m.text }}</span></clr-alert-item>
      </clr-alert>
    }

    <table class="table">
      <thead>
        <tr>
          <th class="left">역할 (그룹)</th>
          <th class="left">설명</th>
          <th class="left">멤버</th>
          <th class="left">부여</th>
        </tr>
      </thead>
      <tbody>
        @for (r of roles(); track r.group) {
          <tr>
            <td class="left"><strong>{{ r.label }}</strong><br /><span class="os-mono">{{ r.group }}</span></td>
            <td class="left">{{ r.desc }}</td>
            <td class="left">
              @for (m of r.members; track m) {
                <span class="label label-info"
                  >{{ m }} <button class="os-x" title="회수" (click)="revoke(m, r.group)">✕</button></span
                >
              } @empty {
                <span class="os-sub">(없음)</span>
              }
            </td>
            <td class="left">
              <input
                class="os-in"
                [(ngModel)]="draft[r.group]"
                placeholder="username"
                (keyup.enter)="grant(r.group)"
              />
              <button class="btn btn-sm btn-primary" (click)="grant(r.group)">부여</button>
            </td>
          </tr>
        } @empty {
          <tr><td colspan="4" class="os-sub">역할 조회 중… (관리자 PAT/세션 필요)</td></tr>
        }
      </tbody>
    </table>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub { color: var(--os-muted); font-size: 0.7rem; margin: 0.3rem 0 0.8rem; }
      .os-engine { font-size: 0.6rem; color: var(--os-muted); font-weight: 400; margin-left: 0.4rem; }
      .os-mono { font-family: monospace; font-size: 0.62rem; color: var(--os-muted); }
      .os-in { width: 8rem; margin-right: 0.3rem; padding: 0.12rem 0.4rem; font-size: 0.72rem; }
      .os-x { border: 0; background: transparent; cursor: pointer; color: var(--os-muted); margin-left: 0.15rem; padding: 0; }
      .table .left { text-align: left; }
      .label { margin: 0 0.25rem 0.25rem 0; }
    `,
  ],
})
export class AdminRoles implements OnInit {
  private auth = inject(AuthService);
  readonly roles = signal<Role[]>([]);
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);
  draft: Record<string, string> = {};

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(BFF + path, {
      ...init,
      headers: { authorization: 'Bearer ' + this.auth.token(), ...(init?.headers ?? {}) },
    });
  }

  async refresh(): Promise<void> {
    try {
      const r = await this.api('/bff/roles');
      if (r.status === 401) {
        this.msg.set({ type: 'danger', text: '관리자 권한이 필요합니다 (admin 그룹).' });
        return;
      }
      const j = await r.json();
      this.roles.set(j.roles ?? []);
    } catch (e) {
      this.msg.set({ type: 'danger', text: '역할 조회 실패: ' + e });
    }
  }

  async grant(group: string): Promise<void> {
    const user = (this.draft[group] ?? '').trim();
    if (!user) return;
    await this.mutate('grant', user, group);
    this.draft[group] = '';
  }

  async revoke(user: string, group: string): Promise<void> {
    if (!confirm(`${user} 의 ${group} 역할을 회수할까요?`)) return;
    await this.mutate('revoke', user, group);
  }

  private async mutate(action: 'grant' | 'revoke', user: string, group: string): Promise<void> {
    try {
      const r = await this.api('/bff/roles/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `user=${encodeURIComponent(user)}&role=${encodeURIComponent(group)}`,
      });
      if (r.status !== 200) {
        this.msg.set({ type: 'danger', text: `${action} 실패 (HTTP ${r.status})` });
        return;
      }
      this.msg.set({ type: 'success', text: `${action} 완료: ${user} ↔ ${group}` });
      await this.refresh();
    } catch (e) {
      this.msg.set({ type: 'danger', text: `${action} 실패: ${e}` });
    }
  }
}
