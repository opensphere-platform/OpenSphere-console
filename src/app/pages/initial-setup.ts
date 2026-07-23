import { ChangeDetectionStrategy, Component, inject, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';

interface BeginResponse {
  state?: 'complete';
  error?: string;
}

@Component({
  selector: 'os-initial-setup',
  imports: [FormsModule, ClarityModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="setup-shell">
      <section class="setup-card" aria-labelledby="setup-title">
        <header class="setup-brand">
          <img src="/brand/triangles-logo.svg" alt="" aria-hidden="true">
          <div><strong>TRIANGLES</strong><span>OpenSphere</span></div>
        </header>

        @if (auth.setupBusy()) {
          <div class="setup-copy">
            <p class="eyebrow">INITIAL CONFIGURATION</p>
            <h1 id="setup-title">관리자 구성을 진행하고 있습니다</h1>
            <p>다른 브라우저에서 시작된 설정이 끝나면 자동으로 로그인 화면으로 전환됩니다.</p>
            <button class="btn btn-outline" type="button" (click)="retryStatus()">상태 다시 확인</button>
          </div>
        } @else if (step() === 'profile') {
          <div class="setup-copy">
            <p class="eyebrow">INITIAL CONFIGURATION</p>
            <h1 id="setup-title">최초 관리자를 구성합니다</h1>
            <p>이 계정이 OpenSphere Console의 첫 번째 최고 관리자가 됩니다. 완료 후 바로 로그인할 수 있습니다.</p>
          </div>
          @if (error()) {
            <div class="alert alert-danger" role="alert"><div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div></div>
          }
          <form clrForm clrLayout="vertical" (ngSubmit)="begin()">
            <clr-input-container>
              <label>관리자 ID</label>
              <input clrInput name="username" [(ngModel)]="username" autocomplete="username" required minlength="2" maxlength="32">
              <clr-control-helper>영문 소문자로 시작하며 숫자·점·밑줄·하이픈을 사용할 수 있습니다.</clr-control-helper>
            </clr-input-container>
            <clr-input-container>
              <label>표시 이름</label>
              <input clrInput name="displayName" [(ngModel)]="displayName" autocomplete="name" required maxlength="128">
            </clr-input-container>
            <clr-input-container>
              <label>이메일</label>
              <input clrInput name="email" [(ngModel)]="email" type="email" autocomplete="email" required maxlength="254">
            </clr-input-container>
            <clr-password-container>
              <label>비밀번호</label>
              <input clrPassword name="password" [(ngModel)]="password" autocomplete="new-password" required minlength="12">
              <clr-control-helper>12자 이상으로 설정하세요. 최종 정책 검증은 인증 서비스가 수행합니다.</clr-control-helper>
            </clr-password-container>
            <clr-password-container>
              <label>비밀번호 확인</label>
              <input clrPassword name="passwordConfirm" [(ngModel)]="passwordConfirm" autocomplete="new-password" required minlength="12">
            </clr-password-container>
            <div class="setup-actions"><button class="btn btn-primary" type="submit" [disabled]="working()">{{ working() ? '구성 중…' : '관리자 생성' }}</button></div>
          </form>
        } @else {
          <div class="setup-copy">
            <p class="eyebrow">SECURITY</p>
            <h1 id="setup-title">인증 앱을 연결합니다</h1>
            <p>QR 코드를 인증 앱으로 스캔하고 현재 6자리 코드를 입력하세요.</p>
          </div>
          @if (error()) {
            <div class="alert alert-danger" role="alert"><div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div></div>
          }
          <div class="totp-layout">
            <img [src]="qrDataUrl()" alt="OpenSphere 관리자 TOTP 등록 QR 코드">
            <div><span class="setup-label">수동 등록 키</span><code>{{ secret() }}</code></div>
          </div>
          <form clrForm clrLayout="vertical" (ngSubmit)="finishTotp()">
            <clr-input-container>
              <label>6자리 인증 코드</label>
              <input clrInput name="totp" [(ngModel)]="totp" inputmode="numeric" autocomplete="one-time-code" required maxlength="6">
            </clr-input-container>
            <div class="setup-actions"><button class="btn btn-primary" type="submit" [disabled]="working()">{{ working() ? '확인 중…' : '설정 완료' }}</button></div>
          </form>
        }
      </section>
      <aside class="setup-context" aria-label="OpenSphere 소개">
        <div><p>Welcome to</p><h2>OpenSphere</h2><span>Kubernetes 운영을 위한 통합 관리 Console</span></div>
      </aside>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--os-canvas); }
    .setup-shell { display: grid; grid-template-columns: minmax(28rem, 38rem) 1fr; min-height: 100vh; }
    .setup-card { padding: var(--os-7) clamp(2rem, 6vw, 5rem); background: #fff; }
    .setup-brand { display: flex; align-items: center; gap: .7rem; margin-bottom: 4rem; }
    .setup-brand img { width: 2rem; height: 2rem; object-fit: contain; }
    .setup-brand div { display: flex; align-items: baseline; gap: .45rem; }
    .setup-brand strong { font-size: .95rem; letter-spacing: .03em; }
    .setup-brand span { font-size: .9rem; color: var(--os-ink-muted); }
    .setup-copy { margin-bottom: var(--os-6); }
    .setup-copy h1 { margin: .2rem 0 .75rem; font-size: 2rem; font-weight: 400; letter-spacing: -.02em; }
    .setup-copy p:not(.eyebrow) { max-width: 30rem; color: var(--os-ink-muted); line-height: 1.55; }
    .eyebrow { margin: 0; color: var(--os-accent); font-size: .72rem; font-weight: 600; letter-spacing: .08em; }
    form { max-width: 30rem; }
    clr-input-container, clr-password-container { margin-top: .9rem; }
    input[clrInput], input[clrPassword] { width: 100%; }
    .setup-actions { margin-top: var(--os-6); }
    .setup-actions .btn { min-width: 9rem; }
    .setup-context { display: flex; align-items: center; padding: clamp(3rem, 9vw, 8rem); color: var(--os-ink); background: var(--os-overview-bg); border-left: 1px solid var(--os-hairline); }
    .setup-context p { margin: 0; font-size: 1.6rem; font-weight: 300; }
    .setup-context h2 { margin: .25rem 0 1rem; font-size: clamp(3rem, 7vw, 5rem); font-weight: 300; letter-spacing: -.05em; }
    .setup-context span { color: var(--os-ink-muted); font-size: 1.05rem; }
    .totp-layout { display: flex; align-items: center; gap: var(--os-6); margin: var(--os-6) 0; }
    .totp-layout img { width: 12rem; height: 12rem; border: 1px solid var(--os-hairline); }
    .totp-layout code { display: block; max-width: 15rem; margin-top: .5rem; padding: .75rem; background: var(--os-surface-1); word-break: break-all; user-select: all; }
    .setup-label { color: var(--os-ink-muted); font-size: .75rem; }
    @media (max-width: 56rem) { .setup-shell { grid-template-columns: 1fr; } .setup-context { display: none; } .setup-card { padding: 2rem clamp(1.5rem, 8vw, 4rem); } }
    @media (max-width: 32rem) { .totp-layout { align-items: flex-start; flex-direction: column; } }
  `]
})
export class InitialSetup implements OnDestroy {
  readonly auth = inject(AuthService);
  readonly step = signal<'profile' | 'totp'>('profile');
  readonly working = signal(false);
  readonly error = signal('');
  readonly qrDataUrl = signal('');
  readonly secret = signal('');
  readonly setupId = signal('');
  username = this.auth.setupDefaults().username;
  displayName = this.auth.setupDefaults().displayName;
  email = this.auth.setupDefaults().email;
  password = '';
  passwordConfirm = '';
  totp = '';
  private readonly busyPoll = window.setInterval(() => {
    if (this.auth.setupBusy()) void this.auth.refreshInitialSetup().catch(() => {});
  }, 3000);

  ngOnDestroy(): void { window.clearInterval(this.busyPoll); }

  async retryStatus(): Promise<void> { await this.auth.refreshInitialSetup(); }

  async begin(): Promise<void> {
    this.error.set(''); this.working.set(true);
    try {
      const response = await fetch('/api/identity/bootstrap', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: this.username, displayName: this.displayName, email: this.email, password: this.password, passwordConfirm: this.passwordConfirm })
      });
      const body = await response.json() as BeginResponse;
      if (!response.ok) throw new Error(this.message(body.error));
      const bootstrapPassword = this.password;
      await this.auth.login(this.email, bootstrapPassword);
      if (this.auth.mfaRequired()) throw new Error('새 관리자에 예상하지 않은 기존 MFA factor가 연결되어 있습니다.');
      const enrollment = await this.auth.beginTotpEnrollment('OpenSphere initial administrator');
      this.password = ''; this.passwordConfirm = '';
      this.setupId.set(enrollment.factorId);
      this.secret.set(enrollment.secret);
      this.qrDataUrl.set(enrollment.qrCode);
      this.step.set('totp');
    } catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
    finally { this.working.set(false); }
  }

  async finishTotp(): Promise<void> {
    this.error.set(''); this.working.set(true);
    try {
      await this.auth.verifyTotpEnrollment(this.setupId(), this.totp);
      await this.auth.completeInitialSetup();
    } catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
    finally { this.working.set(false); }
  }

  private message(code?: string): string {
    const messages: Record<string, string> = {
      invalid_username: '관리자 ID 형식을 확인하세요.', invalid_display_name: '표시 이름을 입력하세요.', invalid_email: '올바른 이메일을 입력하세요.',
      password_policy: '인증 정책을 만족하는 더 강한 비밀번호를 입력하세요.', password_mismatch: '비밀번호 확인이 일치하지 않습니다.',
      setup_busy: '다른 브라우저에서 관리자 설정을 진행하고 있습니다.', setup_complete: '관리자 설정이 이미 완료되었습니다.',
      invalid_totp: '현재 6자리 인증 코드가 일치하지 않습니다.', setup_session_expired: '설정 시간이 만료되었습니다. 처음부터 다시 시도하세요.'
    };
    return messages[code || ''] || '관리자 구성을 완료하지 못했습니다. 잠시 후 다시 시도하세요.';
  }
}
