import { Component, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import {
  ManualService,
  ManualSource,
  ManualDocument,
  ManualSearchHit,
  ManualDocumentDetail,
} from '../core/manual.service';
import { OsDatagrid, OsColumn } from '../os/os-datagrid';
import { OsPanel } from '../os/os-panel';
import { BackendUnavailable } from '../os/backend-unavailable';

/**
 * Manual — Main Shell 네이티브 페이지(§manual-native-console: subShell/plugin/Consumer 아님).
 * OAA Manual Registry(/api/manual/*)를 유일한 데이터 소스로 소비한다(§ManualService 재사용,
 * 별도 데이터 모델·레거시 docs.ts 카탈로그 하드코딩 금지). 딥링크 `/manual?doc=<sourceId>`.
 * 본문은 전부 텍스트 보간({{ }})으로만 렌더 — innerHTML 미사용(안전 렌더링).
 */
@Component({
  selector: 'os-manual',
  imports: [ClarityModule, FormsModule, OsDatagrid, OsPanel, BackendUnavailable],
  template: `
    <h1>Manual</h1>
    <p class="os-sub">OpenSphere Manual — OAA Manual Registry 소스/문서 탐색 및 검색</p>

    @if (forbidden()) {
      <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
        <clr-alert-item><span class="alert-text">Manual을 조회할 권한이 없습니다.</span></clr-alert-item>
      </clr-alert>
    } @else if (docsError()) {
      <os-backend-unavailable
        feature="Manual"
        backend="OAA Manual Registry (/api/manual)"
        hint="Manual Registry 백엔드(OAA Gateway)가 배포되면 자동 복구됩니다."
        [detail]="docsError()"
      />
    } @else {
      <form clrForm clrLayout="vertical" class="clr-row os-manual-search" (ngSubmit)="runSearch()">
        <div class="clr-col">
          <clr-input-container>
            <label>검색</label>
            <input
              clrInput
              name="mq"
              [ngModel]="query()"
              (ngModelChange)="query.set($event)"
              placeholder="Manual, 10 Perspective, OAA Gateway, Backbone..."
            />
          </clr-input-container>
        </div>
        <div class="clr-col-auto os-search-actions">
          <button type="submit" class="btn btn-primary" [disabled]="searchLoading() || !query().trim()">검색</button>
          @if (hasSearched()) {
            <button type="button" class="btn btn-link" (click)="clearSearch()">초기화</button>
          }
        </div>
      </form>

      @if (searchLoading()) {
        <div class="os-search-state"><span class="spinner spinner-inline"></span> 검색 중…</div>
      } @else if (searchError()) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">검색 실패: {{ searchError() }}</span>
            <div class="alert-actions">
              <button type="button" class="btn alert-action" (click)="runSearch()">다시 시도</button>
            </div>
          </clr-alert-item>
        </clr-alert>
      } @else if (hasSearched() && searchHits().length === 0) {
        <p class="os-sub">'{{ query() }}'에 대한 검색 결과가 없습니다.</p>
      } @else if (searchHits().length) {
        <section class="os-manual-hits">
          <h3 class="os-h3">검색 결과 <span class="os-count">{{ searchHits().length }}</span></h3>
          <ul class="os-hit-list">
            @for (hit of searchHits(); track hit.documentId + ':' + hit.chunkIndex) {
              <li>
                <button type="button" class="os-hit" (click)="openDocument(hit.sourceId)">
                  <strong>{{ hit.title }}</strong>
                  <span class="os-hit-excerpt">{{ hit.excerpt }}</span>
                  <small class="os-hit-meta"
                    >{{ hit.sourceName || hit.sourceId }} · v{{ hit.version }} ·
                    {{ hit.documentType || 'reference' }} · score {{ scoreOf(hit.score) }}</small
                  >
                </button>
              </li>
            }
          </ul>
        </section>
      }

      @if (sources().length) {
        <div class="os-source-chips" role="group" aria-label="소스 필터">
          <button
            type="button"
            class="label"
            [class.label-info]="!sourceFilter()"
            (click)="selectSource('')"
          >
            전체
          </button>
          @for (s of sources(); track s.id) {
            <button
              type="button"
              class="label"
              [class.label-info]="sourceFilter() === s.id"
              (click)="selectSource(s.id)"
              [title]="s.type"
            >
              {{ s.name }} <span class="os-chip-count">{{ s.documents }}</span>
            </button>
          }
        </div>
      }

      <os-datagrid
        [columns]="columns"
        [rows]="documents()"
        [loading]="docsLoading()"
        empty="등록된 Manual 문서가 없습니다"
        [selected]="selectedDoc()"
        (rowClick)="openDocument($event.sourceId)"
      />
    }

    <os-panel [open]="!!selectedDocId()" [title]="panelTitle()" [subtitle]="detailSubtitle()" (closed)="closeDocument()">
      @if (detailLoading()) {
        <span class="spinner spinner-inline"></span>
      } @else if (detailError()) {
        <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">문서를 불러오지 못했습니다: {{ detailError() }}</span>
            <div class="alert-actions">
              <button type="button" class="btn alert-action" (click)="retryDocument()">다시 시도</button>
            </div>
          </clr-alert-item>
        </clr-alert>
      } @else if (detail(); as d) {
        <div class="os-manual-meta">
          <span class="label">{{ d.item.sourceName || d.item.sourceId }}</span>
          <span class="label">v{{ d.item.version }}</span>
          <span class="label">{{ d.item.documentType || 'reference' }}</span>
          @if (d.item.authorityTier != null) {
            <span class="label">tier {{ d.item.authorityTier }}</span>
          }
          <span class="label">{{ d.item.status }}</span>
        </div>
        <p class="os-manual-summary">{{ d.item.summary }}</p>
        @if (tagsOf(d.item).length) {
          <div class="os-tags">
            @for (tag of tagsOf(d.item); track tag) {
              <span class="badge">{{ tag }}</span>
            }
          </div>
        }
        @if (d.actionBindings.length) {
          <h3 class="os-h3">Manual-backed Actions</h3>
          <ul class="os-actions">
            @for (a of d.actionBindings; track a.id) {
              <li><strong>{{ a.intent || a.id }}</strong> — {{ a.toolId }} / {{ a.riskLevel }} / {{ a.confirmation }}</li>
            }
          </ul>
        }
        <h3 class="os-h3">Content</h3>
        @if (d.chunks.length) {
          <div class="os-chunks">
            @for (chunk of d.chunks; track chunk.chunkIndex) {
              <div class="os-chunk">
                <div class="os-chunk-idx">#{{ chunk.chunkIndex + 1 }}</div>
                <p class="os-chunk-body">{{ chunk.content }}</p>
              </div>
            }
          </div>
        } @else {
          <p class="os-sub">본문 청크가 없습니다.</p>
        }
        <p class="os-source-identity">
          Source: <code>{{ d.item.sourceId }}</code>
          @if (d.item.sourcePath) {
            · {{ d.item.sourcePath }}
          }
          @if (d.item.sourceUrl) {
            · <a [href]="d.item.sourceUrl" target="_blank" rel="noopener">원본 링크 ↗</a>
          }
        </p>
      }
    </os-panel>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-sub {
        color: var(--os-muted);
        font-size: 0.7rem;
        margin: 0.3rem 0 0.8rem;
      }
      .os-h3 {
        color: var(--os-ink);
        font-size: 0.8rem;
        margin-top: 1rem;
      }
      .os-manual-search {
        align-items: flex-end;
        margin-bottom: 0.6rem;
      }
      .os-search-actions {
        display: flex;
        gap: 0.4rem;
        align-items: center;
        padding-bottom: 0.4rem;
      }
      .os-search-state {
        color: var(--os-muted);
        font-size: 0.75rem;
        margin: 0.5rem 0;
      }
      .os-manual-hits {
        margin-bottom: 1rem;
      }
      .os-count {
        color: var(--os-muted);
        font-size: 0.7rem;
        font-weight: 400;
      }
      .os-hit-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.4rem;
      }
      .os-hit {
        width: 100%;
        text-align: left;
        border: 1px solid var(--os-hairline, #d9dee5);
        background: var(--os-surface-0, #fff);
        border-radius: 4px;
        padding: 0.55rem 0.75rem;
        cursor: pointer;
        display: grid;
        gap: 0.2rem;
      }
      .os-hit:hover {
        background: var(--os-surface-1);
      }
      .os-hit-excerpt {
        font-size: 0.72rem;
        color: var(--os-ink-muted, #525252);
      }
      .os-hit-meta {
        font-size: 0.65rem;
        color: var(--os-muted);
      }
      .os-source-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        margin-bottom: 0.6rem;
      }
      .os-source-chips button.label {
        cursor: pointer;
        border: 1px solid transparent;
      }
      .os-chip-count {
        opacity: 0.75;
        margin-left: 0.2rem;
      }
      .os-manual-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        margin-bottom: 0.6rem;
      }
      .os-manual-summary {
        font-size: 0.8rem;
        color: var(--os-ink-muted, #525252);
        line-height: 1.5;
      }
      .os-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        margin: 0.5rem 0;
      }
      .os-actions {
        list-style: none;
        margin: 0.4rem 0 0;
        padding: 0;
        font-size: 0.75rem;
        display: grid;
        gap: 0.3rem;
      }
      .os-chunks {
        display: grid;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
      .os-chunk {
        display: grid;
        grid-template-columns: 2rem minmax(0, 1fr);
        gap: 0.6rem;
        border: 1px solid var(--os-hairline, #d9dee5);
        border-radius: 4px;
        padding: 0.6rem 0.75rem;
      }
      .os-chunk-idx {
        color: var(--os-muted);
        font-size: 0.65rem;
        font-weight: 700;
      }
      .os-chunk-body {
        margin: 0;
        font-size: 0.78rem;
        line-height: 1.55;
        white-space: pre-wrap;
      }
      .os-source-identity {
        margin-top: 1rem;
        font-size: 0.68rem;
        color: var(--os-muted);
      }
      .os-source-identity code {
        font-family: monospace;
        font-size: 0.65rem;
      }
    `,
  ],
})
export class ManualPage implements OnInit {
  private manual = inject(ManualService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly columns: OsColumn[] = [
    { key: 'title', label: 'Title' },
    { key: 'sourceName', label: 'Source' },
    { key: 'version', label: 'Version' },
    { key: 'documentType', label: 'Type' },
    { key: 'updatedAt', label: 'Updated' },
  ];

  readonly sources = signal<ManualSource[]>([]);
  readonly documents = signal<ManualDocument[]>([]);
  readonly docsLoading = signal(true);
  readonly docsError = signal('');
  readonly forbidden = signal(false);
  readonly sourceFilter = signal('');

  readonly query = signal('');
  readonly searchLoading = signal(false);
  readonly searchError = signal('');
  readonly searchHits = signal<ManualSearchHit[]>([]);
  readonly hasSearched = signal(false);

  readonly selectedDocId = signal('');
  readonly detail = signal<ManualDocumentDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal('');

  readonly selectedDoc = computed(
    () => this.documents().find((d) => d.sourceId === this.selectedDocId()) ?? null,
  );

  async ngOnInit(): Promise<void> {
    await this.loadCatalog();
    const docParam = this.route.snapshot.queryParamMap.get('doc');
    if (docParam) await this.openDocument(docParam);
  }

  private async loadCatalog(): Promise<void> {
    this.docsLoading.set(true);
    this.docsError.set('');
    this.forbidden.set(false);
    try {
      const [sources, documents] = await Promise.all([
        this.manual.sources(),
        this.manual.documents('', this.sourceFilter()),
      ]);
      this.sources.set(sources);
      this.documents.set(documents);
    } catch (e) {
      const message = String(e);
      if (/HTTP (401|403)\b/.test(message)) this.forbidden.set(true);
      else this.docsError.set(message);
    } finally {
      this.docsLoading.set(false);
    }
  }

  selectSource(id: string): void {
    this.sourceFilter.set(this.sourceFilter() === id ? '' : id);
    void this.loadCatalog();
  }

  async runSearch(): Promise<void> {
    const q = this.query().trim();
    if (!q) return;
    this.searchLoading.set(true);
    this.searchError.set('');
    this.hasSearched.set(true);
    try {
      this.searchHits.set(await this.manual.search(q, 20));
    } catch (e) {
      this.searchError.set(String(e));
      this.searchHits.set([]);
    } finally {
      this.searchLoading.set(false);
    }
  }

  clearSearch(): void {
    this.query.set('');
    this.searchHits.set([]);
    this.hasSearched.set(false);
    this.searchError.set('');
  }

  async openDocument(sourceId: string): Promise<void> {
    if (!sourceId) return;
    this.selectedDocId.set(sourceId);
    this.detail.set(null);
    this.detailLoading.set(true);
    this.detailError.set('');
    try {
      this.detail.set(await this.manual.document(sourceId));
      void this.router.navigate([], { queryParams: { doc: sourceId }, queryParamsHandling: 'merge' });
    } catch (e) {
      this.detailError.set(String(e));
    } finally {
      this.detailLoading.set(false);
    }
  }

  retryDocument(): void {
    if (this.selectedDocId()) void this.openDocument(this.selectedDocId());
  }

  closeDocument(): void {
    this.detail.set(null);
    this.selectedDocId.set('');
    this.detailError.set('');
    void this.router.navigate([], { queryParams: { doc: null }, queryParamsHandling: 'merge' });
  }

  panelTitle(): string {
    return this.detail()?.item?.title ?? (this.detailLoading() ? '불러오는 중…' : '');
  }

  detailSubtitle(): string {
    const d = this.detail();
    if (!d) return '';
    return `${d.item.sourceName || d.item.sourceId} · v${d.item.version}`;
  }

  scoreOf(score: number): string {
    return Number(score || 0).toFixed(2);
  }

  tagsOf(item: ManualDocument): string[] {
    return [...(item.tags || []), ...(item.perspective || [])];
  }
}
