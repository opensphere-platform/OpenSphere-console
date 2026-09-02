import { Component, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';
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
 * 하나의 영구 감사(Supabase `audit.event`)에 기록된다. Console backend의
 * `/api/identity/audit`(newest-first)을 소비하고, 필터·정렬·페이지네이션은 Clarity datagrid에 위임한다.
 * 페이지별 산재를 없애기 위한 단일 조회 창구(각 화면은 문맥 한정 슬라이스만 별도 표시).
 */
@Component({
  selector: 'os-admin-audit',
  imports: [ClarityModule, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="감사 로그" tag="Supabase audit.event · append-only">
        <p>플랫폼 전역의 관리 변경이 하나의 영구 감사에 기록됩니다. 화면 필터와 열 정렬을 조합해 행위자·동작·대상·결과의 상관관계를 확인합니다.</p>
      </os-page-header>

      <section class="manage-status-rail" aria-label="감사 증거 요약">
        <div><span>Audit events</span><strong>{{ events().length }}</strong><small>현재 조회 범위</small></div>
        <div><span>Accepted</span><strong class="ok">{{ acceptedCount() }}</strong><small>성공·승인 결과</small></div>
        <div><span>Attention</span><strong [class.danger]="attentionCount() > 0">{{ attentionCount() }}</strong><small>실패·거부 결과</small></div>
        <div><span>Actors</span><strong>{{ actorCount() }}</strong><small>행위자·서비스</small></div>
        <div><span>Operations</span><strong>{{ actionCount() }}</strong><small>고유 관리 동작</small></div>
      </section>

      <div class="manage-toolbar">
        <div class="manage-toolbar-group"><button class="manage-filter-button" [class.active]="resultView() === 'all'" (click)="resultView.set('all')">전체</button><button class="manage-filter-button" [class.active]="resultView() === 'accepted'" (click)="resultView.set('accepted')">승인·성공</button><button class="manage-filter-button" [class.active]="resultView() === 'attention'" (click)="resultView.set('attention')">실패·거부</button><label class="clr-sr-only" for="audit-search">감사 로그 검색</label><input id="audit-search" class="manage-search" type="search" placeholder="행위자·동작·대상·사유 검색" [value]="query()" (input)="query.set(inputValue($event))" /></div>
        <div class="manage-toolbar-group"><span class="manage-toolbar-copy"><small>{{ filteredEvents().length }}건 표시 · {{ loadedAt() ? '마지막 확인 ' + fmt(loadedAt()) : '조회 중' }}</small></span><button class="btn btn-sm btn-outline" [disabled]="loading()" (click)="load()">새로고침</button></div>
      </div>

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

        <clr-dg-row *clrDgItems="let e of filteredEvents()">
          <clr-dg-cell><span class="os-mono">{{ fmt(e.time) }}</span></clr-dg-cell>
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
  readonly loadedAt = signal('');
  readonly query = signal('');
  readonly resultView = signal<'all' | 'accepted' | 'attention'>('all');
  readonly filteredEvents = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.events().filter((event) => {
      const matchesView = this.resultView() === 'all' || (this.resultView() === 'accepted' ? this.isOk(event.result) : this.isError(event.result));
      const matchesQuery = !query || [event.actor, event.action, event.target, event.result, event.reason, event.opId].some((value) => String(value || '').toLowerCase().includes(query));
      return matchesView && matchesQuery;
    });
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await this.http.request('/api/identity/audit');
      if (r.status === 401 || r.status === 403) {
        this.error.set('감사 로그 조회는 console-admins 역할이 필요합니다.');
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { items?: AuditEvent[] };
      this.events.set(Array.isArray(j.items) ? j.items : []);
      this.loadedAt.set(new Date().toISOString());
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
  acceptedCount(): number { return this.events().filter((event) => this.isOk(event.result)).length; }
  attentionCount(): number { return this.events().filter((event) => this.isError(event.result)).length; }
  actorCount(): number { return new Set(this.events().map((event) => event.actor).filter(Boolean)).size; }
  actionCount(): number { return new Set(this.events().map((event) => event.action).filter(Boolean)).size; }
  inputValue(event: Event): string { return (event.target as HTMLInputElement).value; }
  fmt(value?: string): string { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? (value || '—') : date.toISOString().replace('T', ' ').slice(0, 19); }
}
