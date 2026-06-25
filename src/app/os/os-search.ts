import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Router } from '@angular/router';
import { SearchService } from '../core/search.service';
import { SearchResult } from '../core/search.types';

/**
 * 셸 검색 팔레트 (헌법 §6 단일 검색). 헤더 버튼 또는 Ctrl/⌘K로 열기.
 * 두 표면: 즉시 "이동(Go to)" 로컬 인덱스 + 비동기 "검색" provider(플러그인 기여·데이터층).
 */
@Component({
  selector: 'os-search',
  template: `
    <button class="os-search-trigger" (click)="open()" title="검색·이동 (Ctrl/⌘ K)">
      <span class="os-search-icon">🔍</span> <span class="os-search-label">검색</span>
      <span class="os-kbd">⌘K</span>
    </button>

    @if (isOpen()) {
      <div class="os-search-backdrop" (click)="close()"></div>
      <div class="os-search-modal" role="dialog" aria-label="검색·이동">
        <input
          #box
          class="os-search-input"
          type="text"
          placeholder="이동·검색 — 페이지·워크스페이스·플러그인 콘텐츠…"
          [value]="q()"
          (input)="q.set(box.value)"
          (keydown)="onKey($event)"
          autofocus
        />
        <div class="os-search-results">
          @for (r of results(); track r.kind + r.path + r.label; let i = $index) {
            <button class="os-search-item" [class.sel]="i === sel()" (click)="go(r.path)">
              <span class="os-rk os-rk-{{ r.kind }}">{{ badge(r) }}</span>
              <span class="os-rl">{{ r.label }}</span>
              <span class="os-rs">{{ r.sublabel }}{{ r.source ? ' · ' + r.source : '' }}</span>
            </button>
          } @empty {
            @if (!loading()) {
              <div class="os-search-empty">{{ q() ? '결과 없음' : '검색어를 입력하세요' }}</div>
            }
          }
          @if (loading()) {
            <div class="os-search-loading">검색 중… (provider)</div>
          }
        </div>
        <div class="os-search-foot">
          이동: 페이지·워크스페이스·플러그인(즉시) · 검색: 등록된 provider(런타임 기여·데이터층)
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-search-trigger {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        background: rgba(199, 208, 232, 0.08);
        border: 1px solid rgba(199, 208, 232, 0.25);
        color: #c7d0e8;
        font-size: 0.65rem;
        padding: 0.2rem 0.55rem;
        border-radius: 4px;
        cursor: pointer;
        margin-right: 0.8rem;
      }
      .os-search-trigger:hover {
        border-color: rgba(199, 208, 232, 0.5);
      }
      .os-kbd {
        font-size: 0.55rem;
        opacity: 0.6;
        border: 1px solid rgba(199, 208, 232, 0.3);
        border-radius: 3px;
        padding: 0 0.25rem;
      }
      .os-search-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: 1000;
      }
      .os-search-modal {
        position: fixed;
        top: 12vh;
        left: 50%;
        transform: translateX(-50%);
        width: min(620px, 92vw);
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.35);
        z-index: 1001;
        overflow: hidden;
      }
      .os-search-input {
        width: 100%;
        border: 0;
        border-bottom: 1px solid #e0e3ea;
        padding: 0.85rem 1rem;
        font-size: 0.95rem;
        outline: none;
      }
      .os-search-results {
        max-height: 50vh;
        overflow: auto;
      }
      .os-search-item {
        display: grid;
        grid-template-columns: 64px 1fr auto;
        align-items: center;
        gap: 0.6rem;
        width: 100%;
        border: 0;
        background: #fff;
        text-align: left;
        padding: 0.55rem 1rem;
        cursor: pointer;
      }
      .os-search-item:hover,
      .os-search-item.sel {
        background: #eef3ff;
      }
      .os-rk {
        font-size: 0.55rem;
        text-transform: uppercase;
        color: #fff;
        border-radius: 3px;
        padding: 0.1rem 0.3rem;
        text-align: center;
      }
      .os-rk-page {
        background: #6b7280;
      }
      .os-rk-plugin {
        background: #2563eb;
      }
      .os-rk-workspace {
        background: #16a34a;
      }
      .os-rk-result {
        background: #9333ea;
      }
      .os-rl {
        font-size: 0.82rem;
        color: #1f2733;
      }
      .os-rs {
        font-size: 0.65rem;
        color: #8a93ab;
      }
      .os-search-empty {
        padding: 1.2rem 1rem;
        color: #8a93ab;
        font-size: 0.8rem;
      }
      .os-search-loading {
        padding: 0.5rem 1rem;
        color: #9333ea;
        font-size: 0.7rem;
      }
      .os-search-foot {
        padding: 0.4rem 1rem;
        border-top: 1px solid #eef0f4;
        font-size: 0.6rem;
        color: #aab;
      }
    `,
  ],
})
export class OsSearch {
  private search = inject(SearchService);
  private router = inject(Router);

  readonly isOpen = signal(false);
  readonly q = signal('');
  readonly sel = signal(0);
  readonly loading = signal(false);

  /** 즉시 동기 로컬 결과("이동") */
  private readonly localResults = computed(() => this.search.queryLocal(this.q()));
  /** 비동기 provider 결과("검색") */
  private readonly providerResults = signal<SearchResult[]>([]);

  readonly results = computed<SearchResult[]>(() => {
    this.sel();
    return [...this.localResults(), ...this.providerResults()].slice(0, 30);
  });

  constructor() {
    // q() 변경 시 디바운스 후 비동기 provider 검색. 동기 로컬은 즉시(computed). onCleanup으로 이전 타이머 취소.
    // 시그널 쓰기는 setTimeout 콜백(runProviders) 안에서만 — effect 본문은 스케줄만 한다.
    effect((onCleanup) => {
      const query = this.q();
      const h = setTimeout(() => void this.runProviders(query), 160);
      onCleanup(() => clearTimeout(h));
    });
  }

  private async runProviders(query: string): Promise<void> {
    if (!query.trim()) {
      this.providerResults.set([]);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    try {
      const r = await this.search.queryProviders(query);
      if (this.q() === query) this.providerResults.set(r);
    } finally {
      if (this.q() === query) this.loading.set(false);
    }
  }

  badge(r: SearchResult): string {
    return r.kind === 'result' ? '검색' : r.kind;
  }

  @HostListener('document:keydown', ['$event'])
  onGlobalKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.open();
    }
    if (e.key === 'Escape' && this.isOpen()) this.close();
  }

  open(): void {
    this.isOpen.set(true);
    this.q.set('');
    this.sel.set(0);
  }
  close(): void {
    this.isOpen.set(false);
  }

  onKey(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.sel.set(Math.min(this.sel() + 1, n - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.sel.set(Math.max(this.sel() - 1, 0));
    } else if (e.key === 'Enter') {
      const r = this.results()[this.sel()];
      if (r) this.go(r.path);
    } else {
      this.sel.set(0);
    }
  }

  go(path: string): void {
    this.close();
    this.router.navigateByUrl(path);
  }
}
