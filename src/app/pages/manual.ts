import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ClarityModule } from '@clr/angular';
import Search20 from '@carbon/icons/es/search/20';
import ArrowRight16 from '@carbon/icons/es/arrow--right/16';
import Cloud16 from '@carbon/icons/es/cloud/16';
import Code16 from '@carbon/icons/es/code/16';
import Application16 from '@carbon/icons/es/application/16';
import Document16 from '@carbon/icons/es/document/16';
import Wikis16 from '@carbon/icons/es/wikis/16';
import { CarbonIcon } from '../os/carbon-icon';
import { BackendUnavailable } from '../os/backend-unavailable';
import {
  ManualDocument,
  ManualDocumentDetail,
  ManualSearchHit,
  ManualService,
  ManualSource,
} from '../core/manual.service';

type ManualBand = 'operate' | 'build' | 'deliver';
type ManualBlockKind = 'heading' | 'paragraph' | 'list' | 'code' | 'quote';

interface ManualBlock {
  kind: ManualBlockKind;
  text?: string;
  items?: string[];
  level?: number;
}

/**
 * Manual — Main Shell native Help Center.
 *
 * The visual hierarchy intentionally follows Oracle Help Center while the content remains owned by
 * the OAA Manual Registry. The retired OpenSphere-shell-menual package is migration input only.
 * All document text is rendered through interpolation; no innerHTML or trusted HTML bypass exists.
 */
