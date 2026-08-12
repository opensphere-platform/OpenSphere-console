import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { OsShell } from './os/os-shell';
import { AuthService } from './core/auth.service';
import { InitialSetup } from './pages/initial-setup';
import { LoginPage } from './pages/login';
import { PasswordRecoveryPage } from './pages/password-recovery';

@Component({
  selector: 'app-root',
  imports: [OsShell, InitialSetup, LoginPage, PasswordRecoveryPage],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (auth.passwordRecoveryState() !== 'idle') {
      <os-password-recovery />
    } @else if (auth.setupRequired()) {
      <os-initial-setup />
    } @else if (auth.loginRequired()) {
      <os-login />
    } @else if (auth.initError(); as error) {
      <main class="os-bootstrap-error" role="alert">
        <h1>OpenSphere Console</h1>
        <p>인증 서비스를 초기화하지 못했습니다.</p>
        <pre>{{ error }}</pre>
        <button type="button" (click)="retry()">다시 시도</button>
      </main>
    } @else {
      @if (auth.authorityWarning(); as warning) {
        <div class="os-authority-warning" role="status">
          Data &amp; Identity authority가 일시적으로 응답하지 않습니다. 기존 화면은 유지되며 변경 작업과 새 로그인은 차단됩니다.
          <span>{{ warning }}</span>
        </div>
      }
      <os-shell />
    }
  `,
  styles: [`
    .os-bootstrap-error { max-width: 52rem; margin: 12vh auto; padding: 2rem; font-family: system-ui, sans-serif; color: #17233c; }
    .os-bootstrap-error pre { white-space: pre-wrap; background: #f4f6fb; padding: 1rem; border-radius: .4rem; }
    .os-bootstrap-error button { padding: .6rem 1rem; cursor: pointer; }
    .os-authority-warning { padding: .45rem 1rem; border-bottom: 1px solid #e0a000; background: #fff4ce; color: #3d2d00; font: 600 .8rem/1.35 system-ui, sans-serif; }
    .os-authority-warning span { margin-left: .5rem; font-weight: 400; }
  `],
})
export class App {
  readonly auth = inject(AuthService);
  retry(): void {
    this.auth.initError.set('');
    void this.auth.init().catch((error) => this.auth.setInitError(error));
  }
}
