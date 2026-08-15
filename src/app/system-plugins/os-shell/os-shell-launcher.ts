import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import Terminal20 from '@carbon/icons/es/terminal/20';
import { AuthService } from '../../core/auth.service';
import { CarbonIcon } from '../../os/carbon-icon';
import { OsShellReadinessService } from './os-shell-readiness.service';

@Component({
  selector: 'os-shell-launcher',
  imports: [RouterLink, RouterLinkActive, CarbonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (eligible()) {
      <a
        class="os-shell-launcher"
        routerLink="/shell"
        routerLinkActive="active"
        [class.blocked]="readiness.status().state === 'Blocked' || readiness.status().state === 'Disabled'"
        [title]="title()"
        aria-label="OpenSphere OS Shell"
      >
        <os-cicon [icon]="iconTerminal" [size]="20" />
        <span class="state-dot" aria-hidden="true"></span>
      </a>
    }
  `,
  styles: [`
    :host { display: inline-flex; }
    .os-shell-launcher {
      position: relative; display: inline-flex; align-items: center; justify-content: center;
      width: 2.25rem; height: 2.25rem; border-radius: 4px; color: #c7d0e8;
      text-decoration: none; background: transparent;
    }
    .os-shell-launcher:hover, .os-shell-launcher.active { color: #fff; background: rgba(255,255,255,.08); }
    .state-dot {
      position: absolute; right: .28rem; bottom: .28rem; width: .38rem; height: .38rem;
      border: 1px solid #161616; border-radius: 50%; background: var(--os-success);
    }
    .blocked .state-dot { background: var(--os-warning); }
  `],
})
export class OsShellLauncher {
  private readonly auth = inject(AuthService);
  readonly readiness = inject(OsShellReadinessService);
  readonly iconTerminal = Terminal20;
  readonly eligible = computed(() => {
    const authority = new Set([...this.auth.groups(), ...this.auth.roles()]);
    return ['console-admins', 'opensphere-console-admins', 'platform-admins', 'platform-admin', 'console-operators', 'platform-operators']
      .some((role) => authority.has(role));
  });
  readonly title = computed(() => {
    const state = this.readiness.status();
    return state.ready ? 'OpenSphere OS Shell' : `OpenSphere OS Shell · ${state.blocker?.code ?? state.state}`;
  });

  constructor() {
    void this.readiness.refresh();
  }
}
