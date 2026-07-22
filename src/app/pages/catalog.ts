import { Component, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { ApiService, CatalogEntity, RuntimeResource } from '../core/api.service';
import { OsDatagrid, OsColumn } from '../os/os-datagrid';
import { OsPanel } from '../os/os-panel';
import { BackendUnavailable } from '../os/backend-unavailable';
import { OsPageHeader } from '../os/os-page-header';

/**
 * Developer Catalog — rhdh-self를 headless 엔진으로 소비(헌법 §4),
 * 행 클릭은 페이지 전환이 아니라 퀵뷰 패널(R1·R4 deep-link).
 */
@Component({
  selector: 'os-catalog',
  imports: [ClarityModule, OsDatagrid, OsPanel, BackendUnavailable, OsPageHeader],
  template: `
    <div class="os-page">
    <os-page-header title="Developer Catalog" tag="RHDH headless · Console inventory" />
    <div class="manage-page-lead"><p>Console이 headless RHDH Catalog API를 통해 읽는 자산 인벤토리입니다. 항목을 선택하면 관계와 Kubernetes runtime evidence를 같은 문맥에서 확인할 수 있습니다.</p><span>UI embed 0 · REST only</span></div>

    <section class="manage-status-rail" aria-label="Catalog 요약">
      <div><span>Catalog entities</span><strong>{{ rows().length }}</strong><small>현재 조회 범위</small></div>
      <div><span>Components</span><strong>{{ countKind('Component') }}</strong><small>runtime evidence 대상</small></div>
      <div><span>Owners</span><strong>{{ uniqueSpec('owner') }}</strong><small>명시된 소유자</small></div>
      <div><span>Lifecycle</span><strong>{{ uniqueSpec('lifecycle') }}</strong><small>선언된 단계</small></div>
      <div><span>Source</span><strong>rhdh-self</strong><small>headless catalog engine</small></div>
    </section>

    <div class="manage-toolbar">
      <div class="manage-toolbar-copy"><strong>자산 탐색</strong><small>이름·종류·소유자·설명으로 필터링합니다.</small></div>
      <div class="manage-toolbar-group"><label class="clr-sr-only" for="catalog-search">Catalog 검색</label><input id="catalog-search" class="manage-search" type="search" placeholder="Catalog 검색" [value]="query()" (input)="query.set(inputValue($event))" /><button class="btn btn-sm btn-outline" [disabled]="loading()" (click)="refresh()">새로고침</button></div>
    </div>

    @if (forbidden()) {
      <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
        <clr-alert-item><span class="alert-text">Developer Catalog를 조회할 권한이 없습니다.</span></clr-alert-item>
      </clr-alert>
    } @else if (error()) {
      <os-backend-unavailable
        feature="Developer Catalog"
        backend="opensphere-catalog / rhdh-self 엔진"
        hint="카탈로그 백엔드 operand를 배포하면 자동 복구됩니다."
        [detail]="error()"
      />
    } @else {
      <os-datagrid
        [columns]="columns"
        [rows]="filteredRows()"
        [loading]="loading()"
        empty="검색 조건에 맞는 카탈로그 엔티티가 없습니다"
        [selected]="selected()"
        (rowClick)="openQuickview($event)"
      />
    }

    <os-panel
      [open]="!!selected()"
      [title]="selected()?.metadata?.name ?? ''"
      [subtitle]="ref(selected())"
      (closed)="closeQuickview()"
    >
      @if (selected(); as e) {
        <table class="table os-kv">
          <tbody>
            <tr>
              <td>Kind</td>
              <td>{{ e.kind }}</td>
            </tr>
            <tr>
              <td>Namespace</td>
              <td>{{ e.metadata.namespace ?? 'default' }}</td>
            </tr>
            <tr>
              <td>Description</td>
              <td>{{ e.metadata.description ?? '—' }}</td>
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
        @if (e.kind === 'Component') {
          <h3 class="os-h3">
            Runtime Resources <span class="os-engine">live · engine: kubernetes plugin</span>
          </h3>
          @if (runtime(); as rt) {
            @if (rt.length) {
              <table class="table os-rt">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Namespace / Name</th>
                    <th>Status</th>
                    <th>Cluster</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of rt; track $index) {
                    <tr>
                      <td>{{ r.type }}</td>
                      <td class="os-mono">{{ r.namespace }}/{{ r.name }}</td>
                      <td>
                        <span
                          class="label"
                          [class.label-success]="r.healthy"
                          [class.label-danger]="!r.healthy"
                          >{{ r.status }}</span
                        >
                      </td>
                      <td>{{ r.cluster }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="os-sub">매핑된 런타임 리소스 없음 (kubernetes-label-selector 주석 확인)</p>
            }
          } @else if (runtimeError()) {
            <p class="os-sub">조회 실패: {{ runtimeError() }}</p>
          } @else {
            <span class="spinner spinner-inline"></span>
          }
        }
      }
    </os-panel>
    </div>
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
      .os-kv td:first-child {
        width: 130px;
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
      .os-engine {
        font-size: 0.6rem;
        color: var(--os-muted);
        font-weight: 400;
        margin-left: 0.4rem;
      }
      .os-rt {
        font-size: 0.65rem;
      }
      .os-mono {
        font-family: monospace;
        font-size: 0.62rem;
      }
    `,
  ],
})
export class Catalog implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly columns: OsColumn[] = [
    { key: 'kind', label: 'Kind' },
    { key: 'metadata.name', label: 'Name' },
    { key: 'spec.owner', label: 'Owner' },
    { key: 'spec.type', label: 'Type' },
    { key: 'metadata.description', label: 'Description' },
  ];

  readonly rows = signal<CatalogEntity[]>([]);
  readonly query = signal('');
  readonly selected = signal<CatalogEntity | null>(null);
  readonly error = signal<string>('');
  readonly loading = signal(true);
  readonly forbidden = signal(false);
  readonly runtime = signal<RuntimeResource[] | null>(null);
  readonly runtimeError = signal<string>('');
  readonly filteredRows = computed(() => {
    const query = this.query().trim().toLowerCase();
    if (!query) return this.rows();
    return this.rows().filter((entity) => [entity.kind, entity.metadata.name, entity.metadata.description, this.specOf(entity, 'owner'), this.specOf(entity, 'type'), this.specOf(entity, 'lifecycle')].some((value) => String(value || '').toLowerCase().includes(query)));
  });

  async ngOnInit(): Promise<void> {
    await this.refresh();
    // R4: deep-link 복원 (?quickview=kind:namespace/name)
    const q = this.route.snapshot.queryParamMap.get('quickview');
    if (q) {
      const hit = this.rows().find((e) => this.ref(e) === q);
      if (hit) { this.selected.set(hit); this.loadRuntime(hit); }
    }
  }

  async refresh(): Promise<void> {
    this.loading.set(true); this.error.set(''); this.forbidden.set(false);
    try {
      this.rows.set(await this.api.catalogEntities());
    } catch (e) {
      const message = String(e);
      if (/HTTP (401|403)\b/.test(message)) this.forbidden.set(true);
      else this.error.set(message);
    } finally {
      this.loading.set(false);
    }
  }

  countKind(kind: string): number { return this.rows().filter((entity) => entity.kind === kind).length; }
  uniqueSpec(key: string): number { return new Set(this.rows().map((entity) => this.specOf(entity, key)).filter((value) => value !== '—')).size; }
  inputValue(event: Event): string { return (event.target as HTMLInputElement).value; }

  openQuickview(e: CatalogEntity): void {
    this.selected.set(e);
    this.router.navigate([], {
      queryParams: { quickview: this.ref(e) },
      queryParamsHandling: 'merge',
    });
    this.loadRuntime(e);
  }

  closeQuickview(): void {
    this.selected.set(null);
    this.router.navigate([], { queryParams: { quickview: null }, queryParamsHandling: 'merge' });
  }

  private async loadRuntime(e: CatalogEntity): Promise<void> {
    this.runtime.set(null);
    this.runtimeError.set('');
    if (e.kind !== 'Component') return;
    try {
      this.runtime.set(await this.api.runtimeResources(e));
    } catch (err) {
      this.runtimeError.set(String(err));
    }
  }

  ref(e: CatalogEntity | null): string {
    if (!e) return '';
    return `${e.kind.toLowerCase()}:${e.metadata.namespace ?? 'default'}/${e.metadata.name}`;
  }

  specOf(e: CatalogEntity, key: string): string {
    const v = (e.spec ?? {})[key];
    return v == null ? '—' : String(v);
  }
}
