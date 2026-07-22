import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'os-login',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main><section><p class="eyebrow">OPENSPHERE CONSOLE</p><h1>로그인</h1><p>Console 운영자 계정으로 로그인하세요.</p>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <form (ngSubmit)="submit()"><label>이메일<input name="email" type="email" [(ngModel)]="email" autocomplete="username" required></label>
        <label>비밀번호<input name="password" type="password" [(ngModel)]="password" autocomplete="current-password" required></label>
        <button type="submit" [disabled]="working()">{{ working() ? '로그인 중…' : '로그인' }}</button></form>
    </section></main>
  `,
  styles: [`main{min-height:100vh;display:grid;place-items:center;background:#f4f6fa;font-family:system-ui,sans-serif}section{width:min(26rem,calc(100vw - 3rem));padding:2.5rem;background:#fff;border:1px solid #d9e0ea;border-radius:.6rem;box-shadow:0 1rem 3rem #18243c14}h1{margin:.2rem 0 1rem}.eyebrow{color:#2468d4;font-size:.75rem;font-weight:700;letter-spacing:.08em}label{display:grid;gap:.4rem;margin:1rem 0;font-size:.9rem}input{padding:.7rem;border:1px solid #aeb9c8;border-radius:.25rem;font:inherit}button{margin-top:.75rem;width:100%;padding:.75rem;background:#0f62fe;color:#fff;border:0;border-radius:.25rem;font:inherit;cursor:pointer}.error{padding:.75rem;color:#a2191f;background:#fff1f1;border:1px solid #f0b8b8}`],
})
export class LoginPage {
  readonly auth = inject(AuthService);
  readonly working = signal(false);
  readonly error = signal('');
  email = '';
  password = '';
  async submit(): Promise<void> {
    this.error.set(''); this.working.set(true);
    try { await this.auth.login(this.email, this.password); this.password = ''; }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
    finally { this.working.set(false); }
  }
}
