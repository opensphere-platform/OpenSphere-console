import { Component, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';
import { ExtensionHostService, NavNode } from '../core/extension-host.service';
import { PerspectiveService } from '../core/perspective.service';
import { routeForPlugin } from '../core/perspectives';
import { OsNavNode } from './os-nav-node';
import { OsSearch } from './os-search';
import { OsNotifications } from './os-notifications';

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
  ],
  template: `
    <div class="main-container">
      <header class="header">
        <div class="branding">
          <a routerLink="/" class="nav-link">
            <span class="os-logo">◍</span>
            <span class="title">OpenSphere <span class="os-thin">Console</span></span>
          </a>
        </div>
        <div class="header-actions">
          <os-search />
          <os-notifications />
          <!-- 역할 기반 가시성: 콘솔 관리자(운영 워크스페이스 접근권)에게만 admin 링크 노출 -->
          @if (psp.isAdmin()) {
            <a
              class="nav-link nav-icon-text os-admin"
              routerLink="/console-admins"
              routerLinkActive="active"
              title="콘솔 운영관리자 인증 (Kanidm) — Main Shell 관리 영역"
              >🔑 <span class="nav-text">콘솔 관리자</span></a
            >
            <a
              class="nav-link nav-icon-text os-admin"
              routerLink="/admin/plugins"
              routerLinkActive="active"
              title="플러그인 관리 (Admin)"
              >⚙ <span class="nav-text">Plugins</span></a
            >
            <a
              class="nav-link nav-icon-text os-admin"
              routerLink="/admin/roles"
              routerLinkActive="active"
              title="콘솔 역할 정의·부여 (Admin)"
              >👤 <span class="nav-text">역할</span></a
            >
          }
          <a class="os-user" routerLink="/me" routerLinkActive="active" title="내 정보 (My Info)">{{
            auth.user()
          }}</a>
          <button class="btn btn-link os-logout" (click)="auth.logout()">로그아웃</button>
        </div>
      </header>
      <div class="content-container">
        <clr-vertical-nav class="os-nav">
          <a
            clrVerticalNavLink
            routerLink="/"
            routerLinkActive="active"
            [routerLinkActiveOptions]="{ exact: true }"
            >홈 · Perspectives</a
          >
          @for (band of bands(); track band.band) {
            <div class="os-band-label">{{ band.band }}</div>
            @for (item of band.items; track item.path) {
              <a clrVerticalNavLink [routerLink]="item.path" routerLinkActive="active">
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
        </clr-vertical-nav>
        <div class="content-area">
          <router-outlet />
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* [예외 등록 #5] 브랜딩·보조 표시 — DESIGN-RULES.md */
      .os-logo {
        font-size: 1.1rem;
        color: var(--os-brand-300);
        margin-right: 0.35rem;
      }
      .os-thin {
        font-weight: 200;
        opacity: 0.85;
      }
      .os-user {
        color: #c7d0e8;
        font-size: 0.65rem;
        margin-right: 0.6rem;
      }
      .os-logout {
        color: #c7d0e8 !important;
      }
      .os-admin {
        color: #c7d0e8 !important;
        margin-right: 0.8rem;
        font-size: 0.7rem;
      }
      .os-admin.active {
        color: #fff !important;
      }
      .os-plugin-badge {
        margin-left: 0.3rem;
        opacity: 0.8;
      }
      .header-actions {
        display: flex;
        align-items: center;
        padding-right: 0.6rem;
      }
      .content-area {
        padding: 1.1rem 1.4rem;
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

  /** 정적(셸 코어) 항목 — Platform Status는 더 이상 여기 없다(플러그인으로 이전). */
  private static readonly BASE: NavBand[] = [
    { band: '운영 Operate', items: [] },
    {
      band: '구축 Build',
      items: [
        { path: '/catalog', label: 'Developer Catalog' },
        { path: '/apis', label: 'APIs' },
      ],
    },
    { band: '전달 Deliver', items: [] },
    { band: '지능 Intelligence', items: [] },
  ];

  /** 헌법 §6 3밴드에 플러그인 페이지를 런타임 합성 (§10 내비 등록)
   *  단, nav 트리를 기여한 플러그인은 평면 항목 대신 트리로 렌더(중복 방지). */
  readonly bands = computed<NavBand[]>(() => {
    const trees = this.ext.navTrees();
    // 역할(그룹) 기반 가시성: 허용 워크스페이스(PerspectiveService.decide)의 밴드만 노출.
    // 비관리자는 '운영 Operate'(워크스페이스 A) 밴드를 보지 못한다 → 관리/운영 perspective 숨김.
    const allowedBands = new Set(this.psp.allowedWorkspaces().flatMap((w) => w.bands));
    return (
      OsShell.BASE
        .filter((b) => allowedBands.has(b.band))
        .map((b) => ({
          band: b.band,
          items: [
            ...b.items,
            ...this.ext
              .pages()
              .filter((p) => p.navBand === b.band && !trees[p.id])
              .map((p) => ({ path: routeForPlugin(p.id), label: p.title, plugin: true })),
          ],
        }))
    );
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
