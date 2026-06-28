import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  ElementRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Router } from '@angular/router';
import { SearchService, SearchSections } from '../core/search.service';
import { SearchResult } from '../core/search.types';
import { CarbonIcon } from './carbon-icon';
import Search16 from '@carbon/icons/es/search/16';

const EMPTY: SearchSections = { resources: [], services: [], documentation: [], marketplace: [] };

interface SecView {
  title: string;
  items: SearchResult[];
  viewAll: string | null;
}

/**
 * 셸 검색 (헌법 §6 단일 검색) — 헤더에 붙은 인라인 검색창 + 바로 아래로 펼쳐지는 드롭다운.
 * 결과를 4개 섹션(Resources·Services·Documentation·Marketplace)으로 분류한 2단 패널.
 * 포커스/⌘K로 열리고 blur(지연)·Esc·결과 클릭으로 닫힘. 우측 정렬(헤더 우측 배치 시 화면 밖 방지).
 */
@Component({
  selector: 'os-search',
  imports: [CarbonIcon],
  template: `
    <div class="os-search-wrap">
      <div class="os-search-field" [class.focused]="isOpen()">
        <os-cicon class="os-search-icon" [icon]="searchIcon" [size]="16" />
        <input
          #box
          class="os-search-input"
          type="text"
          placeholder="Search resources, services, documentation, and Marketplace"
          [value]="q()"
          (focus)="open()"
          (input)="q.set(box.value)"
          (keydown)="onKey($event)"
          (blur)="onBlur()"
        />
        <span class="os-kbd">⌘K</span>
      </div>

      @if (isOpen()) {
        <div class="os-search-drop" (mousedown)="$event.preventDefault()">
          <div class="os-search-panel">
            <div class="os-col os-col-left">
              @for (sec of leftSecs(); track sec.title) {
                <div class="os-sec">
                  <div class="os-sec-head">
                    <div class="os-sec-title">{{ sec.title }}</div>
                    @if (sec.viewAll && sec.items.length) {
                      <a class="os-view-all" (click)="go(sec.viewAll)">View all</a>
                    }
                  </div>
                  <div class="os-sec-line"></div>
                  @for (r of sec.items; track r.kind + r.path + r.label) {
                    <button class="os-row" (click)="go(r.path)" title="{{ r.label }}">
                      <span class="os-row-lbl">{{ r.label }}</span>
                      <span class="os-row-cat">{{ r.sublabel }}</span>
                    </button>
                  } @empty {
                    <div class="os-row-none">{{ q() ? 'No results were found.' : '검색어를 입력하세요' }}</div>
                  }
                </div>
              }
            </div>
            <div class="os-col os-col-right">
              @for (sec of rightSecs(); track sec.title) {
                <div class="os-sec">
                  <div class="os-sec-head">
                    <div class="os-sec-title">{{ sec.title }}</div>
                    @if (sec.viewAll && sec.items.length) {
                      <a class="os-view-all" (click)="go(sec.viewAll)">View all</a>
                    }
                  </div>
                  <div class="os-sec-line"></div>
                  @for (r of sec.items; track r.kind + r.path + r.label) {
                    <button class="os-row" (click)="go(r.path)" title="{{ r.label }}">
                      <span class="os-row-lbl">{{ r.label }}</span>
                      <span class="os-row-cat">{{ r.sublabel }}</span>
                    </button>
                  } @empty {
                    <div class="os-row-none">{{ q() ? 'No results were found.' : '검색어를 입력하세요' }}</div>
                  }
                </div>
              }
            </div>
          </div>
          <div class="os-search-foot">
            <a class="os-adv" (click)="go('/catalog')">Advanced resource query</a>
            @if (loading()) { <span class="os-foot-loading">검색 중…</span> }
          </div>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* 헤더 절대 중앙 배치 (ACC: top/left 50% + translate, 좌우 균형 무관하게 진짜 중앙) */
      :host {
        position: absolute; inset-block-start: 50%; inset-inline-start: 50%;
        transform: translate(-50%, -50%); z-index: 5;
        display: flex; align-items: center;
        width: min(640px, calc(100vw - 44rem)); min-width: 18rem;
      }
      .os-search-wrap { position: relative; width: 100%; }

      /* 헤더 안 인라인 검색창 — ACC식: 차콜 헤더와 일체화된 다크 필드(흰 박스 X). */
      .os-search-field {
        display: flex; align-items: center; gap: 0.55rem;
        background: #262626; border: 1px solid #525252; border-radius: 4px;
        height: 2.25rem; padding: 0 0.75rem; width: 100%; box-sizing: border-box;
        transition: box-shadow 0.12s, border-color 0.12s;
      }
      .os-search-field.focused { border-color: #4c6fff; box-shadow: 0 0 0 3px rgba(76, 111, 255, 0.25); }
      .os-search-icon { color: #a8a8a8; font-size: 0.8rem; }
      .os-search-input { flex: 1; border: 0; outline: none; background: transparent; font-size: 0.875rem; color: #f4f4f4; min-width: 0; }
      .os-search-input::placeholder { color: #8d8d8d; }
      .os-kbd { font-size: 0.55rem; opacity: 0.6; border: 1px solid #6f6f6f; border-radius: 3px; padding: 0 0.25rem; color: #a8a8a8; }

      /* 입력창 바로 아래 드롭다운 — OCI: 입력과 동일 너비·좌측정렬·radius4·shadow */
      .os-search-drop {
        position: absolute; top: calc(100% + 5px); left: 0;
        width: 100%; background: #fdfdfc; border: 1px solid #e0e3ea;
        border-radius: 4px; box-shadow: 0 12px 40px rgba(29, 39, 51, 0.25);
        z-index: 1001; overflow: hidden; cursor: default;
      }
      .os-search-panel { display: grid; grid-template-columns: 1fr 1fr; max-height: 60vh; overflow-x: hidden; overflow-y: auto; }
      .os-col { padding: 0.6rem 1.1rem 0.9rem; }
      .os-col-left { border-right: 1px solid #eef0f4; }

      .os-sec { margin-top: 0.7rem; }
      .os-sec:first-child { margin-top: 0.2rem; }
      .os-sec-head { display: flex; align-items: baseline; justify-content: space-between; background: transparent; }
      .os-sec-title { margin: 0; font-size: 1rem; font-weight: 700; color: #161513; background: transparent; }
      .os-view-all { font-size: 0.72rem; color: #4c6fff; cursor: pointer; }
      .os-view-all:hover { text-decoration: underline; }
      .os-sec-line { height: 1px; background: #e0e3ea; margin: 0.35rem 0 0.2rem; }

      .os-row {
        display: flex; align-items: center; justify-content: space-between; gap: 0.8rem;
        width: 100%; border: 0; background: transparent; text-align: left;
        padding: 0.3rem 0.35rem; border-radius: 4px; cursor: pointer;
      }
      .os-row:hover { background: #f2f5ff; }
      .os-row-lbl { color: #4c6fff; font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .os-row-cat { color: #8a93ab; font-size: 0.72rem; white-space: nowrap; flex-shrink: 1; max-width: 42%; overflow: hidden; text-overflow: ellipsis; }
      .os-row-none { padding: 0.3rem 0.35rem; color: #8a93ab; font-size: 0.78rem; }

      .os-search-foot { display: flex; align-items: center; gap: 0.8rem; padding: 0.55rem 1.1rem; border-top: 1px solid #eef0f4; }
      .os-adv { font-size: 0.78rem; color: #4c6fff; cursor: pointer; font-weight: 600; }
      .os-adv:hover { text-decoration: underline; }
      .os-foot-loading { font-size: 0.68rem; color: #9333ea; }
    `,
  ],
})
export class OsSearch {
  private search = inject(SearchService);
  private router = inject(Router);
  private box = viewChild<ElementRef<HTMLInputElement>>('box');
  readonly searchIcon = Search16;

