import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'os-password-recovery',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="recovery-shell">
      <section class="recovery-card" aria-labelledby="recovery-title">
        <p class="eyebrow">OPENSPHERE CONSOLE</p>
        @if (auth.passwordRecoveryState() === 'ready') {
          <h1 id="recovery-title">새 비밀번호 설정</h1>
          <p class="lead">기존 비밀번호로 로그인할 필요가 없습니다. 일회성 링크로 본인 확인이 완료되었습니다.</p>
          @if (error()) { <div class="alert" role="alert">{{ error() }}</div> }
          <form (ngSubmit)="submit()">
            <label>새 비밀번호
              <input name="new-password" type="password" [(ngModel)]="password" autocomplete="new-password" minlength="12" required>
            </label>
            <label>새 비밀번호 확인
              <input name="new-password-confirm" type="password" [(ngModel)]="passwordConfirm" autocomplete="new-password" minlength="12" required>
            </label>
            <p class="hint">12자 이상으로 입력하세요.</p>
            <button type="submit" [disabled]="busy() || password.length < 12 || password !== passwordConfirm">
              {{ busy() ? '설정 중…' : '비밀번호 설정' }}
            </button>
          </form>
        } @else if (auth.passwordRecoveryState() === 'completed') {
          <h1 id="recovery-title">비밀번호 설정 완료</h1>
          <div class="success" role="status">{{ auth.passwordRecoveryMessage() }}</div>
          <button type="button" (click)="auth.leavePasswordRecovery()">새 비밀번호로 로그인</button>
        } @else {
          <h1 id="recovery-title">링크를 사용할 수 없음</h1>
          <div class="alert" role="alert">{{ auth.passwordRecoveryMessage() }}</div>
          <p class="lead">초기 비밀번호를 설정한 적이 없다면 다른 PW로 로그인하지 말고, 관리자에게 새 초기 PW 설정/재설정 링크를 요청하세요.</p>
          <button type="button" (click)="auth.leavePasswordRecovery()">로그인 화면으로</button>
        }
      </section>
    </main>
  `,
  styles: [`
    :host{display:block}.recovery-shell{display:grid;min-height:100vh;place-items:center;padding:1.5rem;background:#f4f7fb;color:#1b2a41;font-family: var(--os-font)}.recovery-card{width:min(29rem,100%);padding:2.5rem;border:1px solid #d6deea;border-radius:.6rem;background:#fff;box-shadow:0 .4rem 1.5rem #1b2a4112}.eyebrow{margin:0 0 .4rem;color:#1668f5;font-size:.78rem;font-weight:700;letter-spacing:.09em}.recovery-card h1{margin:.2rem 0 1rem;font-size:1.8rem;font-weight:500}.lead{margin:0 0 1.2rem;color:#52627a;font-size:.92rem;line-height:1.55}.recovery-card form,.recovery-card label{display:grid;gap:.45rem}.recovery-card form{gap:1rem}.recovery-card label{font-size:.9rem}.recovery-card input{min-height:2.8rem;padding:.65rem .75rem;border:1px solid #9aaac0;border-radius:.25rem;font:inherit}.recovery-card button{min-height:2.8rem;padding:.65rem 1rem;border:0;border-radius:.25rem;background:#1668f5;color:#fff;font:inherit;cursor:pointer}.recovery-card button:disabled{cursor:not-allowed;opacity:.55}.hint{margin:-.35rem 0 0;color:#66758a;font-size:.78rem}.alert,.success{margin:0 0 1rem;padding:.8rem;border:1px solid #e86c64;background:#fff2f1;color:#8f201b;font-size:.86rem}.success{border-color:#4a9e68;background:#effaf2;color:#1f6939}
  `],
})
export class PasswordRecoveryPage {
  readonly auth = inject(AuthService);
  readonly busy = signal(false);
  readonly error = signal('');
  password = '';
  passwordConfirm = '';

  async submit(): Promise<void> {
    if (this.busy()) return;
    this.error.set('');
    this.busy.set(true);
    try {
      await this.auth.completePasswordRecovery(this.password, this.passwordConfirm);
      this.password = '';
      this.passwordConfirm = '';
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
