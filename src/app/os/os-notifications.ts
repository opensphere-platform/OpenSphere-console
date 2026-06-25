import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { NotificationService } from '../core/notification.service';

/**
 * 셸 단일 알림 (single control point). 헤더 벨 + 인박스 드로어(영구) + 토스트 스택(일시).
 * 소스(멀티): 콘솔 audit bus(DUPA, 실데이터) + in-page 발행(ctx.notify). Novu 아님(워크스페이스 전용).
 * 규범: P6-experience §1 + 헌법 §6.0(audit bus). 설계: ADR-UI-002 / dupa-notification-contribution-contract.
 */
@Component({
  selector: 'os-notifications',
  template: `
    <button class="os-bell" (click)="toggle()" title="알림">
      🔔
      @if (notif.unread() > 0) {
        <span class="os-bell-badge">{{ notif.unread() }}</span>
      }
    </button>

    @if (open()) {
      <div class="os-notif-backdrop" (click)="open.set(false)"></div>
      <div class="os-notif-panel" role="dialog" aria-label="알림 인박스">
        <div class="os-notif-head">
          <span
            >알림 <span class="os-notif-sub">({{ notif.items().length }})</span></span
          >
          <button class="os-notif-readall" (click)="notif.markAllRead()">모두 읽음</button>
        </div>
        <div class="os-notif-list">
          @for (n of notif.items(); track n.id) {
            <div class="os-notif-item" [class.unread]="!n.read">
              <div class="os-notif-row">
                <span class="os-sev os-sev-{{ n.severity }}" [title]="n.severity"></span>
                <div class="os-notif-title">{{ n.title }}</div>
              </div>
              @if (n.detail) {
                <div class="os-notif-detail">{{ n.detail }}</div>
              }
              <div class="os-notif-meta">
                <span class="os-notif-src">{{ n.source }}</span> · {{ n.time }}
              </div>
            </div>
          } @empty {
            <div class="os-notif-empty">알림이 없습니다</div>
          }
        </div>
        <div class="os-notif-foot">소스: 콘솔 audit bus(DUPA) · in-page 발행(ctx.notify) — ADR-UI-002</div>
      </div>
    }

    <!-- 토스트 스택(일시) — persistent:false 발행분. 채널 3분할 중 토스트(D5). -->
    @if (notif.toasts().length) {
      <div class="os-toast-stack" role="status" aria-live="polite">
        @for (t of notif.toasts(); track t.id) {
          <div class="os-toast os-toast-{{ t.severity }}">
            <span class="os-sev os-sev-{{ t.severity }}"></span>
            <div class="os-toast-body">
              <div class="os-toast-title">{{ t.title }}</div>
              @if (t.detail) {
                <div class="os-toast-detail">{{ t.detail }}</div>
              }
            </div>
            <button class="os-toast-x" (click)="notif.dismissToast(t.id)" aria-label="닫기">×</button>
          </div>
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-bell {
        position: relative;
        background: transparent;
        border: 0;
        color: #c7d0e8;
        cursor: pointer;
        font-size: 0.95rem;
        margin-right: 0.7rem;
      }
      .os-bell-badge {
        position: absolute;
        top: -4px;
        right: -6px;
        background: #e1483a;
        color: #fff;
        font-size: 0.5rem;
        min-width: 13px;
        height: 13px;
        line-height: 13px;
        border-radius: 7px;
        padding: 0 3px;
        text-align: center;
      }
      .os-notif-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
      }
      .os-notif-panel {
        position: absolute;
        top: 38px;
        right: 6px;
        width: min(380px, 92vw);
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
        z-index: 1001;
        overflow: hidden;
      }
      .os-notif-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.6rem 0.9rem;
        border-bottom: 1px solid #eef0f4;
        font-size: 0.8rem;
        color: #1f2733;
      }
      .os-notif-sub {
        color: #8a93ab;
        font-weight: 400;
      }
      .os-notif-readall {
        border: 0;
        background: transparent;
        color: #2563eb;
        font-size: 0.65rem;
        cursor: pointer;
      }
      .os-notif-list {
        max-height: 60vh;
        overflow: auto;
      }
      .os-notif-item {
        padding: 0.55rem 0.9rem;
        border-bottom: 1px solid #f3f4f7;
      }
      .os-notif-item.unread {
        background: #eef3ff;
      }
      .os-notif-row {
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      /* severity 인디케이터(점) — Carbon 어휘(info/success/warning/error) */
      .os-sev {
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #8a93ab;
      }
      .os-sev-info {
        background: #2563eb;
      }
      .os-sev-success {
        background: #1f9d57;
      }
      .os-sev-warning {
        background: #d9822b;
      }
      .os-sev-error {
        background: #e1483a;
      }
      .os-notif-title {
        font-size: 0.76rem;
        color: #1f2733;
      }
      .os-notif-detail {
        font-size: 0.65rem;
        color: #6b7280;
        margin-top: 0.1rem;
      }
      .os-notif-meta {
        font-size: 0.58rem;
        color: #aab;
        margin-top: 0.15rem;
      }
      .os-notif-src {
        color: #8a93ab;
        font-weight: 600;
      }
      .os-notif-empty {
        padding: 1.2rem 0.9rem;
        color: #8a93ab;
        font-size: 0.78rem;
      }
      .os-notif-foot {
        padding: 0.4rem 0.9rem;
        border-top: 1px solid #eef0f4;
        font-size: 0.58rem;
        color: #aab;
      }
      /* 토스트 스택 — 우상단 고정, 자동 소멸(서비스 TTL) */
      .os-toast-stack {
        position: fixed;
        top: 52px;
        right: 14px;
        z-index: 1100;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        width: min(340px, 90vw);
      }
      .os-toast {
        display: flex;
        align-items: flex-start;
        gap: 0.45rem;
        background: #fff;
        border-left: 3px solid #8a93ab;
        border-radius: 6px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
        padding: 0.55rem 0.7rem;
      }
      .os-toast .os-sev {
        margin-top: 0.28rem;
      }
      .os-toast-info {
        border-left-color: #2563eb;
      }
      .os-toast-success {
        border-left-color: #1f9d57;
      }
      .os-toast-warning {
        border-left-color: #d9822b;
      }
      .os-toast-error {
        border-left-color: #e1483a;
      }
      .os-toast-body {
        flex: 1 1 auto;
        min-width: 0;
      }
      .os-toast-title {
        font-size: 0.74rem;
        color: #1f2733;
      }
      .os-toast-detail {
        font-size: 0.63rem;
        color: #6b7280;
        margin-top: 0.1rem;
      }
      .os-toast-x {
        flex: 0 0 auto;
        border: 0;
        background: transparent;
        color: #8a93ab;
        font-size: 0.95rem;
        line-height: 1;
        cursor: pointer;
      }
    `,
  ],
})
export class OsNotifications {
  readonly notif = inject(NotificationService);
  readonly open = signal(false);

  constructor() {
    this.notif.start();
  }

  toggle(): void {
    this.open.update((v) => !v);
    if (this.open()) this.notif.refresh();
  }
}
