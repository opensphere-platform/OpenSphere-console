import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { AuthService, SessionDuration } from '../core/auth.service';

@Component({
  selector: 'os-login',
  imports: [FormsModule, ClarityModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <section aria-labelledby="login-title">
        <header>
          <p class="eyebrow">OPENSPHERE CONSOLE</p>
          <h1 id="login-title">{{ auth.mfaRequired() ? '추가 인증' : '로그인' }}</h1>
          <p>{{ auth.mfaRequired() ? '인증 앱의 현재 6자리 코드를 입력하세요.' : 'Console 운영자 계정으로 로그인하세요.' }}</p>
        </header>
      @if (error()) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item><span class="alert-text">{{ error() }}</span></clr-alert-item>
        </clr-alert>
      }
      @if (!auth.mfaRequired()) {
        <form clrForm clrLayout="vertical" (ngSubmit)="submit()">
          <clr-input-container>
            <label>이메일</label>
            <input clrInput name="email" type="email" [(ngModel)]="email" autocomplete="username" required>
          </clr-input-container>
          <clr-password-container>
            <label>비밀번호</label>
            <input clrPassword name="password" type="password" [(ngModel)]="password" autocomplete="current-password" required>
          </clr-password-container>
          <clr-select-container>
            <label>로그인 유지 기간</label>
            <select clrSelect name="session-duration" [(ngModel)]="duration">
              <option value="browser">브라우저를 닫을 때까지</option>
              <option value="8h">8시간</option>
              <option value="24h">24시간</option>
              <option value="7d">7일 · 신뢰하는 개인 장치</option>
            </select>
            <clr-control-helper>{{ durationHelp() }}</clr-control-helper>
          </clr-select-container>
          <p class="security-note">30분 동안 활동이 없으면 선택한 유지 기간과 관계없이 다시 로그인해야 합니다.</p>
          <button class="btn btn-primary submit" type="submit" [disabled]="working()">{{ working() ? '로그인 중…' : '로그인' }}</button>
        </form>
      } @else {
        <form clrForm clrLayout="vertical" (ngSubmit)="submitMfa()">
          <clr-input-container>
            <label>인증 코드</label>
            <input clrInput name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" [(ngModel)]="totp" required autofocus>
          </clr-input-container>
          <button class="btn btn-primary submit" type="submit" [disabled]="working() || totp.length !== 6">{{ working() ? '확인 중…' : '확인' }}</button>
          <button class="btn btn-outline submit" type="button" (click)="cancelMfa()" [disabled]="working()">다른 계정으로 로그인</button>
        </form>
      }
    </section>
    </main>
  `,
  styles: [`
    :host{display:block;min-height:100vh;background:var(--os-surface-1);font-family:var(--os-font)}
    main{min-height:100vh;display:grid;place-items:center;padding:var(--os-6)}
    section{inline-size:min(28rem,100%);padding:var(--os-7);background:var(--os-canvas);border:1px solid var(--os-hairline)}
    header{margin-block-end:var(--os-5)}
    h1{margin:var(--os-2) 0 var(--os-3);font-size:1.75rem;line-height:1.25}
    header>p:last-child{margin:0;color:var(--os-ink-muted)}
    .eyebrow{margin:0;color:var(--os-accent);font-size:.75rem;font-weight:700;letter-spacing:.08em}
    form{margin-block-start:var(--os-5)}
    clr-input-container,clr-password-container,clr-select-container{inline-size:100%}
    .security-note{margin:var(--os-5) 0 0;color:var(--os-ink-muted);font-size:.875rem;line-height:1.5}
    .submit{inline-size:100%;margin:var(--os-4) 0 0}
    clr-alert{display:block;margin-block-end:var(--os-5)}
    @media (max-width:32rem){main{padding:var(--os-4)}section{padding:var(--os-6)}}
  `],
})
export class LoginPage {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly working = signal(false);
  readonly error = signal('');
  email = '';
  password = '';
  totp = '';
  duration: SessionDuration = this.auth.sessionDurationPreference();
  async submit(): Promise<void> {
    this.error.set(''); this.working.set(true);
    try {
      await this.auth.login(this.email, this.password, this.duration);
      this.password = '';
      if (this.auth.mfaEnrollmentRequired()) await this.router.navigateByUrl('/me?tab=security&enroll=totp');
    }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
    finally { this.working.set(false); }
  }

  async submitMfa(): Promise<void> {
    this.error.set(''); this.working.set(true);
    try { await this.auth.finishMfaLogin(this.totp); this.totp = ''; }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
    finally { this.working.set(false); }
  }

  cancelMfa(): void {
    this.totp = '';
    this.error.set('');
    this.auth.cancelMfaLogin();
  }

  durationHelp(): string {
    switch (this.duration) {
      case 'browser': return '공용 장치에 적합합니다. 브라우저 종료 시 세션 쿠키가 삭제됩니다.';
      case '24h': return '하루 동안 같은 장치에서 다시 로그인하는 횟수를 줄입니다.';
      case '7d': return '개인 장치에서만 사용하십시오. 다른 장치의 세션은 내 프로필에서 폐기할 수 있습니다.';
      default: return '기본 권장값입니다. 업무 시간 동안 유지됩니다.';
    }
  }
}