  readonly isOpen = signal(false);
  readonly q = signal('');
  readonly loading = signal(false);
  readonly sections = signal<SearchSections>(EMPTY);

  readonly leftSecs = computed<SecView[]>(() => [
    { title: 'Resources', items: this.sections().resources, viewAll: null },
  ]);
  readonly rightSecs = computed<SecView[]>(() => [
    { title: 'Services', items: this.sections().services, viewAll: '/catalog' },
    { title: 'Documentation', items: this.sections().documentation, viewAll: null },
    { title: 'Marketplace', items: this.sections().marketplace, viewAll: '/apis' },
  ]);

  constructor() {
    effect((onCleanup) => {
      const query = this.q();
      const h = setTimeout(() => void this.run(query), 160);
      onCleanup(() => clearTimeout(h));
    });
  }

  private async run(query: string): Promise<void> {
    if (!query.trim()) {
      this.sections.set(EMPTY);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    try {
      const r = await this.search.querySectioned(query);
      if (this.q() === query) this.sections.set(r);
    } finally {
      if (this.q() === query) this.loading.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onGlobalKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.box()?.nativeElement.focus();
    }
    if (e.key === 'Escape' && this.isOpen()) {
      this.isOpen.set(false);
      this.box()?.nativeElement.blur();
    }
  }

  open(): void {
    this.isOpen.set(true);
  }
  /** blur 시 닫기 — 결과 클릭이 먼저 처리되도록 지연. (드롭다운 mousedown은 preventDefault로 blur 억제) */
  onBlur(): void {
    setTimeout(() => this.isOpen.set(false), 120);
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      const s = this.sections();
      const first = s.resources[0] || s.services[0] || s.documentation[0] || s.marketplace[0];
      if (first) this.go(first.path);
    }
  }

  go(path: string | null): void {
    if (!path) return;
    this.isOpen.set(false);
    this.q.set('');
    this.box()?.nativeElement.blur();
    this.router.navigateByUrl(path);
  }
}
