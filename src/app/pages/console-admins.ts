import { Component, OnInit, signal, inject, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';
import { OsDatagrid, OsCellDef, OsColumn } from '../os/os-datagrid';
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
interface AuditEntry {
  time?: string;
  actor?: string;
  action?: string;
  target?: string;
  result?: string;
}
interface IdMeta {
  realm?: string;
  idp?: string;
  writeEnabled?: boolean;
}
interface AuthPolicy {
  totpEnabled: boolean;
  environment: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
  source?: string;
}

/**
 * 콘솔 관리자 (Kanidm IGA) — **셸 네이티브** 페이지(ADR-UI-003 §3.2 Core≠Plugin).
 * 콘솔 자체 기능(운영관리자 identity)이므로 DUPA plugin이 아니라 mainShell에 내장.
 * 백엔드 = console-core 서비스 `console-identity-api`(셸 nginx가 /api/identity 프록시). console==cli: `os identity …`.
 */
@Component({
  selector: 'os-console-admins',
  imports: [ClarityModule, BackendUnavailable, OsPageHeader, OsDatagrid, OsCellDef],
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
      <label class="policy-toggle">
        <input
          type="checkbox"
          [checked]="authPolicy()?.totpEnabled === true"
          [disabled]="policyBusy() || !authPolicy()"
          (change)="setTotpEnabled($any($event.target).checked)"
        />
        <span>
          <strong>TOTP 로그인 활성화</strong>
          <small>{{ authPolicy()?.totpEnabled ? '활성 — 인증 앱 코드 필수' : '비활성 — 개발용 비밀번호 로그인' }}</small>
        </span>
      </label>
      <p class="policy-warning">
        기존에 TOTP가 등록된 계정은 잠금 방지를 위해 등록된 코드를 계속 요구할 수 있습니다. 비밀번호 전용으로 바꾸려면 비활성 상태에서 해당 계정을 재온보딩하세요.
      </p>
    </section>

    <h2>사용자 <span class="os-engine">({{ users().length }})</span></h2>
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
    </os-datagrid>

    <h2>감사 로그</h2>
    <os-datagrid [columns]="auditCols" [rows]="audit()" empty="감사 항목 없음">
      <ng-template osCell="time" let-a><span class="os-mono">{{ a.time }}</span></ng-template>
    </os-datagrid>
      }
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
      .policy-card { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.7rem 1.4rem; align-items:center; border:1px solid var(--cds-alias-object-border-color, #d8d8d8); border-radius:.25rem; padding:1rem 1.2rem; margin:1rem 0 1.4rem; background:var(--cds-alias-object-container-background, #fff); }
      .policy-card h2 { margin:0 0 .25rem; }
      .policy-toggle { display:flex; align-items:center; gap:.6rem; cursor:pointer; min-width:14rem; }
      .policy-toggle input { width:1.1rem; height:1.1rem; }
      .policy-toggle span { display:flex; flex-direction:column; gap:.15rem; }
      .policy-toggle small { color:var(--os-muted); }
      .policy-warning { grid-column:1/-1; margin:0; color:var(--cds-alias-status-warning, #8a3800); font-size:.68rem; }
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
  ];
  readonly auditCols: OsColumn[] = [
    { key: 'time', label: '시각' },
    { key: 'actor', label: '행위자' },
    { key: 'action', label: '동작' },
    { key: 'target', label: '대상' },
    { key: 'result', label: '결과' },
  ];
  readonly users = signal<IdUser[]>([]);
  readonly audit = signal<AuditEntry[]>([]);
  readonly meta = signal<IdMeta | null>(null);
  readonly authPolicy = signal<AuthPolicy | null>(null);
  readonly policyBusy = signal(false);
  readonly down = signal<string>(''); // 백엔드 미배포/불건전 → graceful degradation
  readonly msg = signal<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);

  private auth = inject(AuthService);
  private http = inject(HttpService);
  // 감사 B: /api/identity 읽기도 인증 필수 → 검증된 id_token(Bearer) 첨부.
  private authGet(): RequestInit {
    return { cache: 'no-store', headers: { authorization: 'Bearer ' + (this.auth.token() || '') } };
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadIdentity(), this.loadAudit(), this.loadAuthPolicy()]);
  }

  async setTotpEnabled(enabled: boolean): Promise<void> {
    const previous = this.authPolicy();
    this.policyBusy.set(true);
    try {
      const r = await this.http.request('/bff/auth-policy', {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer ' + (this.auth.token() || ''),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ totpEnabled: enabled }),
      });
      if (!r.ok) throw new Error(`auth policy HTTP ${r.status}`);
      this.authPolicy.set(await r.json());
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
    } catch (e) {
      this.down.set('조회 실패: ' + e);
    }
  }

  private async loadAudit(): Promise<void> {
    try {
      const r = await this.http.request('/api/identity/audit', this.authGet());
      if (r.ok) {
        const d = await r.json();
        this.audit.set(d.items ?? d.audit ?? (Array.isArray(d) ? d : []));
      }
    } catch {
      /* audit best-effort */
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
