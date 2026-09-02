import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import Close20 from '@carbon/icons/es/close/20';
import Launch20 from '@carbon/icons/es/launch/20';
import Maximize20 from '@carbon/icons/es/maximize/20';
import Minimize20 from '@carbon/icons/es/minimize/20';
import Terminal20 from '@carbon/icons/es/terminal/20';
import { CarbonIcon } from '../../os/carbon-icon';
import { OsShellPage } from './os-shell-page';
import { OsShellPanelStateService } from './os-shell-panel-state.service';
import { OsShellReadinessService } from './os-shell-readiness.service';

@Component({
  selector: 'os-shell-panel',
  imports: [CarbonIcon, OsShellPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (panel.open()) {
      <section
        class="os-shell-panel"
        [class.expanded]="panel.expanded()"
        role="region"
        aria-label="OS Shell"
      >
        <header
          class="panel-bar"
          (dblclick)="panel.toggleInfo()"
          [title]="panel.infoCollapsed() ? '더블 클릭하여 세션 정보 펼치기' : '더블 클릭하여 세션 정보 접기'"
        >
          <div
            class="panel-title"
            role="button"
            tabindex="0"
            aria-controls="os-shell-session-information"
            [attr.aria-expanded]="!panel.infoCollapsed()"
            (keydown.enter)="panel.toggleInfo()"
            (keydown.space)="toggleInfoFromKeyboard($event)"
          >
            <os-cicon [icon]="iconTerminal" [size]="18" />
            <strong>OS Shell</strong>
            <span class="panel-state" [attr.data-state]="readiness.status().state">
              <span class="state-dot" aria-hidden="true"></span>
              {{ readiness.status().state }}
            </span>
          </div>
          <div class="panel-actions" (dblclick)="$event.stopPropagation()">
            <a class="panel-action" href="/shell" target="_blank" rel="noopener noreferrer" title="전체 화면으로 열기" aria-label="OS Shell 전체 화면으로 열기">
              <os-cicon [icon]="iconLaunch" [size]="16" />
            </a>
            <button class="panel-action" type="button" (click)="panel.toggleExpanded()" [title]="panel.expanded() ? '기본 크기로 축소' : '패널 확장'" [attr.aria-label]="panel.expanded() ? 'OS Shell 기본 크기로 축소' : 'OS Shell 패널 확장'">
              <os-cicon [icon]="panel.expanded() ? iconMinimize : iconMaximize" [size]="16" />
            </button>
            <button class="panel-action" type="button" (click)="panel.close()" title="닫기" aria-label="OS Shell 닫기">
              <os-cicon [icon]="iconClose" [size]="16" />
            </button>
          </div>
        </header>
        <div class="panel-body">
          <os-shell-page [embedded]="true" [infoCollapsed]="panel.infoCollapsed()" />
        </div>
      </section>
    }
  `,
  styles: [`
    :host { display: contents; }
    .os-shell-panel {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: var(--os-z-shell-panel, 1080);
      display: flex;
      height: clamp(20rem, 42vh, 34rem);
      min-height: 20rem;
      flex-direction: column;
      border-top: 1px solid #525252;
      background: #101010;
      box-shadow: 0 -0.35rem 1.4rem rgba(0, 0, 0, 0.32);
    }
    .os-shell-panel.expanded {
      top: var(--os-header-height, 3rem);
      height: auto;
      max-height: none;
    }
    .panel-bar {
      display: flex;
      min-height: 2.5rem;
      flex: 0 0 auto;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #393939;
      background: #262626;
      color: #f4f4f4;
      cursor: pointer;
      user-select: none;
    }
    .panel-title, .panel-actions { display: flex; align-items: center; }
    .panel-title { min-width: 0; align-self: stretch; flex: 1 1 auto; gap: .55rem; padding: 0 .9rem; font-size: .8rem; }
    .panel-title:focus-visible { outline: 2px solid #78a9ff; outline-offset: -2px; }
    .panel-title > os-cicon { color: #78a9ff; }
    .panel-state { display: inline-flex; align-items: center; gap: .3rem; color: #a8a8a8; font-size: .68rem; font-weight: 500; }
    .state-dot { width: .4rem; height: .4rem; border-radius: 50%; background: var(--os-warning); }
    .panel-state[data-state='Ready'] .state-dot { background: var(--os-success); }
    .panel-actions { align-self: stretch; cursor: default; }
    .panel-action {
      display: inline-flex;
      width: 2.5rem;
      height: 100%;
      min-height: 2.5rem;
      align-items: center;
      justify-content: center;
      border: 0;
      border-left: 1px solid #393939;
      border-radius: 0;
      background: transparent;
      color: #c6c6c6;
      cursor: pointer;
      text-decoration: none;
    }
    .panel-action:hover, .panel-action:focus-visible { background: #393939; color: #fff; }
    .panel-body { display: flex; flex: 1 1 auto; min-height: 0; overflow: hidden; }
    @media (max-width: 48rem) {
      .os-shell-panel { height: 58vh; }
      .os-shell-panel.expanded { height: auto; }
      .panel-state { display: none; }
    }
  `],
})
export class OsShellPanel {
  readonly panel = inject(OsShellPanelStateService);
  readonly readiness = inject(OsShellReadinessService);
  readonly iconTerminal = Terminal20;
  readonly iconLaunch = Launch20;
  readonly iconMaximize = Maximize20;
  readonly iconMinimize = Minimize20;
  readonly iconClose = Close20;

  toggleInfoFromKeyboard(event: Event): void {
    event.preventDefault();
    this.panel.toggleInfo();
  }
}
