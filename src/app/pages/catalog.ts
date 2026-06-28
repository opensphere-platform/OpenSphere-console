import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { ApiService, CatalogEntity, RuntimeResource } from '../core/api.service';
import { OsDatagrid, OsColumn } from '../os/os-datagrid';
import { OsPanel } from '../os/os-panel';
import { BackendUnavailable } from '../os/backend-unavailable';

/**
 * Developer Catalog — rhdh-self를 headless 엔진으로 소비(헌법 §4),
 * 행 클릭은 페이지 전환이 아니라 퀵뷰 패널(R1·R4 deep-link).
 */
@Component({
  selector: 'os-catalog',
  imports: [ClarityModule, OsDatagrid, OsPanel, BackendUnavailable],
  template: `
    <h1>Developer Catalog</h1>
    <p class="os-sub">engine: rhdh-self (headless · REST 소비) — UI 임베드 0</p>

    @if (error()) {
      <os-backend-unavailable
        feature="Developer Catalog"
        backend="opensphere-catalog / rhdh-self 엔진"
        hint="카탈로그 백엔드 operand를 배포하면 자동 복구됩니다."
        [detail]="error()"
      />
    } @else {
      <os-datagrid
        [columns]="columns"
        [rows]="rows()"
        [selected]="selected()"
        (rowClick)="openQuickview($event)"
      />
    }

    <os-panel
      [open]="!!selected()"
      [title]="selected()?.metadata?.name ?? ''"
      [subtitle]="ref(selected())"
      [fullHref]="rhdhHref(selected())"
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
  readonly selected = signal<CatalogEntity | null>(null);
  readonly error = signal<string>('');
  readonly runtime = signal<RuntimeResource[] | null>(null);
  readonly runtimeError = signal<string>('');

  async ngOnInit(): Promise<void> {
    try {
      this.rows.set(await this.api.catalogEntities());
      // R4: deep-link 복원 (?quickview=kind:namespace/name)
      const q = this.route.snapshot.queryParamMap.get('quickview');
      if (q) {
        const hit = this.rows().find((e) => this.ref(e) === q);
        if (hit) {
          this.selected.set(hit);
          this.loadRuntime(hit);
        }
      }
    } catch (e) {
      this.error.set(String(e));
    }
  }

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

  rhdhHref(e: CatalogEntity | null): string {
    if (!e) return '';
    return `http://localhost:7007/catalog/${e.metadata.namespace ?? 'default'}/${e.kind.toLowerCase()}/${e.metadata.name}`;
  }

  specOf(e: CatalogEntity, key: string): string {
    const v = (e.spec ?? {})[key];
    return v == null ? '—' : String(v);
  }
}
