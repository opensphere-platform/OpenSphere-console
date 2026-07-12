import {
  Component,
  OnInit,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { ApiService, CatalogEntity } from '../core/api.service';
import { OsDatagrid, OsColumn } from '../os/os-datagrid';
import { OsPanel } from '../os/os-panel';
import { BackendUnavailable } from '../os/backend-unavailable';

/**
 * APIs — RHDH 'API Explorer'의 셸판. kind=API 엔티티 목록 + 퀵뷰에서 OpenAPI 스펙 원문.
 * 필터: Clarity clr-select-container(clrSelect) — 데이터 도출형 클라이언트 필터.
 */
@Component({
  selector: 'os-apis',
  imports: [ClarityModule, FormsModule, OsDatagrid, OsPanel, BackendUnavailable],
  template: `
    <h1>APIs</h1>
    <p class="os-sub">조직의 API 인벤토리 — engine: rhdh-self catalog (kind=API)</p>

    @if (error()) {
      <os-backend-unavailable
        feature="APIs"
        backend="opensphere-catalog / rhdh-self 엔진 (kind=API)"
        hint="카탈로그 백엔드 operand를 배포하면 자동 복구됩니다."
        [detail]="error()"
      />
    } @else {
      <form clrForm clrLayout="vertical" class="clr-row os-filters">
        <div class="clr-col-auto">
          <clr-select-container>
            <label>Type</label>
            <select clrSelect name="ftype" [ngModel]="fType()" (ngModelChange)="fType.set($event)">
              <option value="">전체</option>
              @for (v of values('type'); track v) {
                <option [value]="v">{{ v }}</option>
              }
            </select>
          </clr-select-container>
        </div>
        <div class="clr-col-auto">
          <clr-select-container>
            <label>Owner</label>
            <select
              clrSelect
              name="fowner"
              [ngModel]="fOwner()"
              (ngModelChange)="fOwner.set($event)"
            >
              <option value="">전체</option>
              @for (v of values('owner'); track v) {
                <option [value]="v">{{ v }}</option>
              }
            </select>
          </clr-select-container>
        </div>
        <div class="clr-col-auto">
          <clr-select-container>
            <label>Lifecycle</label>
            <select
              clrSelect
              name="flifecycle"
              [ngModel]="fLifecycle()"
              (ngModelChange)="fLifecycle.set($event)"
            >
              <option value="">전체</option>
              @for (v of values('lifecycle'); track v) {
                <option [value]="v">{{ v }}</option>
              }
            </select>
          </clr-select-container>
        </div>
        <div class="clr-col os-count">{{ filtered().length }} / {{ rows().length }} 건</div>
      </form>
      <os-datagrid
        [columns]="columns"
        [rows]="filtered()"
        [selected]="selected()"
        (rowClick)="openQuickview($event)"
      />
    }

    <os-panel
      [open]="!!selected()"
      [title]="titleOf(selected())"
      [subtitle]="ref(selected())"
      [fullHref]="rhdhHref(selected())"
      (closed)="closeQuickview()"
    >
      @if (selected(); as e) {
        <table class="table os-kv">
          <tbody>
            <tr>
              <td>System</td>
              <td>{{ specOf(e, 'system') }}</td>
            </tr>
            <tr>
              <td>Owner</td>
              <td>{{ specOf(e, 'owner') }}</td>
            </tr>
            <tr>
              <td>Type</td>
              <td>{{ specOf(e, 'type') }}</td>
            </tr>
            <tr>
              <td>Lifecycle</td>
              <td>{{ specOf(e, 'lifecycle') }}</td>
            </tr>
            <tr>
              <td>Description</td>
              <td>{{ e.metadata.description ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        @if (e.relations?.length) {
          <h3 class="os-h3">Relations</h3>
          <ul class="os-rel">
            @for (r of e.relations; track $index) {
              <li>
                <span class="badge">{{ r.type }}</span> {{ r.targetRef }}
              </li>
            }
          </ul>
        }
        @if (definition(e); as def) {
          <h3 class="os-h3">Definition (OpenAPI)</h3>
          <pre class="os-code">{{ def }}</pre>
        }
      }
    </os-panel>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-h3 {
        color: var(--os-ink);
        font-size: 0.8rem;
        margin-top: 1rem;
      }
      .os-sub {
        color: var(--os-muted);
        font-size: 0.7rem;
        margin: 0.3rem 0 0.8rem;
      }
      .os-filters {
        align-items: flex-end;
        margin-bottom: 0.6rem;
      }
      .os-count {
        font-size: 0.65rem;
        color: var(--os-muted);
        text-align: right;
        align-self: flex-end;
        padding-bottom: 0.4rem;
      }
      .os-kv td:first-child {
        width: 110px;
        color: var(--os-muted);
      }
      .os-rel {
        list-style: none;
        padding: 0;
      }
      .os-rel li {
        margin: 0.25rem 0;
        font-size: 0.7rem;
      }
      /* [예외 등록 #2] Clarity에 코드 블록 컴포넌트 부재 — DESIGN-GUIDE.md §8 */
      .os-code {
        background: var(--os-brand-900, #0b1530);
        color: #d7e0f5;
        border-radius: 6px;
        padding: 0.8rem 1rem;
        font-size: 0.62rem;
        line-height: 1.5;
        overflow: auto;
        max-height: 50vh;
      }
    `,
  ],
})
export class Apis implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly columns: OsColumn[] = [
    { key: 'metadata.name', label: 'Name' },
    { key: 'spec.system', label: 'System' },
    { key: 'spec.owner', label: 'Owner' },
    { key: 'spec.type', label: 'Type' },
    { key: 'spec.lifecycle', label: 'Lifecycle' },
    { key: 'metadata.description', label: 'Description' },
  ];

  readonly rows = signal<CatalogEntity[]>([]);
  readonly selected = signal<CatalogEntity | null>(null);
  readonly error = signal<string>('');
  readonly fType = signal<string>('');
  readonly fOwner = signal<string>('');
  readonly fLifecycle = signal<string>('');

  readonly filtered = computed(() =>
    this.rows().filter(
      (e) =>
        (!this.fType() || this.specOf(e, 'type') === this.fType()) &&
        (!this.fOwner() || this.specOf(e, 'owner') === this.fOwner()) &&
        (!this.fLifecycle() || this.specOf(e, 'lifecycle') === this.fLifecycle()),
    ),
  );

  async ngOnInit(): Promise<void> {
    try {
      this.rows.set(await this.api.apiEntities());
      const q = this.route.snapshot.queryParamMap.get('quickview');
      if (q) {
        const hit = this.rows().find((e) => this.ref(e) === q);
        if (hit) this.selected.set(hit);
      }
    } catch (e) {
      this.error.set(String(e));
    }
  }

  values(key: string): string[] {
    return [
      ...new Set(
        this.rows()
          .map((e) => this.specOf(e, key))
          .filter((v) => v !== '—'),
      ),
    ].sort();
  }

  openQuickview(e: CatalogEntity): void {
    this.selected.set(e);
    this.router.navigate([], {
      queryParams: { quickview: this.ref(e) },
      queryParamsHandling: 'merge',
    });
  }

  closeQuickview(): void {
    this.selected.set(null);
    this.router.navigate([], { queryParams: { quickview: null }, queryParamsHandling: 'merge' });
  }

  ref(e: CatalogEntity | null): string {
    if (!e) return '';
    return `api:${e.metadata.namespace ?? 'default'}/${e.metadata.name}`;
  }

  titleOf(e: CatalogEntity | null): string {
    if (!e) return '';
    return String((e.metadata as Record<string, unknown>)['title'] ?? e.metadata.name);
  }

  rhdhHref(e: CatalogEntity | null): string {
    if (!e) return '';
    return `http://localhost:7007/catalog/${e.metadata.namespace ?? 'default'}/api/${e.metadata.name}`;
  }

  specOf(e: CatalogEntity, key: string): string {
    const v = (e.spec ?? {})[key];
    return v == null ? '—' : String(v);
  }

  definition(e: CatalogEntity): string {
    return String((e.spec ?? {})['definition'] ?? '').trim();
  }
}
