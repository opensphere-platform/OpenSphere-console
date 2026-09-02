import { Component, ChangeDetectionStrategy, effect, inject } from '@angular/core';
import { OsShell } from './os/os-shell';
import { AuthService } from './core/auth.service';
import { InitialSetup } from './pages/initial-setup';
import { LoginPage } from './pages/login';
import { PasswordRecoveryPage } from './pages/password-recovery';
import { ExtensionHostService } from './core/extension-host.service';
import { OS_SHELL_STANDALONE_BOOT } from './core/boot-mode';
import { OsShellPage } from './system-plugins/os-shell/os-shell-page';

@Component({
  selector: 'app-root',
  imports: [OsShell, OsShellPage, InitialSetup, LoginPage, PasswordRecoveryPage],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (auth.passwordRecoveryState() !== 'idle') {
      <os-password-recovery />
    } @else if (auth.setupRequired()) {
      <os-initial-setup />
    } @else if (auth.loginRequired()) {
      <os-login />
    } @else if (auth.initializing()) {
      <main class="os-bootstrap-error" role="status">
        <h1>OpenSphere Console</h1>
        <p>인증 서비스를 연결하고 있습니다.</p>
      </main>
    } @else if (auth.initError(); as error) {
      <main class="os-bootstrap-error" role="alert">
        <h1>OpenSphere Console</h1>
        <p>인증 서비스를 초기화하지 못했습니다.</p>
        <pre>{{ error }}</pre>
        @if (auth.autoRetryPending()) { <p>서비스가 준비되면 자동으로 다시 연결합니다.</p> }
        <button type="button" (click)="retry()">지금 다시 시도</button>
      </main>
    } @else if (standaloneShellBoot) {
      <os-shell-page [standalone]="true" />
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
  readonly standaloneShellBoot = OS_SHELL_STANDALONE_BOOT;
  // Do not even instantiate the Extension Host in the isolated Shell realm.
  // The static module may be present in the signed Console image, but no
  // Registry watch, manifest fetch, guest entry fetch or blob import exists.
  private readonly ext = OS_SHELL_STANDALONE_BOOT ? null : inject(ExtensionHostService);
  private extensionLoadStarted = false;
  private readonly loadExtensionsAfterAuthentication = effect(() => {
    if (OS_SHELL_STANDALONE_BOOT || !this.ext) return;
    const authorized = Boolean(this.auth.subject())
      && !this.auth.loginRequired()
      && !this.auth.initError();
    if (!authorized || this.extensionLoadStarted || this.ext.loadState() !== 'idle') return;
    this.extensionLoadStarted = true;
    void this.ext.load().catch((error) => {
      console.warn('[extension-host] authenticated bootstrap load failed:', error);
    });
  });

  retry(): void {
    this.auth.retryInitializationNow();
  }
}
