import { Component, ChangeDetectionStrategy, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ExtensionHostService } from '../core/extension-host.service';
import { PerspectiveService } from '../core/perspective.service';
import { routeForPlugin } from '../core/perspectives';

interface Card {
  path: string;
  title: string;
  sub: string;
}

/**
 * 랜딩 — 콘솔 홈. 메뉴 출처는 ADR-UI-003 §3.3 규칙대로 **두 가지만**:
 *   ① native Core Console 기능 — mainShell 본질(실제 셸 컴포넌트, §3.1).
 *   ② 등록된 DUPA 확장 — 레지스트리(`ext.pages()`) 기반(동적).
 * 구 하드코딩 '예정' perspective 카드 10개는 제거 — 실제 빌드+DUPA 등록되면 자동 출현한다.
 * 레이아웃: Clarity grid(clr-row/clr-col) · 타일: Clarity card.
 */
@Component({
  selector: 'os-landing',
  imports: [RouterLink],
  template: `
    <h1>OpenSphere <span class="os-thin">Console</span></h1>
    <p class="os-sub">하나의 셸 · 하나의 신원 · 하나의 관문.</p>

    <h2 class="os-band-heading">Core Console</h2>
    <div class="clr-row">
      @for (c of coreCards(); track c.path) {
        <div class="clr-col-12 clr-col-sm-6 clr-col-lg-3">
          <a class="card clickable" [routerLink]="c.path">
            <div class="card-block">
              <h4 class="card-title">{{ c.title }}</h4>
              <p class="card-text os-engine">{{ c.sub }}</p>
            </div>
          </a>
        </div>
      }
    </div>

    <h2 class="os-band-heading">Extensions <span class="os-count">{{ extCards().length }}</span></h2>
    @if (extCards().length) {
      <div class="clr-row">
        @for (c of extCards(); track c.path) {
          <div class="clr-col-12 clr-col-sm-6 clr-col-lg-3">
            <a class="card clickable" [routerLink]="c.path">
              <div class="card-block">
                <h4 class="card-title">{{ c.title }}</h4>
                <p class="card-text os-engine">{{ c.sub }}</p>
              </div>
            </a>
          </div>
        }
      </div>
    } @else {
      <p class="os-empty">
        등록된 확장이 없습니다. subShell·plugin을 DUPA로 등록하면(서명 manifest + UIPluginPackage)
        여기와 좌측 내비에 자동으로 나타납니다.
      </p>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* 토큰 레벨 글루만 — 구조·컴포넌트는 전부 Clarity */
      .os-thin {
        font-weight: 200;
        opacity: 0.85;
      }
      .os-sub {
        color: var(--os-muted);
        margin-bottom: 1rem;
      }
      .os-band-heading {
        font-size: 0.65rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--os-muted);
        margin: 1.4rem 0 0.4rem;
      }
      .os-count {
        opacity: 0.6;
        margin-left: 0.3rem;
      }
      .os-engine {
        color: var(--os-muted);
      }
      .os-empty {
        color: var(--os-muted);
        font-size: 0.85rem;
        max-width: 40rem;
      }
      .card-title {
        margin-top: 0.3rem;
      }
      /* Clarity clickable card의 의도 복원 — 전역 a 밑줄이 카드 내부로 새는 것 차단 */
      a.card,
      a.card:hover {
        text-decoration: none;
      }
    `,
  ],
})
export class Landing {
  private ext = inject(ExtensionHostService);
  private psp = inject(PerspectiveService);

  /** ① native Core Console 기능 — 실제 셸 컴포넌트(규칙 부합). admin 카드는 운영관리자에게만 노출. */
  readonly coreCards = computed<Card[]>(() => {
    const base: Card[] = [
      { path: '/catalog', title: 'Developer Catalog', sub: '카탈로그' },
      { path: '/apis', title: 'APIs', sub: '정보 흐름' },
      { path: '/me', title: '내 정보', sub: 'My Info' },
    ];
    if (this.psp.isAdmin()) {
      base.push(
        { path: '/console-admins', title: '콘솔 관리자', sub: 'Kanidm IGA' },
        { path: '/admin/plugins', title: 'Console Extensions', sub: 'subShell·plugin·binding' },
        { path: '/admin/roles', title: '역할', sub: '역할 정의·부여' },
      );
    }
    return base;
  });

  /** ② 등록된 DUPA 확장 — 레지스트리 기반(하드코딩 없음). 등록 0개면 빈 상태 안내. */
  readonly extCards = computed<Card[]>(() =>
    this.ext.pages().map((p) => ({ path: routeForPlugin(p.id), title: p.title, sub: p.navBand })),
  );
}
