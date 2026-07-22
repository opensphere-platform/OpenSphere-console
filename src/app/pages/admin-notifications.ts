import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
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
      <div class="manage-page-lead"><p>헤더 벨과 동일한 단일 인박스입니다. Console audit bus와 subShell의 <code>ctx.notify</code> 이벤트를 한곳에서 확인하고 관련 화면으로 이동할 수 있습니다.</p><span>persistent inbox · 최대 {{ notif.items().length }}</span></div>
      <section class="manage-status-rail" aria-label="알림 상태">
        <div><span>Total</span><strong>{{ notif.items().length }}</strong><small>현재 인박스 범위</small></div>
        <div><span>Unread</span><strong [class.warn]="notif.unread() > 0">{{ notif.unread() }}</strong><small>확인 필요</small></div>
        <div><span>Errors</span><strong [class.danger]="severityCount('error') > 0">{{ severityCount('error') }}</strong><small>실패·차단 이벤트</small></div>
        <div><span>Warnings</span><strong [class.warn]="severityCount('warning') > 0">{{ severityCount('warning') }}</strong><small>주의 이벤트</small></div>
        <div><span>Sources</span><strong>{{ sourceCount() }}</strong><small>발행 권위</small></div>
      </section>
      <div class="manage-toolbar">
        <div class="manage-toolbar-group"><button class="manage-filter-button" [class.active]="viewFilter() === 'all'" (click)="viewFilter.set('all')">전체</button><button class="manage-filter-button" [class.active]="viewFilter() === 'unread'" (click)="viewFilter.set('unread')">안읽음</button><button class="manage-filter-button" [class.active]="viewFilter() === 'attention'" (click)="viewFilter.set('attention')">주의 이상</button><label class="clr-sr-only" for="notification-search">알림 검색</label><input id="notification-search" class="manage-search" type="search" placeholder="제목·소스·분류 검색" [value]="query()" (input)="query.set(inputValue($event))" /></div>
        <div class="manage-toolbar-group"><span class="manage-toolbar-copy"><small>{{ filteredItems().length }}건 표시</small></span><button class="btn btn-sm btn-outline" (click)="notif.refresh()">새로고침</button><button class="btn btn-sm btn-outline" [disabled]="!notif.unread()" (click)="notif.markAllRead()">모두 읽음</button></div>
      </div>

      <clr-datagrid>
        <clr-dg-column [clrDgField]="'severity'">심각도</clr-dg-column>
        <clr-dg-column [clrDgField]="'source'">소스</clr-dg-column>
        <clr-dg-column [clrDgField]="'category'">분류</clr-dg-column>
        <clr-dg-column [clrDgField]="'title'">제목</clr-dg-column>
        <clr-dg-column [clrDgField]="'time'">시각</clr-dg-column>
        <clr-dg-column>상태</clr-dg-column>
        <clr-dg-row
          *clrDgItems="let n of filteredItems()"
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
  readonly query = signal('');
  readonly viewFilter = signal<'all' | 'unread' | 'attention'>('all');
  readonly filteredItems = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.notif.items().filter((item) => {
      const matchesView = this.viewFilter() === 'all' || (this.viewFilter() === 'unread' ? !item.read : item.severity === 'warning' || item.severity === 'error');
      const matchesQuery = !query || [item.title, item.detail, item.source, item.category, item.topic].some((value) => String(value || '').toLowerCase().includes(query));
      return matchesView && matchesQuery;
    });
  });
  private router = inject(Router);

  constructor() { this.notif.start(); this.notif.refresh(); }

  severityCount(severity: OsSeverity): number { return this.notif.items().filter((item) => item.severity === severity).length; }
  sourceCount(): number { return new Set(this.notif.items().map((item) => item.source)).size; }
  inputValue(event: Event): string { return (event.target as HTMLInputElement).value; }

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
