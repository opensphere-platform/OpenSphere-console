import { Component, computed, effect, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { CarbonIcon } from './carbon-icon';
import { OsRawIcon } from './os-raw-icon';
import { iconByToken } from './carbon-icon-catalog';
import { IconLibraryService } from './icon-library.service';
import Menu20 from '@carbon/icons/es/menu/20';
import Dashboard16 from '@carbon/icons/es/dashboard/16';
import Application16 from '@carbon/icons/es/application/16';
import Document16 from '@carbon/icons/es/document/16';
import UserMultiple16 from '@carbon/icons/es/user--multiple/16';
import UserAdmin16 from '@carbon/icons/es/user--admin/16';
import Grid16 from '@carbon/icons/es/grid/16';
import Kubernetes16 from '@carbon/icons/es/kubernetes/16';
import Settings16 from '@carbon/icons/es/settings/16';
import ChevronLeft16 from '@carbon/icons/es/chevron--left/16';
import ChevronRight16 from '@carbon/icons/es/chevron--right/16';
import { AuthService } from '../core/auth.service';
import { ExtensionHostService, NavNode } from '../core/extension-host.service';
import { PerspectiveService } from '../core/perspective.service';
import { routeForPlugin } from '../core/perspectives';
import { OsNavNode } from './os-nav-node';
import { OsSearch } from './os-search';
import { OsNotifications } from './os-notifications';
import { OsOaaAgent } from './os-oaa-agent';

interface NavItem {
  path: string;
  label: string;
  plugin?: boolean;
}
interface NavBand {
  band: string;
  items: NavItem[];
}

/**
 * os-shell — OpenSphere 제품 프레임 (dynamic-ui §6.1: 프레임·내비·세션은 셸 소유).
 * 내비 구조 = 헌법 §6의 10-perspective · 3밴드.
 * 정적 항목 + Extension Host가 런타임 등록한 플러그인 페이지(§10)를 밴드별로 합성한다.
 */
@Component({
  selector: 'os-shell',
  imports: [
    ClarityModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    OsNavNode,
    OsSearch,
    OsNotifications,
    OsOaaAgent,
    CarbonIcon,
    OsRawIcon,
  ],
  template: `
    <a class="os-skip-link" href="#main-content">본문으로 건너뛰기</a>
    <div class="main-container">
      <header class="header">
        <button class="os-hamburger" (click)="navCollapsed.set(!navCollapsed())" title="메뉴 접기/펼치기" aria-label="메뉴 토글">
          <os-cicon [icon]="iconMenu" [size]="20" />
        </button>
        <div class="branding">
          <a routerLink="/" class="nav-link os-brand" title="OpenSphere">
            <img class="os-brand-logo" src="/brand/triangles-logo.svg" alt="" aria-hidden="true" />
            <span class="os-brand-name">TRIANGLES</span>
            <span class="os-brand-product">OpenSphere</span>
          </a>
        </div>
        <os-search />
        <div class="header-actions">
          <a class="os-header-manual" routerLink="/manual" routerLinkActive="active" title="Manual" aria-label="Manual">
            <os-cicon [icon]="iconManual" [size]="18" />
          </a>
          <os-oaa-agent />
          <os-notifications />
          <!-- 콘솔 관리는 1단 nav 하단 항목으로 이동(Model A). 헤더는 프로필 전용. -->
          <!-- ACC식 계정 영역: 아바타 → Account profile / Log out (프로필 전용) -->
          <clr-dropdown class="os-account">
            <button class="os-avatar" clrDropdownTrigger [title]="auth.user()" aria-label="계정 메뉴">
              <span class="os-avatar-badge">{{ initial() }}</span>
            </button>
            <clr-dropdown-menu *clrIfOpen clrPosition="bottom-right">
              <div class="os-account-id">{{ auth.user() }}</div>
              <div class="dropdown-divider"></div>
              <a clrDropdownItem routerLink="/me">Account profile</a>
              <div class="dropdown-divider"></div>
              <button clrDropdownItem (click)="auth.logout()">Log out</button>
            </clr-dropdown-menu>
          </clr-dropdown>
        </div>
      </header>
      <div class="content-container">
        <div class="os-nav-col" [class.mobile-collapsed]="navCollapsed()">
          <clr-vertical-nav
            class="os-nav"
            [clrVerticalNavCollapsible]="true"
            [clrVerticalNavCollapsed]="navCollapsed()"
            (clrVerticalNavCollapsedChange)="navCollapsed.set($event)"
          >
          <a
            clrVerticalNavLink
            routerLink="/"
            routerLinkActive="active"
            [routerLinkActiveOptions]="{ exact: true }"
            ><os-cicon clrVerticalNavIcon [icon]="iconHome" [size]="20" />홈 · Perspectives</a
          >
          @for (band of bands(); track band.band) {
            <div class="os-band-label">{{ band.band }}</div>
            @for (item of band.items; track item.path) {
              <a clrVerticalNavLink [routerLink]="item.path" routerLinkActive="active">
                @if (pluginSvg(item); as svg) {
                  <os-rawicon clrVerticalNavIcon [svg]="svg" [size]="20" />
                } @else {
                  <os-cicon clrVerticalNavIcon [icon]="iconFor(item)" [size]="20" />
                }
                {{ item.label }}
                @if (item.plugin) {
                  <span class="badge os-plugin-badge">plugin</span>
                }
              </a>
            }
            <!-- 플러그인이 기여한 재귀 메뉴 트리(임의 깊이·동적) — DUPA nav 기여 -->
            @for (node of treesForBand(band.band); track node.id) {
              <os-nav-node [node]="node" />
            }
          }
          <!-- 콘솔 관리(Model A) — 1단 하단 별도 항목, 진입 시 2단 보조메뉴(AdminLayout). 관리자 전용. -->
          </clr-vertical-nav>
          <!-- 하단 바 (Azure DevOps): 펼침=한 행 [⚙ 콘솔 관리 … «], 접힘=세로 스택 [⚙]/[»].
               콘솔 관리(설정)와 접기/펼치기 토글이 한 바에 공존. 상단 접기/펼치기는 헤더 햄버거가 담당. -->
          <div class="os-nav-foot" [class.collapsed]="navCollapsed()">
            @if (psp.isAdmin()) {
              <a class="os-foot-settings" routerLink="/manage" routerLinkActive="active" title="콘솔 관리" aria-label="콘솔 관리">
                <os-cicon [icon]="iconSettings" [size]="16" /><span class="lbl">콘솔 관리</span>
              </a>
            }
            <button
              class="os-foot-toggle"
              (click)="navCollapsed.set(!navCollapsed())"
              [title]="navCollapsed() ? '메뉴 펼치기' : '메뉴 접기'"
              aria-label="메뉴 접기/펼치기"
            >
              <span class="os-chev2">
                <os-cicon [icon]="navCollapsed() ? iconChevRight : iconChevLeft" [size]="16" />
                <os-cicon [icon]="navCollapsed() ? iconChevRight : iconChevLeft" [size]="16" />
              </span>
            </button>
          </div>
        </div>
        <main id="main-content" class="content-area" tabindex="-1">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* ACC식 헤더 — 차콜 바 + 하단 sphere-blue 라인. 절대중앙 검색을 위해 position:relative,
       * 모든 항목 수직 중앙(align-items:center).
       * z-index: var(--os-z-header) — position:relative와 함께 헤더 자신의 stacking context를 만든다.
       * 이게 없으면 헤더는 stacking context를 형성하지 못해 자식(os-search 드롭다운 등)의 z-index가
       * 문서 전체가 아니라 헤더 로컬 범위에서만 유효해지고, 콘텐츠 영역의 datagrid sticky 헤더처럼
       * DOM 순서상 뒤에 오는 요소가 그 위로 새어나올 수 있다(레이어링 회귀 버그).
       * --os-z-header는 OAA/패널 그립/알림 위, skip-link 아래(styles.scss 레이어 스케일 참고). */
      .header {
        position: relative;
        z-index: var(--os-z-header);
        display: flex;
        align-items: center;
        height: var(--os-header-height);
        border-bottom: 2px solid var(--os-accent);
      }

      /* 헤더 햄버거 — nav 레일↔드로어 토글. 헤더 높이에 수직 중앙 정렬. */
      .os-hamburger {
        display: inline-flex; align-items: center; justify-content: center;
        flex: 0 0 auto; width: 36px; height: 36px; margin: 0 0.1rem 0 0.25rem;
        background: transparent; border: 0; color: var(--os-header-ink);
        cursor: pointer; border-radius: 4px;
      }
      .os-hamburger:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }

      /* [예외 등록 #5] 브랜딩 — TRIANGLES 로고 + 워드마크(ACC 패턴). */
      .os-brand { display: flex; align-items: center; gap: 0.5rem; text-decoration: none; }
      .os-brand-logo { width: 2rem; height: 2rem; object-fit: contain; display: block; flex: 0 0 auto; }
      .os-brand-name { color: #fff; font-size: 1rem; font-weight: 700; letter-spacing: 0.045em; line-height: 1; }
      .os-brand-product { color: #fff; font-size: 0.9375rem; font-weight: 500; letter-spacing: 0.01em; line-height: 1; }
      .os-thin {
        font-weight: 200;
        opacity: 0.85;
      }
      .os-plugin-badge {
        margin-left: 0.3rem;
        opacity: 0.8;
      }
      /* 우측 액션 영역 — 절대중앙 검색과 무관하게 오른쪽 끝으로. */
      .header-actions {
        display: flex;
        align-items: center;
        gap: 0.15rem;
        margin-left: auto;
        padding-right: 0.5rem;
      }
      /* Manual 네이티브 헤더 액션 — /manual 딥링크(§manual-native-console). */
      .os-header-manual {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2.25rem;
        min-height: 2.25rem;
        background: transparent;
        border: 0;
        color: #c7d0e8;
        text-decoration: none;
        cursor: pointer;
        border-radius: 4px;
      }
      .os-header-manual:hover,
      .os-header-manual.active {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }
      /* 좌측 nav 컬럼 = [nav(flex:1, 스크롤)] + [하단 바]. 풀 높이. */
      .os-nav-col { display: flex; flex-direction: column; align-self: stretch; }
      .os-nav-col .os-nav { flex: 1 1 auto; min-height: 0; }

      /* Clarity 기본 접기 토글(상단 «) 숨김 — aria-label로 정확히 타겟(그룹 트리거 .nav-trigger와 구분). */
      ::ng-deep .os-nav button.nav-trigger[aria-label='Toggle vertical navigation'] { display: none !important; }

      /* 하단 바(Azure DevOps): 펼침=한 행 [⚙ 콘솔 관리 … «], 접힘=세로 스택 [⚙]/[»]. 기어 위치 양쪽 일관. */
      .os-nav-foot {
        display: flex; align-items: center; flex: 0 0 auto;
        background: var(--os-nav-bg); border-top: 1px solid var(--os-hairline); border-right: 1px solid var(--os-hairline);
      }
      .os-foot-settings {
        display: flex; align-items: center; gap: 0.55rem; flex: 1 1 auto;
        min-height: 2.75rem; padding: 0 0.85rem; color: var(--os-ink-muted);
        text-decoration: none; cursor: pointer;
      }
      .os-foot-settings os-cicon { color: var(--os-ink-muted); }
      .os-foot-settings:hover { background: rgba(0, 0, 0, 0.05); color: var(--os-ink); }
      .os-foot-settings.active { background: #ffffff; color: var(--os-ink); font-weight: 600; box-shadow: inset 3px 0 0 var(--os-accent); }
      .os-foot-settings.active os-cicon { color: var(--os-accent); }
      .os-foot-toggle {
        display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
        width: 2.75rem; height: 2.75rem; background: transparent; border: 0;
        color: var(--os-ink-muted); cursor: pointer;
      }
      .os-foot-toggle:hover { background: rgba(0, 0, 0, 0.05); color: var(--os-ink); }
      .os-chev2 { display: inline-flex; align-items: center; }
      .os-chev2 os-cicon + os-cicon { margin-left: -9px; }

      /* 접힘(레일): 세로 스택, 가운데 정렬, 라벨 숨김. */
      .os-nav-foot.collapsed { flex-direction: column; }
      .os-nav-foot.collapsed .os-foot-settings { justify-content: center; padding: 0; width: 100%; min-height: 2.5rem; }
      .os-nav-foot.collapsed .lbl { display: none; }
      .os-nav-foot.collapsed .os-foot-toggle { width: 100%; }

      /* ACC식 아바타(계정 메뉴 트리거) — 보라 그라데이션 배지 + 이니셜. */
      .os-account { display: inline-flex; align-items: center; }
      .os-avatar {
        display: inline-flex; align-items: center; justify-content: center;
        width: 40px; height: 40px; padding: 0; margin-left: 0.15rem;
        background: transparent; border: 0; cursor: pointer; border-radius: 4px;
      }
      .os-avatar:hover { background: rgba(255, 255, 255, 0.08); }
      .os-avatar-badge {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border-radius: 4px;
        color: #fff; font-size: 0.8rem; font-weight: 600; line-height: 1;
        background:
          radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.35), transparent 28%),
          linear-gradient(135deg, #6e3ff4, #8a3ffc 48%, #bb6bd9);
      }
      .os-account-id {
        padding: 0.5rem 1rem; max-width: 16rem;
        font-size: 0.75rem; color: var(--os-ink-muted);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .content-area {
        padding: 1.5rem !important;   /* 확정값 — 2단 페이지 음수마진(-1.5rem)과 정확히 일치(오버플로 방지) */
        min-width: 0;
        overflow-x: hidden;
      }
      .os-skip-link {
        position: fixed;
        inset-block-start: 0.25rem;
        inset-inline-start: 0.25rem;
        z-index: var(--os-z-skip-link);
        transform: translateY(-150%);
        padding: 0.5rem 0.75rem;
        background: #fff;
        color: #161616;
        border: 2px solid var(--os-accent);
      }
      .os-skip-link:focus { transform: translateY(0); }
      @media (max-width: 600px) {
        .header { min-width: 0; }
        .branding { display: none; }
        .header-actions { padding-right: .15rem; }
        .os-avatar { width: 32px; }
        .content-container { position: relative; }
        .os-nav-col {
          position: absolute; inset: 0 auto 0 0; z-index: 10; width: 12rem;
          background: var(--os-nav-bg); box-shadow: 4px 0 12px rgba(0, 0, 0, .14);
        }
        .os-nav-col.mobile-collapsed { width: 2.5rem; box-shadow: none; }
        .content-area { width: 100%; padding: 1rem 1rem 1.5rem 3.5rem !important; }
      }
      /* Workspace 전환기 (헌법 §6 · D-B) */
      .os-ws-switch {
        display: flex;
        gap: 0.15rem;
        margin-right: 0.9rem;
      }
      .os-ws {
        background: transparent;
        border: 1px solid rgba(199, 208, 232, 0.3);
        color: #c7d0e8;
        font-size: 0.62rem;
        padding: 0.15rem 0.5rem;
        border-radius: 3px;
        cursor: pointer;
        line-height: 1.4;
      }
      .os-ws:hover {
        border-color: rgba(199, 208, 232, 0.6);
      }
      .os-ws.active {
        background: var(--os-brand-300, #4a6);
        color: #fff;
        border-color: transparent;
        font-weight: 600;
      }
      .os-ws-id {
        font-weight: 700;
        opacity: 0.85;
        margin-right: 0.15rem;
      }
      .os-ws-ctx {
        padding: 0.35rem 0.6rem 0.15rem;
        font-size: 0.6rem;
        color: #8a93ab;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
    `,
  ],
})
export class OsShell {
  readonly auth = inject(AuthService);
  readonly psp = inject(PerspectiveService);
  private ext = inject(ExtensionHostService);
  private iconLib = inject(IconLibraryService);