@Component({
  selector: 'os-manual',
  imports: [ClarityModule, FormsModule, CarbonIcon, BackendUnavailable],
  template: `
    <div class="manual-page" data-manual-contract="console-help-center-v2">
      <header class="manual-local-header">
        <button type="button" class="manual-brand" (click)="closeDocument()" aria-label="OpenSphere Manual 홈">
          <os-cicon [icon]="iconWikis" [size]="20" />
          <span>OpenSphere Manual</span>
        </button>
        <nav aria-label="Manual 보조 탐색">
          <button type="button" (click)="closeDocument()">Help Center</button>
          <button type="button" (click)="openOverview()">10 Perspectives</button>
        </nav>
      </header>

      @if (selectedDocId()) {
        <section class="manual-reader-head">
          <div class="manual-shell-width">
            <button type="button" class="manual-back" (click)="closeDocument()">Perspectives</button>
            <strong>{{ detail()?.item?.title || '문서 불러오는 중' }}</strong>
          </div>
        </section>

        @if (detailLoading()) {
          <div class="manual-reader-state"><span class="spinner"></span><p>문서를 불러오고 있습니다.</p></div>
        } @else if (detailError()) {
          <div class="manual-shell-width manual-reader-error">
            <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
              <clr-alert-item>
                <span class="alert-text">문서를 불러오지 못했습니다: {{ detailError() }}</span>
                <div class="alert-actions"><button type="button" class="btn alert-action" (click)="retryDocument()">다시 시도</button></div>
              </clr-alert-item>
            </clr-alert>
          </div>
        } @else if (detail(); as d) {
          <main class="manual-reader manual-shell-width">
            <aside class="manual-toc" aria-label="Perspective 문서 목록">
              <ul>
                @for (doc of perspectiveDocuments(); track doc.sourceId) {
                  <li>
                    <button
                      type="button"
                      [class.active]="doc.sourceId === selectedDocId()"
                      (click)="openDocument(doc.sourceId)"
                    >{{ doc.title }}</button>
                  </li>
                }
              </ul>
            </aside>

            <article class="manual-article" [class.manual-overview-article]="d.item.title === 'OpenSphere 10 Perspectives'">
              @if (d.item.title === 'OpenSphere 10 Perspectives') {
                <section class="manual-systems-grid" aria-label="OpenSphere Perspectives">
                  @for (doc of perspectiveDocuments(); track doc.sourceId) {
                    <button type="button" class="manual-system-card" (click)="openDocument(doc.sourceId)">
                      <span class="manual-system-icon" aria-hidden="true"><os-cicon [icon]="iconApplication" [size]="24" /></span>
                      <span class="manual-system-copy">
                        <strong>{{ doc.title }}</strong>
                        <small>{{ leadOf(doc) }}</small>
                      </span>
                    </button>
                  }
                </section>
              } @else {
                <div class="manual-eyebrow">OPENSPHERE MANUAL</div>
                <h1>{{ d.item.title }}</h1>
                <p class="manual-article-lead">{{ leadOf(d.item) }}</p>

                @if (d.actionBindings.length) {
                  <section class="manual-action-note">
                    <h2>Manual-backed actions</h2>
                    @for (action of d.actionBindings; track action.id) {
                      <p><strong>{{ action.intent || action.id }}</strong> · {{ action.riskLevel }} · {{ action.confirmation }}</p>
                    }
                  </section>
                }

                <div class="manual-copy">
                  @for (block of contentBlocks(); track $index) {
                    @switch (block.kind) {
                      @case ('heading') {
                        @if ((block.level || 2) <= 2) { <h2>{{ block.text }}</h2> }
                        @else { <h3>{{ block.text }}</h3> }
                      }
                      @case ('list') {
                        <ul>
                          @for (item of block.items || []; track $index) {
                            <li>
                              {{ item }}
                            </li>
                          }
                        </ul>
                      }
                      @case ('code') { <pre><code>{{ block.text }}</code></pre> }
                      @case ('quote') { <blockquote>{{ block.text }}</blockquote> }
                      @default { <p>{{ block.text }}</p> }
                    }
                  }
                </div>
                <footer class="manual-doc-meta" aria-label="문서 정보">
                  <dl>
                    <div><dt>버전</dt><dd>{{ d.item.version || '—' }}</dd></div>
                    <div><dt>상태</dt><dd>{{ d.item.status || 'active' }}</dd></div>
                    <div><dt>문서 유형</dt><dd>{{ d.item.documentType || 'reference' }}</dd></div>
                    <div><dt>업데이트</dt><dd>{{ dateOf(d.item.updatedAt) }}</dd></div>
                  </dl>
                  @if (tagsOf(d.item).length) {
                    <div class="manual-tags" aria-label="관련 항목">
                      @for (tag of tagsOf(d.item); track tag) { <span>{{ tag }}</span> }
                    </div>
                  }
                  @if (d.item.sourceUrl) {
                    <a [href]="d.item.sourceUrl" target="_blank" rel="noopener">원본 문서 열기</a>
                  }
                </footer>
              }
            </article>
          </main>
        }
      } @else {
        <section class="manual-hero">
          <div class="manual-hero-inner">
            <p class="manual-kicker">OPENSPHERE HELP CENTER</p>
            <h1>무엇을 도와드릴까요?</h1>
            <p class="manual-hero-lead">10개의 Perspective로 플랫폼을 이해하고 설치·운영·확장 방법을 찾으세요.</p>
            <form class="manual-search" (ngSubmit)="runSearch()" role="search">
              <os-cicon [icon]="iconSearch" [size]="20" />
              <input
                name="manual-query"
                [ngModel]="query()"
                (ngModelChange)="query.set($event)"
                placeholder="Perspective, Cluster Manager, Backbone, OAA 검색"
                aria-label="Manual 검색"
              />
              <button type="submit" [disabled]="searchLoading() || !query().trim()">검색</button>
            </form>
          </div>
        </section>

        <main class="manual-home manual-shell-width">
          @if (forbidden()) {
            <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false">
              <clr-alert-item><span class="alert-text">Manual을 조회할 권한이 없습니다.</span></clr-alert-item>
            </clr-alert>
          } @else if (docsError()) {
            <os-backend-unavailable
              feature="Manual"
              backend="OAA Manual Registry (/api/manual)"
              hint="Manual Registry 백엔드가 준비되면 Help Center가 자동 복구됩니다."
              [detail]="docsError()"
            />
          } @else if (docsLoading()) {
            <div class="manual-loading"><span class="spinner"></span><p>Manual Registry를 불러오고 있습니다.</p></div>
          } @else {
            @if (hasSearched()) {
              <section class="manual-results" aria-live="polite">
                <div class="manual-section-title">
                  <div><span>SEARCH RESULTS</span><h2>‘{{ query() }}’ 검색 결과</h2></div>
                  <button type="button" (click)="clearSearch()">Help Center로 돌아가기</button>
                </div>
                @if (searchLoading()) {
                  <div class="manual-loading compact"><span class="spinner spinner-inline"></span><p>검색 중…</p></div>
                } @else if (searchError()) {
                  <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
                    <clr-alert-item><span class="alert-text">검색 실패: {{ searchError() }}</span></clr-alert-item>
                  </clr-alert>
                } @else if (searchHits().length === 0) {
                  <div class="manual-empty"><h3>검색 결과가 없습니다.</h3><p>다른 용어나 Perspective 이름으로 다시 검색해 보세요.</p></div>
                } @else {
                  <div class="manual-hit-grid">
                    @for (hit of searchHits(); track hit.documentId + ':' + hit.chunkIndex) {
                      <button type="button" class="manual-hit" (click)="openDocument(hit.sourceId)">
                        <span>{{ hit.documentType || 'REFERENCE' }}</span>
                        <strong>{{ hit.title }}</strong>
                        <p>{{ excerptOf(hit.excerpt) }}</p>
                        <small>{{ hit.sourceName || hit.sourceId }} · v{{ hit.version }}</small>
                      </button>
                    }
                  </div>
                }
              </section>
            } @else {
              <section class="manual-primary-grid" aria-label="주요 Perspective 그룹">
                @for (band of primaryBands; track band) {
                  <article class="manual-band-card">
                    <div class="manual-band-heading">
                      <os-cicon [icon]="bandIcon(band)" [size]="20" />
                      <div><span>{{ bandLabel(band) }}</span><h2>{{ bandTitle(band) }}</h2></div>
                    </div>
                    <p>{{ bandDescription(band) }}</p>
                    <ul>
                      @for (doc of documentsByBand(band); track doc.sourceId) {
                        <li>
                          <button type="button" (click)="openDocument(doc.sourceId)">
                            <span class="manual-doc-number">{{ perspectiveNumber(doc) }}</span>
                            <span><strong>{{ perspectiveTitle(doc) }}</strong><small>{{ shortSummary(doc) }}</small></span>
                            <os-cicon [icon]="iconArrow" [size]="16" />
                          </button>
                        </li>
                      }
                    </ul>
                  </article>
                }
              </section>

              <section class="manual-deliver-section">
                <div class="manual-section-title">
                  <div><span>DELIVER</span><h2>서비스와 경험을 사용자에게 전달합니다</h2></div>
                  <p>Workspace에서 WebSite까지 외부 가치 전달 흐름을 연결합니다.</p>
                </div>
                <div class="manual-deliver-grid">
                  @for (doc of documentsByBand('deliver'); track doc.sourceId) {
                    <button type="button" class="manual-small-card" (click)="openDocument(doc.sourceId)">
                      <span>{{ perspectiveNumber(doc) }}</span>
                      <strong>{{ perspectiveTitle(doc) }}</strong>
                      <small>{{ shortSummary(doc) }}</small>
                      <os-cicon [icon]="iconArrow" [size]="16" />
                    </button>
                  }
                </div>
              </section>

              <section class="manual-promos">
                <button type="button" class="manual-promo manual-promo-dark" (click)="openOverview()">
                  <os-cicon [icon]="iconDocument" [size]="24" />
                  <span>ARCHITECTURE</span>
                  <h2>10 Perspective 구조와 운영 모델</h2>
                  <p>세 개의 운영 밴드와 Perspective 간 관계를 한 번에 이해합니다.</p>
                  <strong>구조 살펴보기 →</strong>
                </button>
                <button type="button" class="manual-promo manual-promo-color" (click)="openFeaturedReference()">
                  <os-cicon [icon]="iconApplication" [size]="24" />
                  <span>PLAYBOOKS</span>
                  <h2>설치·운영·확장 플레이북</h2>
                  <p>정본 정책과 실제 운영 절차를 Manual Registry에서 찾아보세요.</p>
                  <strong>문서 시작하기 →</strong>
                </button>
              </section>
            }
          }
        </main>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ManualPage implements OnInit {
  private readonly manual = inject(ManualService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly iconSearch = Search20;
  readonly iconArrow = ArrowRight16;
  readonly iconDocument = Document16;
  readonly iconApplication = Application16;
  readonly iconWikis = Wikis16;
  readonly primaryBands: ManualBand[] = ['operate', 'build'];

  readonly sources = signal<ManualSource[]>([]);
  readonly documents = signal<ManualDocument[]>([]);
  readonly docsLoading = signal(true);
  readonly docsError = signal('');
  readonly forbidden = signal(false);

  readonly query = signal('');
  readonly searchLoading = signal(false);
  readonly searchError = signal('');
  readonly searchHits = signal<ManualSearchHit[]>([]);
  readonly hasSearched = signal(false);

  readonly selectedDocId = signal('');
  readonly detail = signal<ManualDocumentDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal('');

  readonly perspectiveDocuments = computed(() =>
    this.documents()
      .filter((doc) => doc.tags.includes('perspective-home'))
      .sort((a, b) => this.perspectiveNumber(a) - this.perspectiveNumber(b)),
  );

  readonly contentBlocks = computed(() => {
    const detail = this.detail();
    const blocks = this.parseDocument(detail);
    const first = blocks[0];
    if (detail && first?.kind === 'paragraph' && first.text === this.leadOf(detail.item)) {
      return blocks.slice(1);
    }
    return blocks;
  });

  async ngOnInit(): Promise<void> {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const docParam = params.get('doc') || '';
        if (docParam && docParam !== this.selectedDocId()) {
          void this.openDocument(docParam, false);
        } else if (!docParam && this.selectedDocId()) {
          this.resetDocumentState();
        }
      });

    await this.loadCatalog();
  }

  private async loadCatalog(): Promise<void> {
    this.docsLoading.set(true);
    this.docsError.set('');
    this.forbidden.set(false);
    try {
      const [sources, documents] = await Promise.all([
        this.manual.sources(),
        this.manual.documents('', '', 100),
      ]);
      this.sources.set(sources);
      this.documents.set(documents);
    } catch (error) {
      const message = String(error);
      if (/HTTP (401|403)\b/.test(message)) this.forbidden.set(true);
      else this.docsError.set(message);
    } finally {
      this.docsLoading.set(false);
    }
  }

  documentsByBand(band: ManualBand): ManualDocument[] {
    return this.perspectiveDocuments().filter((doc) => doc.tags.includes(`manual-band-${band}`));
  }

  bandLabel(band: ManualBand): string {
    return band.toUpperCase();
  }

  bandTitle(band: ManualBand): string {
    return band === 'operate' ? '플랫폼 운영' : band === 'build' ? '서비스 구축' : '가치 전달';
  }

  bandDescription(band: ManualBand): string {
    return band === 'operate'
      ? '호스트, 클러스터, 사용자와 권한을 안정적으로 운영합니다.'
      : band === 'build'
        ? '개발, AI, API 정보 흐름을 사용해 플랫폼 기능을 구축합니다.'
        : '내부 업무부터 고객 접점과 웹사이트까지 서비스를 전달합니다.';
  }

  // Carbon descriptors share the runtime IconNode contract; the package does not export that type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bandIcon(band: ManualBand): any {
    return band === 'operate' ? Cloud16 : band === 'build' ? Code16 : Application16;
  }

  perspectiveNumber(doc: ManualDocument): number {
    const orderTag = doc.tags.find((tag) => /^order-\d{2}$/.test(tag));
    if (orderTag) return Number(orderTag.slice(-2));
    const sourceMatch = doc.sourceId.match(/perspective-(\d{2})/);
    return sourceMatch ? Number(sourceMatch[1]) : 99;
  }

  perspectiveTitle(doc: ManualDocument): string {
    return doc.title.replace(/^\s*\d+\.?\s*/, '').trim();
  }

  shortSummary(doc: ManualDocument): string {
    const cleaned = this.summaryText(doc);
    return cleaned.length > 96 ? `${cleaned.slice(0, 95).trim()}…` : cleaned;
  }

  leadOf(doc: ManualDocument): string {
    const summary = this.summaryText(doc);
    return summary || 'OpenSphere Manual Registry가 제공하는 정본 문서입니다.';
  }

  async runSearch(): Promise<void> {
    const q = this.query().trim();
    if (!q) return;
    this.searchLoading.set(true);
    this.searchError.set('');
    this.hasSearched.set(true);
    try {
      this.searchHits.set(await this.manual.search(q, 20));
    } catch (error) {
      this.searchError.set(String(error));
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

  excerptOf(value: string): string {
    const cleaned = this.stripMarkdown(value);
    return cleaned.length > 190 ? `${cleaned.slice(0, 189).trim()}…` : cleaned;
  }

  async openDocument(sourceId: string, syncRoute = true): Promise<void> {
    if (!sourceId) return;
    this.selectedDocId.set(sourceId);
    this.detail.set(null);
    this.detailLoading.set(true);
    this.detailError.set('');
    try {
      this.detail.set(await this.manual.document(sourceId));
      if (syncRoute && this.route.snapshot.queryParamMap.get('doc') !== sourceId) {
        void this.router.navigate([], { queryParams: { doc: sourceId }, queryParamsHandling: 'merge' });
      }
      queueMicrotask(() => document.querySelector('.manual-page')?.scrollIntoView({ block: 'start' }));
    } catch (error) {
      this.detailError.set(String(error));
    } finally {
      this.detailLoading.set(false);
    }
  }

  openOverview(): void {
    const overview = this.documents().find((doc) => doc.tags.includes('perspective-overview'));
    if (overview) void this.openDocument(overview.sourceId);
  }

  openFeaturedReference(): void {
    const reference = this.documents().find((doc) =>
      doc.tags.includes('bootstrap') || doc.tags.includes('implementation-plan'),
    );
    if (reference) void this.openDocument(reference.sourceId);
  }

  retryDocument(): void {
    if (this.selectedDocId()) void this.openDocument(this.selectedDocId());
  }

  closeDocument(): void {
    this.resetDocumentState();
    void this.router.navigate([], { queryParams: { doc: null }, queryParamsHandling: 'merge' });
    queueMicrotask(() => document.querySelector('.manual-page')?.scrollIntoView({ block: 'start' }));
  }

  private resetDocumentState(): void {
    this.detail.set(null);
    this.selectedDocId.set('');
    this.detailError.set('');
    this.detailLoading.set(false);
  }

  dateOf(value: string): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(date);
  }

  tagsOf(item: ManualDocument): string[] {
    return [...new Set([...(item.perspective || []), ...(item.component || [])])].slice(0, 10);
  }

  private parseDocument(detail: ManualDocumentDetail | null): ManualBlock[] {
    if (!detail) return [];
    const content = detail.chunks.map((chunk) => chunk.content).join('\n\n');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const blocks: ManualBlock[] = [];
    let paragraph: string[] = [];
    let list: string[] = [];
    let code: string[] = [];
    let inCode = false;

    const flushParagraph = () => {
      const text = this.cleanInline(paragraph.join(' ').trim());
      if (text) blocks.push({ kind: 'paragraph', text });
      paragraph = [];
    };
    const flushList = () => {
      if (list.length) blocks.push({ kind: 'list', items: [...list] });
      list = [];
    };
    const flushCode = () => {
      if (code.length) blocks.push({ kind: 'code', text: code.join('\n').trimEnd() });
      code = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (/^```/.test(line.trim())) {
        flushParagraph();
        flushList();
        if (inCode) flushCode();
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        code.push(rawLine);
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const text = this.cleanInline(heading[2]);
        if (text.toLowerCase() !== detail.item.title.toLowerCase()) {
          blocks.push({ kind: 'heading', level: heading[1].length, text });
        }
        continue;
      }
      const listItem = line.match(/^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/);
      if (listItem) {
        flushParagraph();
        list.push(this.cleanInline(listItem[1]));
        continue;
      }
      if (/^>\s?/.test(line)) {
        flushParagraph();
        flushList();
        blocks.push({ kind: 'quote', text: this.cleanInline(line.replace(/^>\s?/, '')) });
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    flushCode();
    return blocks;
  }

  private stripMarkdown(value: string): string {
    return this.cleanInline(
      String(value || '')
        .replace(/(^|\s)#{1,6}\s+/g, ' — ')
        .replace(/(^|\s)>\s*/g, ' ')
        .replace(/(^|\s)(?:[-*+] |\d+[.)]\s+)/g, ' · ')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' '),
    );
  }

  private summaryText(doc: ManualDocument): string {
    const raw = String(doc.summary || '').replace(/\s+/g, ' ').trim();
    const withoutTitle = raw
      .replace(/^#{1,6}\s*/, '')
      .replace(new RegExp(`^${this.escapeRegExp(doc.title)}\s*`, 'i'), '')
      .trim();
    return this.cleanInline(withoutTitle.split(/\s+#{1,6}\s+/)[0] || withoutTitle);
  }

  private cleanInline(value: string): string {
    return value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .replace(/^#+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
