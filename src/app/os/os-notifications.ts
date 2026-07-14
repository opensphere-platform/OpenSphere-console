import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { NotificationService, OsNotification } from '../core/notification.service';
import { CarbonIcon } from './carbon-icon';
import Notification16 from '@carbon/icons/es/notification/16';

/**
 * 셸 단일 알림 제어점.
 * 인박스는 Clarity dropdown, 일시 알림은 Clarity alert를 사용해 키보드·포커스·ARIA 동작을 위임한다.
 */
@Component({
  selector: 'os-notifications',
  imports: [ClarityModule, CarbonIcon],
  template: `
    <clr-dropdown class="os-notifications">
      <button class="os-bell" clrDropdownTrigger title="알림" aria-label="알림 인박스">
        <os-cicon [icon]="iconBell" [size]="18" />
        @if (notif.unread() > 0) {
          <span class="os-bell-badge" aria-label="읽지 않은 알림 {{ notif.unread() }}개">{{ notif.unread() }}</span>
        }
      </button>
      <clr-dropdown-menu *clrIfOpen clrPosition="bottom-right" class="os-notif-menu">
        <div class="os-notif-head">
          <strong>알림</strong>
          <button type="button" class="btn btn-sm btn-link" (click)="notif.markAllRead()">모두 읽음</button>
        </div>
        @for (n of unreadItems(); track n.id) {
          <button type="button" clrDropdownItem class="os-notif-item" (click)="read(n)">
            <span class="label" [class.label-info]="n.severity === 'info'" [class.label-success]="n.severity === 'success'" [class.label-warning]="n.severity === 'warning'" [class.label-danger]="n.severity === 'error'">
              {{ severityLabel(n.severity) }}
            </span>
            <span class="os-notif-copy">
              <strong>{{ n.title }}</strong>
              @if (n.detail) { <span>{{ n.detail }}</span> }
              <small>{{ n.source }} · {{ n.time }}</small>
            </span>
          </button>
        } @empty {
          <div class="os-notif-empty">새 알림이 없습니다</div>
        }
        <div class="dropdown-divider"></div>
        <button type="button" clrDropdownItem (click)="goAll()">전체 알림 보기</button>
      </clr-dropdown-menu>
    </clr-dropdown>

    @if (notif.toasts().length) {
      <div class="os-toast-stack" role="region" aria-label="일시 알림" aria-live="polite">
        @for (t of notif.toasts(); track t.id) {
          <clr-alert
            [clrAlertType]="clarityType(t.severity)"
            [clrAlertClosable]="true"
            (clrAlertClosedChange)="notif.dismissToast(t.id)"
          >
            <clr-alert-item>
              <span class="alert-text"><strong>{{ t.title }}</strong>@if (t.detail) { — {{ t.detail }} }</span>
            </clr-alert-item>
          </clr-alert>
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-bell {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2.25rem;
        min-height: 2.25rem;
        background: transparent;
        border: 0;
        color: #c7d0e8;
        cursor: pointer;
      }
      .os-bell-badge {
        position: absolute;
        inset-block-start: 0;
        inset-inline-end: 0;
        min-width: 1rem;
        min-height: 1rem;
        padding: 0 0.2rem;
        border-radius: 999px;
        background: var(--os-error, #da1e28);
        color: #fff;
        font-size: 0.75rem;
        line-height: 1rem;
        text-align: center;
      }
      :host ::ng-deep .os-notif-menu.dropdown-menu {
        width: min(28rem, 92vw);
        max-height: 70vh;
        overflow-y: auto;
      }
      .os-notif-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.5rem 0.75rem;
      }
      .os-notif-item {
        display: flex !important;
        align-items: flex-start !important;
        gap: 0.5rem;
        white-space: normal !important;
      }
      .os-notif-copy {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 0.15rem;
      }
      .os-notif-copy small { color: var(--os-ink-muted, #525252); }
      .os-notif-empty { padding: 0.75rem; color: var(--os-ink-muted, #525252); }
      .os-toast-stack {
        position: fixed;
        inset-block-start: 3.5rem;
        inset-inline-end: 1rem;
        z-index: 1100;
        width: min(30rem, 92vw);
      }
    `,
  ],
})
export class OsNotifications {
  readonly notif = inject(NotificationService);
  private router = inject(Router);
  readonly iconBell = Notification16;
  readonly unreadItems = computed<OsNotification[]>(() => this.notif.items().filter((n) => !n.read));

  constructor() {
    this.notif.start();
  }

  read(n: OsNotification): void {
    this.notif.markRead(n.id);
    if (n.route) void this.router.navigateByUrl(n.route);
  }

  goAll(): void {
    void this.router.navigateByUrl('/manage/notifications');
  }

  severityLabel(severity: OsNotification['severity']): string {
    return severity === 'error' ? '오류' : severity === 'warning' ? '경고' : severity === 'success' ? '성공' : '정보';
  }

  clarityType(severity: OsNotification['severity']): 'info' | 'success' | 'warning' | 'danger' {
    return severity === 'error' ? 'danger' : severity;
  }
}
