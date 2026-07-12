import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { OsPageHeader } from '../os/os-page-header';
import { HttpService } from '../core/http.service';

interface AuditEvent {
  time?: string;
  actor?: string;
  action?: string;
  target?: string;
  result?: string;
  reason?: string;
  opId?: string;
}

/**
 * 감사 로그 (전역 SSOT) — 플랫폼 전역의 관리 변경(신원·역할·PAT·플러그인·바인딩·백본 등)이
 * 하나의 영구 감사(Backbone PostgreSQL audit_log)에 기록된다. controller `/api/admin/plugins/events`
 * (최근 AUDIT_CAP=500건, newest-first)를 소비하고, 필터·정렬·페이지네이션은 Clarity datagrid에 위임한다.
 * 페이지별 산재를 없애기 위한 단일 조회 창구(각 화면은 문맥 한정 슬라이스만 별도 표시).
 */
@Component({
  selector: 'os-admin-audit',
  imports: [ClarityModule, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="감사 로그" tag="Backbone PostgreSQL · 영구 감사">
        <p>플랫폼 전역의 관리 변경이 하나의 영구 감사에 기록됩니다. 열 머리글로 필터·정렬하고, 하단에서 페이지를 넘기세요.</p>
      </os-page-header>

      @if (error(); as e) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="true" (clrAlertClosedChange)="error.set('')">
          <clr-alert-item><span class="alert-text">{{ e }}</span></clr-alert-item>
        </clr-alert>
      }

      <clr-datagrid [clrDgLoading]="loading()">
        <clr-dg-column [clrDgField]="'time'">시각</clr-dg-column>
        <clr-dg-column [clrDgField]="'actor'">행위자 / 소스</clr-dg-column>
        <clr-dg-column [clrDgField]="'action'">동작</clr-dg-column>
        <clr-dg-column [clrDgField]="'target'">대상</clr-dg-column>
        <clr-dg-column [clrDgField]="'result'">결과</clr-dg-column>
        <clr-dg-column [clrDgField]="'reason'">사유</clr-dg-column>

        <clr-dg-row *clrDgItems="let e of events()">
          <clr-dg-cell><span class="os-mono">{{ e.time }}</span></clr-dg-cell>
          <clr-dg-cell>{{ e.actor }}</clr-dg-cell>
          <clr-dg-cell><code>{{ e.action }}</code></clr-dg-cell>
          <clr-dg-cell>{{ e.target }}</clr-dg-cell>
          <clr-dg-cell>
            <span class="label" [class.label-danger]="isError(e.result)" [class.label-success]="isOk(e.result)">{{ e.result || '—' }}</span>
          </clr-dg-cell>
          <clr-dg-cell>{{ e.reason }}</clr-dg-cell>
        </clr-dg-row>

        <clr-dg-placeholder>감사 항목이 없습니다</clr-dg-placeholder>
        <clr-dg-footer>
          <clr-dg-pagination #pg [clrDgPageSize]="25">
            <clr-dg-page-size [clrPageSizeOptions]="[25, 50, 100]">페이지당</clr-dg-page-size>
            {{ pg.firstItem + 1 }}–{{ pg.lastItem + 1 }} / {{ pg.totalItems }} · 최근 {{ events().length }}건
          </clr-dg-pagination>
        </clr-dg-footer>
      </clr-datagrid>
    </div>
  `,
  styles: [
    `
      .os-mono { font-family: var(--os-font-mono, monospace); font-size: 0.68rem; color: var(--os-ink-muted); white-space: nowrap; }
      .label { margin: 0; }
    `,
  ],
})
export class AdminAudit {
  private readonly http = inject(HttpService);
  readonly events = signal<AuditEvent[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await this.http.request('/api/admin/plugins/events');
      if (r.status === 401 || r.status === 403) {
        this.error.set('감사 로그 조회는 관리자 권한이 필요합니다 (opensphere-console-admins).');
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { items?: AuditEvent[] };
      this.events.set(Array.isArray(j.items) ? j.items : []);
    } catch (e) {
      this.error.set(`감사 로그를 불러오지 못했습니다: ${String(e)}`);
    } finally {
      this.loading.set(false);
    }
  }

  isError(result?: string): boolean {
    return /error|denied|reject|fail/i.test(result || '');
  }
  isOk(result?: string): boolean {
    return /\bok\b|accept|success/i.test(result || '');
  }
}
