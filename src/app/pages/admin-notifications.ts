import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { ClarityModule } from '@clr/angular';
import { Router } from '@angular/router';
import { OsPageHeader } from '../os/os-page-header';
import { NotificationService, OsNotification, OsSeverity } from '../core/notification.service';

/**
 * 알림 — 셸 단일 인박스를 "콘솔 관리" 섹션으로 흡수(정식 홈). 헤더 벨/드로어는 transient 표시,
 * /manage/notifications 가 영구 관리 surface(전체 목록·필터·정렬·읽음 관리). 같은 NotificationService 소비
 * (소스: 콘솔 audit bus DUPA + subShell in-page 발행 ctx.notify). 설계: ADR-UI-002.
 */
@Component({
  selector: 'os-admin-notifications',
  imports: [NgClass, ClarityModule, OsPageHeader],
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
        <clr-dg-column>상세</clr-dg-column>
        <clr-dg-column [clrDgField]="'time'">시각</clr-dg-column>
        <clr-dg-column>상태</clr-dg-column>
        <clr-dg-row *clrDgItems="let n of notif.items()" [clrDgItem]="n">
          @if (n.route) {
            <clr-dg-action-overflow>
              <button class="action-item" (click)="go(n)">이동</button>
            </clr-dg-action-overflow>
          }
          <clr-dg-cell><span class="label" [ngClass]="sevClass(n.severity)">{{ sevLabel(n.severity) }}</span></clr-dg-cell>
          <clr-dg-cell>{{ n.source }}</clr-dg-cell>
          <clr-dg-cell>{{ n.category || '—' }}</clr-dg-cell>
          <clr-dg-cell>{{ n.title }}</clr-dg-cell>
          <clr-dg-cell>{{ n.detail || '—' }}</clr-dg-cell>
          <clr-dg-cell>{{ fmt(n.time) }}</clr-dg-cell>
          <clr-dg-cell><span class="label" [ngClass]="n.read ? '' : 'label-info'">{{ n.read ? '읽음' : '안읽음' }}</span></clr-dg-cell>
          <clr-dg-row-detail *clrIfExpanded>
            <table class="table table-compact table-vertical">
              <tbody>
                @for (r of detailRows(n); track r.k) {
                  <tr><th class="left">{{ r.k }}</th><td class="left">{{ r.v }}</td></tr>
                }
              </tbody>
            </table>
          </clr-dg-row-detail>
        </clr-dg-row>
        <clr-dg-placeholder>알림이 없습니다</clr-dg-placeholder>
        <clr-dg-footer>
          <clr-dg-pagination #pg [clrDgPageSize]="15">{{ pg.firstItem + 1 }}-{{ pg.lastItem + 1 }} / {{ pg.totalItems }}</clr-dg-pagination>
        </clr-dg-footer>
      </clr-datagrid>
    </div>
  `,
})
export class AdminNotifications {
  readonly notif = inject(NotificationService);
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
  go(n: OsNotification): void {
    if (n.route) this.router.navigateByUrl(n.route);
  }

  /** 확장 상세 — 구조화 원본(audit meta) + 전체 필드를 key-value로. "더 구체적으로 보는 뷰". */
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
