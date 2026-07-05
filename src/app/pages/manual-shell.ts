import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import {
  ManualActionBinding,
  ManualDocument,
  ManualDocumentDetail,
  ManualSearchHit,
  ManualService,
  ManualSource,
} from '../core/manual.service';

@Component({
  selector: 'os-manual-shell',
  imports: [ClarityModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <section class="manual-shell">
      <aside class="manual-side" aria-label="Manual navigation">
        <div class="manual-side-head">
          <h1>Manual</h1>
          <button class="btn btn-sm btn-outline" [disabled]="loading()" (click)="reload()">Refresh</button>
        </div>

        <label class="manual-search">
          <span>Search manuals</span>
          <input
            class="clr-input"
            name="manual-q"
            [(ngModel)]="queryText"
            placeholder="10 perspective, OAA, Backbone..."
            (keyup.enter)="search()"
          />
        </label>

        <label class="manual-search">
          <span>Source</span>
          <select class="clr-select" name="manual-source" [(ngModel)]="sourceFilter" (change)="search()">
            <option value="">All sources</option>
            @for (s of sources(); track s.id) {
              <option [value]="s.id">{{ s.name }} ({{ s.documents }})</option>
            }
          </select>
        </label>

        <div class="manual-source-list">
          @for (s of sources(); track s.id) {
            <button class="manual-source" [class.active]="sourceFilter === s.id" (click)="setSource(s.id)">
              <span>{{ s.name }}</span>
              <small>tier {{ s.authorityTier }} / {{ s.documents }} docs</small>
            </button>
          } @empty {
            <div class="manual-empty">No manual sources.</div>
          }
        </div>
      </aside>

      <main class="manual-main">
        <div class="manual-toolbar">
          <div>
            <div class="manual-eyebrow">OpenSphere Console Manual</div>
            <h2>{{ selected()?.item?.title || 'Manual Registry' }}</h2>
          </div>
          <button class="btn btn-primary" [disabled]="loading()" (click)="search()">Search</button>
        </div>

        @if (error()) {
          <div class="alert alert-danger" role="alert">
            <div class="alert-items">
              <div class="alert-item static">
                <span class="alert-text">{{ error() }}</span>
              </div>
            </div>
          </div>
        }

        @if (hits().length) {
          <section class="manual-results" aria-label="Manual search results">
            <h3>Search Results</h3>
            <div class="manual-result-grid">
              @for (hit of hits(); track hit.sourceId + ':' + hit.chunkIndex) {
                <button class="manual-result" (click)="selectDocument(hit.sourceId)">
                  <strong>{{ hit.title }}</strong>
                  <span>{{ hit.excerpt }}</span>
                  <small>{{ hit.sourcePath || hit.sourceName || hit.sourceId }} / score {{ score(hit.score) }}</small>
                </button>
              }
            </div>
          </section>
        }

        <section class="manual-layout">
          <nav class="manual-docs" aria-label="Manual documents">
            <h3>Documents <span>{{ documents().length }}</span></h3>
            @for (doc of documents(); track doc.sourceId) {
              <button class="manual-doc" [class.active]="selected()?.item?.sourceId === doc.sourceId" (click)="selectDocument(doc.sourceId)">
                <strong>{{ doc.title }}</strong>
                <span>{{ doc.sourcePath || doc.sourceId }}</span>
                <small>tier {{ tier(doc) }} / {{ doc.chunkCount }} chunks</small>
              </button>
            } @empty {
              <div class="manual-empty">No manual documents.</div>
            }
          </nav>

          <article class="manual-doc-view">
            @if (selected(); as detail) {
              <header class="manual-doc-head">
                <div>
                  <div class="manual-eyebrow">{{ detail.item.sourceName || detail.item.sourceId }}</div>
                  <h3>{{ detail.item.title }}</h3>
                  <p>{{ detail.item.summary }}</p>
                </div>
                <div class="manual-meta">
                  <span>tier {{ tier(detail.item) }}</span>
                  <span>{{ detail.item.documentType || 'reference' }}</span>
                  <span>{{ detail.item.status || 'active' }}</span>
                </div>
              </header>

              <div class="manual-tags">
                @for (tag of detail.item.tags; track tag) { <span>{{ tag }}</span> }
                @for (p of detail.item.perspective; track p) { <span>{{ p }}</span> }
              </div>

              @if (detail.actionBindings.length) {
                <section class="manual-actions">
                  <h4>Manual-backed actions</h4>
                  @for (a of detail.actionBindings; track a.id) {
                    <div class="manual-action">
                      <strong>{{ a.intent || a.id }}</strong>
                      <span>{{ a.toolId }} / {{ a.riskLevel }} / {{ a.confirmation }}</span>
                    </div>
                  }
                </section>
              }

              <section class="manual-body">
                @for (chunk of detail.chunks; track chunk.chunkIndex) {
                  <div class="manual-chunk">
                    <div class="manual-chunk-index">#{{ chunk.chunkIndex + 1 }}</div>
                    <p>{{ chunk.content }}</p>
                  </div>
                }
              </section>
            } @else {
              <div class="manual-placeholder">
                <h3>Select a manual document</h3>
                <p>Manual Registry is available to the console, top search, and OAA.</p>
              </div>
            }
          </article>
        </section>
      </main>
    </section>
  `,
  styles: [
    `
      :host { display: block; height: 100%; min-height: calc(100vh - 6rem); }
      .manual-shell {
        display: grid;
        grid-template-columns: 18rem minmax(0, 1fr);
        gap: 1rem;
        min-height: calc(100vh - 6rem);
      }
      .manual-side,
      .manual-main {
        min-width: 0;
        border: 1px solid #d8dee8;
        border-radius: 8px;
        background: #fff;
      }
      .manual-side {
        padding: 1rem;
        overflow: hidden;
      }
      .manual-side-head,
      .manual-toolbar,
      .manual-doc-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
      }
      h1, h2, h3, h4, p { margin: 0; }
      h1 { font-size: 1.2rem; }
      h2 { margin-top: 0.15rem; font-size: 1.45rem; }
      h3 { font-size: 1rem; }
      h4 { font-size: 0.85rem; }
      .manual-eyebrow {
        color: #63708a;
        font-size: 0.72rem;
        font-weight: 600;
        text-transform: uppercase;
      }
      .manual-search {
        display: grid;
        gap: 0.35rem;
        margin-top: 1rem;
        font-size: 0.75rem;
        color: #4b5873;
      }
      .manual-search input,
      .manual-search select {
        width: 100%;
      }
      .manual-source-list {
        display: grid;
        gap: 0.45rem;
        margin-top: 1rem;
        max-height: calc(100vh - 21rem);
        overflow: auto;
      }
      .manual-source,
      .manual-doc,
      .manual-result {
        display: grid;
        gap: 0.25rem;
        width: 100%;
        padding: 0.65rem 0.7rem;
        border: 1px solid #e2e7f0;
        border-radius: 6px;
        background: #fff;
        text-align: left;
        cursor: pointer;
      }
      .manual-source:hover,
      .manual-doc:hover,
      .manual-result:hover {
        border-color: #4c6fff;
        background: #f7f9ff;
      }
      .manual-source.active,
      .manual-doc.active {
        border-color: #4c6fff;
        box-shadow: inset 3px 0 0 #4c6fff;
      }
      .manual-source span,
      .manual-doc strong,
      .manual-result strong {
        color: #172033;
        font-size: 0.78rem;
      }
      .manual-source small,
      .manual-doc span,
      .manual-doc small,
      .manual-result span,
      .manual-result small {
        color: #69758f;
        font-size: 0.7rem;
        line-height: 1.35;
      }
      .manual-main {
        padding: 1rem;
        overflow: hidden;
      }
      .manual-results {
        margin-top: 1rem;
      }
      .manual-result-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.6rem;
        margin-top: 0.6rem;
      }
      .manual-layout {
        display: grid;
        grid-template-columns: minmax(16rem, 24rem) minmax(0, 1fr);
        gap: 1rem;
        margin-top: 1rem;
        min-height: 0;
      }
      .manual-docs {
        min-width: 0;
        max-height: calc(100vh - 15rem);
        overflow: auto;
        padding-right: 0.2rem;
      }
      .manual-docs h3 {
        display: flex;
        justify-content: space-between;
        margin-bottom: 0.55rem;
      }
      .manual-docs h3 span {
        color: #63708a;
        font-weight: 500;
      }
      .manual-doc-view {
        min-width: 0;
        max-height: calc(100vh - 15rem);
        overflow: auto;
        border: 1px solid #e2e7f0;
        border-radius: 8px;
        background: #fbfcff;
      }
      .manual-doc-head {
        padding: 1rem;
        border-bottom: 1px solid #e2e7f0;
        background: #fff;
      }
      .manual-doc-head p {
        margin-top: 0.45rem;
        color: #596782;
        font-size: 0.78rem;
        line-height: 1.5;
      }
      .manual-meta {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.35rem;
      }
      .manual-meta span,
      .manual-tags span {
        border: 1px solid #d8dee8;
        border-radius: 999px;
        padding: 0.12rem 0.45rem;
        background: #fff;
        color: #4b5873;
        font-size: 0.65rem;
        white-space: nowrap;
      }
      .manual-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        padding: 0.75rem 1rem 0;
      }
      .manual-actions {
        margin: 1rem;
        padding: 0.8rem;
        border: 1px solid #c8d8ff;
        border-radius: 6px;
        background: #f4f7ff;
      }
      .manual-action {
        display: grid;
        gap: 0.2rem;
        margin-top: 0.55rem;
      }
      .manual-action span {
        color: #596782;
        font-size: 0.72rem;
      }
      .manual-body {
        display: grid;
        gap: 0.8rem;
        padding: 1rem;
      }
      .manual-chunk {
        display: grid;
        grid-template-columns: 2rem minmax(0, 1fr);
        gap: 0.75rem;
        padding: 0.8rem;
        border: 1px solid #e2e7f0;
        border-radius: 6px;
        background: #fff;
      }
      .manual-chunk-index {
        color: #63708a;
        font-size: 0.72rem;
        font-weight: 700;
      }
      .manual-chunk p {
        color: #243047;
        font-size: 0.82rem;
        line-height: 1.55;
        white-space: pre-wrap;
      }
      .manual-empty,
      .manual-placeholder {
        padding: 1rem;
        color: #69758f;
        font-size: 0.78rem;
      }
      @media (max-width: 1100px) {
        .manual-shell,
        .manual-layout {
          grid-template-columns: 1fr;
        }
        .manual-result-grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class ManualShell {
  private manual = inject(ManualService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly sources = signal<ManualSource[]>([]);
  readonly documents = signal<ManualDocument[]>([]);
  readonly hits = signal<ManualSearchHit[]>([]);
  readonly selected = signal<ManualDocumentDetail | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  queryText = '';
  sourceFilter = '';
  private pendingDoc = '';

  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      this.pendingDoc = params.get('doc') || '';
      this.queryText = params.get('q') || this.queryText;
      this.sourceFilter = params.get('source') || this.sourceFilter;
      void this.reload();
    });
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const [sources, documents] = await Promise.all([
        this.manual.sources(),
        this.manual.documents(this.queryText, this.sourceFilter, 80),
      ]);
      this.sources.set(sources);
      this.documents.set(documents);
      if (this.queryText.trim()) this.hits.set(await this.manual.search(this.queryText, 12));
      else this.hits.set([]);
      const target = this.pendingDoc || this.selected()?.item.sourceId || documents[0]?.sourceId || '';
      if (target) await this.selectDocument(target, false);
      else this.selected.set(null);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async search(): Promise<void> {
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.queryText.trim() || null,
        source: this.sourceFilter || null,
        doc: null,
      },
      queryParamsHandling: 'merge',
    });
  }

  async setSource(source: string): Promise<void> {
    this.sourceFilter = this.sourceFilter === source ? '' : source;
    await this.search();
  }

  async selectDocument(sourceId: string, updateUrl = true): Promise<void> {
    if (!sourceId) return;
    this.error.set('');
    try {
      const detail = await this.manual.document(sourceId);
      this.selected.set(detail);
      this.pendingDoc = sourceId;
      if (updateUrl) {
        await this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { doc: sourceId, q: this.queryText.trim() || null, source: this.sourceFilter || null },
          queryParamsHandling: 'merge',
        });
      }
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  tier(doc: ManualDocument): string {
    return doc.authorityTier === null ? '-' : String(doc.authorityTier);
  }

  score(value: number): string {
    return Number(value || 0).toFixed(2);
  }
}
