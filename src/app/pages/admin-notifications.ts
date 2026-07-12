import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { ClarityModule } from '@clr/angular';
import { Router } from '@angular/router';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';
import { NotificationService, OsNotification, OsSeverity } from '../core/notification.service';

/**
 * 알림 — 셸 단일 인박스를 "콘솔 관리" 섹션으로 흡수(정식 홈). 헤더 벨/드로어는 transient 표시,
 * /manage/notifications 가 영구 관리 surface(전체 목록·필터·정렬·읽음 관리). 같은 NotificationService 소비
 * (소스: 콘솔 audit bus DUPA + subShell in-page 발행 ctx.notify). 설계: ADR-UI-002.
 */
@Component({
  selector: 'os-admin-notifications',
  imports: [NgClass, ClarityModule, OsPageHeader, OsPanel],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="알림" tag="Core·Admin · 셸 단일 인박스(audit bus + subShell 발행)" />
      <p class="os-sub">
        헤더 벨과 동일한 <strong>단일 인박스</strong>를 관리 화면으로 흡수 — 소스: 콘솔 audit bus(<code>DUPA</code>) · subShell in-page 발행(<code>ctx.notify</code>).
        전체 {{ notif.items().length }} · 안읽음 <strong>{{ notif.unread() }}</strong>.
      </p>
      <div class="os-actions">
        <button class="btn btn-sm btn-outline" (click)="notif.refresh()">새로고침</button>
        <button class="btn btn-sm btn-outline" [disabled]="!notif.unread()" (click)="notif.markAllRead()">모두 읽음</button>
      </div>

      <clr-datagrid>
        <clr-dg-column [clrDgField]="'severity'">심각도</clr-dg-column>
        <clr-dg-column [clrDgField]="'source'">소스</clr-dg-column>
        <clr-dg-column [clrDgField]="'category'">분류</clr-dg-column>
        <clr-dg-column [clrDgField]="'title'">제목</clr-dg-column>
        <clr-dg-column [clrDgField]="'time'">시각</clr-dg-column>
        <clr-dg-column>상태</clr-dg-column>
        <clr-dg-row
          *clrDgItems="let n of notif.items()"
          [clrDgItem]="n"
          class="os-notification-row"
          tabindex="0"
          (click)="open(n)"
          (keydown.enter)="open(n)"
        >
          @if (n.route) {
            <clr-dg-action-overflow>
              <button class="action-item" (click)="go(n, $event)">이동</button>
            </clr-dg-action-overflow>
          }
          <clr-dg-cell><span class="label" [ngClass]="sevClass(n.severity)">{{ sevLabel(n.severity) }}</span></clr-dg-cell>
          <clr-dg-cell>{{ n.source }}</clr-dg-cell>
          <clr-dg-cell>{{ n.category || '—' }}</clr-dg-cell>
          <clr-dg-cell>{{ n.title }}</clr-dg-cell>
          <clr-dg-cell>{{ fmt(n.time) }}</clr-dg-cell>
          <clr-dg-cell><span class="label" [ngClass]="n.read ? '' : 'label-info'">{{ n.read ? '읽음' : '안읽음' }}</span></clr-dg-cell>
        </clr-dg-row>
        <clr-dg-placeholder>알림이 없습니다</clr-dg-placeholder>
        <clr-dg-footer>
          <clr-dg-pagination #pg [clrDgPageSize]="15">{{ pg.firstItem + 1 }}-{{ pg.lastItem + 1 }} / {{ pg.totalItems }}</clr-dg-pagination>
        </clr-dg-footer>
      </clr-datagrid>

      <os-panel
        [open]="!!selected()"
        [title]="selected()?.title || '알림 상세'"
        [subtitle]="selectedSubtitle()"
        (closed)="close()"
      >
        @if (selected(); as n) {
          <section class="os-notification-detail" aria-label="알림 상세 정보">
            <div class="os-detail-summary">
              <span class="label" [ngClass]="sevClass(n.severity)">{{ sevLabel(n.severity) }}</span>
              <span class="label" [ngClass]="n.read ? '' : 'label-info'">{{ n.read ? '읽음' : '안읽음' }}</span>
            </div>
            @if (n.detail) {
              <p class="os-detail-message">{{ n.detail }}</p>
            }
            <table class="table table-compact table-vertical os-detail-table">
              <tbody>
                @for (r of detailRows(n); track r.k) {
                  <tr><th class="left">{{ r.k }}</th><td class="left">{{ r.v }}</td></tr>
                }
              </tbody>
            </table>
            @if (n.route) {
              <button class="btn btn-primary" (click)="go(n)">관련 화면으로 이동</button>
            }
          </section>
        }
      </os-panel>
    </div>
  `,
  styles: [`
    .os-notification-row { cursor: pointer; }
    .os-notification-row:focus-visible { outline: 2px solid var(--cds-alias-object-interaction-color, #0072a3); outline-offset: -2px; }
    .os-notification-detail { padding: 0.25rem 0 1rem; }
    .os-detail-summary { display: flex; gap: 0.4rem; margin-bottom: 1rem; }
    .os-detail-message { margin: 0 0 1rem; padding: 0.8rem; border-left: 3px solid var(--cds-alias-object-interaction-color, #0072a3); background: var(--cds-alias-object-container-background-tint, #f1f6f8); white-space: pre-wrap; }
    .os-detail-table { margin: 0 0 1rem; width: 100%; }
    .os-detail-table th { width: 11rem; }
    .os-detail-table td { overflow-wrap: anywhere; }
  `],
})
export class AdminNotifications {
  readonly notif = inject(NotificationService);
  readonly selected = signal<OsNotification | null>(null);
  private router = inject(Router);

  constructor() { this.notif.start(); this.notif.refresh(); }

  sevClass(s: OsSeverity): string {
    return { info: 'label-info', success: 'label-success', warning: 'label-warning', error: 'label-danger' }[s] || '';
  }
  sevLabel(s: OsSeverity): string {
    return { info: '정보', success: '성공', warning: '경고', error: '오류' }[s] || s;
  }
  fmt(t: string): string {
    const d = new Date(t);
    return isNaN(d.getTime()) ? t : d.toISOString().replace('T', ' ').slice(0, 19);
  }
  open(n: OsNotification): void {
    if (!n.read) {
      this.notif.markRead(n.id);
      this.selected.set({ ...n, read: true });
      return;
    }
    this.selected.set(n);
  }
  close(): void {
    this.selected.set(null);
  }
  selectedSubtitle(): string {
    const n = this.selected();
    return n ? `${n.source} · ${n.category || '일반'} · ${this.fmt(n.time)}` : '';
  }
  go(n: OsNotification, event?: Event): void {
    event?.stopPropagation();
    this.close();
    if (n.route) this.router.navigateByUrl(n.route);
  }

  /** 우측 상세 패널 — 구조화 원본(audit meta) + 전체 필드를 key-value로 표시한다. */
  detailRows(n: OsNotification): { k: string; v: string }[] {
    const m = n.meta || {};
    const rows: { k: string; v: string }[] = [];
    if (m['actor']) rows.push({ k: '행위자 (actor)', v: m['actor'] });
    if (m['action']) rows.push({ k: '동작 (action)', v: m['action'] });
    if (m['target']) rows.push({ k: '대상 (target)', v: m['target'] });
    if (m['result']) rows.push({ k: '결과 (result)', v: m['result'] });
    if (m['reason']) rows.push({ k: '사유 (reason)', v: m['reason'] });
    rows.push({ k: '소스 (source)', v: n.source });
    if (n.category) rows.push({ k: '분류 (category)', v: n.category });
    rows.push({ k: '심각도 (severity)', v: this.sevLabel(n.severity) + ' / ' + n.severity });
    rows.push({ k: '제목 (title)', v: n.title });
    if (n.detail) rows.push({ k: '상세 (detail)', v: n.detail });
    if (n.route) rows.push({ k: '경로 (route)', v: n.route });
    if (n.topic) rows.push({ k: '토픽 (topic)', v: n.topic });
    rows.push({ k: '발생 시각', v: this.fmt(n.time) });
    rows.push({ k: '읽음 상태', v: n.read ? '읽음' : '안읽음' });
    rows.push({ k: '적재 (persistent)', v: n.persistent ? '인박스' : '토스트' });
    rows.push({ k: 'id', v: n.id });
    return rows;
  }
}
