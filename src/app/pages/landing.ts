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
 * 랜딩(메인 인덱스 /) — Overview 페이지 (containers/overview식: 배경 그라데이션 + 히어로 SVG 일러스트).
 * 메뉴 출처는 ADR-UI-003 §3.3: ① native Core Console ② 등록된 DUPA 확장(ext.pages()).
 */
@Component({
  selector: 'os-landing',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="home-ov">
      <section class="home-hero">
        <div class="home-hero__copy">
          <h1 class="home-title">OpenSphere <span class="os-thin">Console</span></h1>
          <p class="home-lead">하나의 셸 · 하나의 신원 · 하나의 관문.</p>
        </div>
        <div class="home-hero__art" aria-hidden="true">
          <img src="/ibm-assets/observability-pillar-overview-header.svg" alt="" />
        </div>
      </section>

      <section class="home-sec">
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
      </section>

      <section class="home-sec">
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
      </section>
    </div>
  `,
  styles: [
    `
      /* content-area 패딩(1.5rem) 상쇄 → 풀블리드 Overview. 배경 그라데이션(containers overview식). */
      .home-ov {
        margin: -1.5rem; min-height: calc(100% + 3rem); padding: 1.5rem 2rem;
        /* containers/overview와 동일한 배경(하단-우측 블루/핑크 글로우) — 페이지 배경으로 또렷이 반영 */
        background:
          radial-gradient(circle at 82% 82%, rgba(190, 230, 255, 0.7), transparent 26rem),
          radial-gradient(circle at 92% 72%, rgba(255, 214, 232, 0.55), transparent 24rem),
          var(--os-surface-1);
      }
      .home-hero {
        display: grid; grid-template-columns: minmax(0, 1fr) 24rem; align-items: center; gap: 1rem;
        min-height: 13rem; padding: 0.5rem 0 2rem; max-width: 90rem;
      }
      .home-title { margin: 0; font-size: clamp(2.5rem, 4vw, 3.75rem); font-weight: 300; letter-spacing: -0.03em; line-height: 1.05; color: var(--os-ink); }
      .home-lead { margin: 1rem 0 0; color: var(--os-ink-muted); font-size: 1.05rem; }
      .home-hero__art { height: 12rem; }
      .home-hero__art img { display: block; height: 100%; width: 100%; object-fit: contain; object-position: right center; }

      .home-sec { max-width: 90rem; }
      .os-band-heading { font-size: 0.65rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--os-ink-muted); margin: 1.4rem 0 0.5rem; }
      .os-count { opacity: 0.6; margin-left: 0.3rem; }
      .os-engine { color: var(--os-muted); }
      .os-empty { color: var(--os-muted); font-size: 0.85rem; max-width: 40rem; }
      .os-thin { font-weight: 200; opacity: 0.85; }
      .card-title { margin-top: 0.3rem; }
      a.card, a.card:hover { text-decoration: none; }

      @media screen and (max-width: 66rem) {
        .home-hero { grid-template-columns: 1fr; }
        .home-hero__art { display: none; }
      }
    `,
  ],
})
export class Landing {
  private ext = inject(ExtensionHostService);
  private psp = inject(PerspectiveService);

  /** ① native Core Console 기능 — admin 카드는 운영관리자에게만 노출. */
  readonly coreCards = computed<Card[]>(() => {
    const base: Card[] = [
      { path: '/catalog', title: 'Developer Catalog', sub: '카탈로그' },
      { path: '/apis', title: 'APIs', sub: '정보 흐름' },
      { path: '/containers/overview', title: 'Containers', sub: '컨테이너 워크로드' },
      { path: '/me', title: '내 정보', sub: 'My Info' },
    ];
    if (this.psp.isAdmin()) {
      base.push(
        { path: '/manage/console-admins', title: '콘솔 관리자', sub: 'Kanidm IGA' },
        { path: '/manage/plugins', title: 'Console Extensions', sub: 'subShell·plugin·binding' },
        { path: '/manage/roles', title: '역할', sub: '역할 정의·부여' },
      );
    }
    return base;
  });

  /** ② 등록된 DUPA 확장 — 레지스트리 기반. */
  readonly extCards = computed<Card[]>(() =>
    this.ext.pages().map((p) => ({ path: routeForPlugin(p.id), title: p.title, sub: p.navBand })),
  );
}
