import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService, SessionDuration } from '../core/auth.service';

@Component({
  selector: 'os-login',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main><section aria-labelledby="login-title">
      <p class="eyebrow">OPENSPHERE CONSOLE</p>
      <h1 id="login-title">{{ auth.mfaRequired() ? '추가 인증' : '로그인' }}</h1>
      <p>{{ auth.mfaRequired() ? '인증 앱의 현재 6자리 코드를 입력하세요.' : 'Console 운영자 계정으로 로그인하세요.' }}</p>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (!auth.mfaRequired()) {
        <form (ngSubmit)="submit()">
          <label>이메일
            <input name="email" type="email" [(ngModel)]="email" autocomplete="username" required>
          </label>
          <label>비밀번호
            <input name="password" type="password" [(ngModel)]="password" autocomplete="current-password" required>
          </label>
          <label>세션 유지 시간
            <select name="session-duration" [(ngModel)]="duration">
              <option value="browser">브라우저를 닫을 때까지</option>
              <option value="8h">8시간</option>
              <option value="24h">24시간</option>
              <option value="7d">7일 · 신뢰하는 개인 장치</option>
            </select>
            <small>{{ durationHelp() }}</small>
          </label>
          <p class="security-note">30분 동안 활동이 없으면 선택한 시간과 관계없이 다시 로그인해야 합니다.</p>
          <button type="submit" [disabled]="working()">{{ working() ? '로그인 중…' : '로그인' }}</button>
        </form>
      } @else {
        <form (ngSubmit)="submitMfa()">
          <label>인증 코드
            <input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" [(ngModel)]="totp" required autofocus>
          </label>
          <button type="submit" [disabled]="working() || totp.length !== 6">{{ working() ? '확인 중…' : '확인' }}</button>
          <button class="secondary" type="button" (click)="cancelMfa()" [disabled]="working()">다른 계정으로 로그인</button>
        </form>
      }
    </section></main>
  `,
  styles: [`main{min-height:100vh;display:grid;place-items:center;background:#f4f6fa;font-family:system-ui,sans-serif}section{width:min(26rem,calc(100vw - 3rem));padding:2.5rem;background:#fff;border:1px solid #d9e0ea;border-radius:.6rem;box-shadow:0 1rem 3rem #18243c14}h1{margin:.2rem 0 1rem}.eyebrow{color:#2468d4;font-size:.75rem;font-weight:700;letter-spacing:.08em}label{display:grid;gap:.4rem;margin:1rem 0;font-size:.9rem}input,select{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid #aeb9c8;border-radius:.25rem;background:#fff;color:#172033;font:inherit}select{cursor:pointer}small,.security-note{color:#5f6b7a;font-size:.78rem;line-height:1.45}.security-note{margin:.25rem 0 0}button{margin-top:.75rem;width:100%;padding:.75rem;background:#0f62fe;color:#fff;border:0;border-radius:.25rem;font:inherit;cursor:pointer}.secondary{background:transparent;color:#315b8a;border:1px solid #aeb9c8}.error{padding:.75rem;color:#a2191f;background:#fff1f1;border:1px solid #f0b8b8}`],
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
