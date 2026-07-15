import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { OsShell } from './os/os-shell';
import { AuthService } from './core/auth.service';
import { InitialSetup } from './pages/initial-setup';

@Component({
  selector: 'app-root',
  imports: [OsShell, InitialSetup],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (auth.setupRequired()) {
      <os-initial-setup />
    } @else if (auth.initError(); as error) {
      <main class="os-bootstrap-error" role="alert">
        <h1>OpenSphere Console</h1>
        <p>인증 서비스를 초기화하지 못했습니다.</p>
        <pre>{{ error }}</pre>
        <button type="button" (click)="retry()">다시 시도</button>
      </main>
    } @else {
      <os-shell />
    }
  `,
  styles: [`
    .os-bootstrap-error { max-width: 52rem; margin: 12vh auto; padding: 2rem; font-family: system-ui, sans-serif; color: #17233c; }
    .os-bootstrap-error pre { white-space: pre-wrap; background: #f4f6fb; padding: 1rem; border-radius: .4rem; }
    .os-bootstrap-error button { padding: .6rem 1rem; cursor: pointer; }
  `],
})
export class App {
  readonly auth = inject(AuthService);
  retry(): void {
    this.auth.initError.set('');
    void this.auth.init().catch((error) => this.auth.setInitError(error));
  }
}