  /** 아바타 이니셜 — 사용자명 첫 글자(대문자). */
  readonly initial = computed(() => (this.auth.user()?.trim()?.[0] ?? '?').toUpperCase());

  /** 좌측 nav 접기 상태(레일↔드로어) — 헤더 햄버거가 토글. 리로드 후에도 유지(localStorage). */
  readonly navCollapsed = signal(
    localStorage.getItem('os.navCollapsed') === '1' || window.matchMedia('(max-width: 600px)').matches,
  );
  private readonly _persistNav = effect(() => {
    localStorage.setItem('os.navCollapsed', this.navCollapsed() ? '1' : '0');
  });
  readonly iconMenu = Menu20;
  readonly iconHome = Dashboard16;
  readonly iconManual = Document16;
  readonly iconSettings = Settings16;
  readonly iconChevLeft = ChevronLeft16;
  readonly iconChevRight = ChevronRight16;
  /** nav 항목 → Carbon 아이콘(접힘 레일 필수). 경로 키워드 매핑, 기본 Grid. */
  /** 플러그인 항목의 1단 아이콘 SVG(큐레이션에 없는 토큰 → 전체 라이브러리). 큐레이션/네이티브는 null(os-cicon 사용). */
  pluginSvg(item: NavItem): string | null {
    const path = item.path || '';
    if (!(item.plugin || path.startsWith('/p/'))) return null;
    const id = path.replace(/^\/p\//, '').split(/[/?#]/)[0];
    const tok = this.ext.pluginIcons()[id];
    if (!tok || iconByToken(tok)) return null; // 미지정·큐레이션은 os-cicon(즉시)
    return this.iconLib.getSvg(tok); // 미로딩이면 백그라운드 로딩 + null → 로딩 후 재렌더
  }

  iconFor(item: NavItem): any {
    const path = item.path || '';
    const p = path.toLowerCase();
    // 플러그인: 관리자 지정 아이콘(registry의 spec.nav.icon 토큰) — 큐레이션 디스크립터(즉시). 비큐레이션은 pluginSvg가 처리.
    if (p.startsWith('/p/') || item.plugin) {
      const id = path.replace(/^\/p\//, '').split(/[/?#]/)[0];
      return iconByToken(this.ext.pluginIcons()[id]) ?? Application16;
    }
    if (p.includes('container')) return Kubernetes16;
    if (p.includes('manual')) return Document16;
    if (p.includes('console-admin')) return UserAdmin16;
    if (p.includes('role')) return UserMultiple16;
    if (p.includes('plugin')) return Application16;
    return Grid16;
  }

  /** native Core 항목 — 실제 셸 컴포넌트(규칙 부합, 밴드 고정). 그 외 밴드/항목은 전부 등록(DUPA) 기반.
   *  ADR-UI-003 §3.3: 빈 '예정' 밴드(운영/전달/지능 placeholder)는 더 이상 하드코딩하지 않는다. */
  private static readonly NATIVE: NavBand[] = [];

  /** 알려진 밴드 정렬 순서 — 콘텐츠가 있는 밴드만 이 순서로 노출. 미지 밴드는 뒤에 append. */
  private static readonly BAND_ORDER = ['운영 Operate', '구축 Build', '전달 Deliver', '지능 Intelligence'];

  /** nav 밴드 = native Core 항목 + 등록 플러그인(navBand)에서 **동적 수집**(§10 내비 등록).
   *  ADR-UI-003 §3.3: 콘텐츠 없는 밴드는 렌더하지 않는다(phantom 밴드 라벨 제거).
   *  nav 트리를 기여한 플러그인은 평면 항목 대신 트리로 렌더(중복 방지). */
  readonly bands = computed<NavBand[]>(() => {
    const trees = this.ext.navTrees();
    // 역할(그룹) 기반 가시성: 허용 워크스페이스(PerspectiveService.decide)의 밴드만 노출.
    // 비관리자는 '운영 Operate'(워크스페이스 A) 밴드를 보지 못한다 → 관리/운영 perspective 숨김.
    const allowedBands = new Set(this.psp.allowedWorkspaces().flatMap((w) => w.bands));
    const aclBands = new Set(this.psp.all.flatMap((w) => w.bands)); // ACL에 정의된 밴드(역할 게이트 대상)

    // 밴드 → 항목 수집(하드코딩 빈 밴드 없음 — native + 등록 플러그인에서만)
    const byBand = new Map<string, NavItem[]>();
    for (const nb of OsShell.NATIVE) byBand.set(nb.band, [...nb.items]);
    for (const p of this.ext.pages()) {
      if (trees[p.id]) {
        if (!byBand.has(p.navBand)) byBand.set(p.navBand, []); // 트리만 기여하는 밴드도 등장
        continue;
      }
      const arr = byBand.get(p.navBand) ?? [];
      arr.push({ path: routeForPlugin(p.id), label: p.title, plugin: true });
      byBand.set(p.navBand, arr);
    }

    // 정렬(알려진 순서 우선) → 역할 게이트 → 빈 밴드 제거
    const known = OsShell.BAND_ORDER.filter((b) => byBand.has(b));
    const extra = [...byBand.keys()].filter((b) => !OsShell.BAND_ORDER.includes(b));
    return [...known, ...extra]
      // ACL에 정의된 밴드면 허용 여부로 게이트, 신규(ACL 미정의) 밴드는 통과
      .filter((b) => !aclBands.has(b) || allowedBands.has(b))
      .map((b) => ({ band: b, items: byBand.get(b) ?? [] }))
      // 빈 밴드 제거(항목 0 + 트리 0) — phantom 밴드 라벨 제거
      .filter((b) => b.items.length > 0 || this.treesForBand(b.band).length > 0);
  });

  /** 해당 band에 속한 플러그인들의 기여 nav 트리(루트 노드들)를 모은다. */
  treesForBand(band: string): NavNode[] {
    const trees = this.ext.navTrees();
    return this.ext
      .pages()
      .filter((p) => p.navBand === band && trees[p.id])
      .flatMap((p) => trees[p.id]);
  }
}
