import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CarbonIcon } from '../os/carbon-icon';
import UserAdmin16 from '@carbon/icons/es/user--admin/16';
import Application16 from '@carbon/icons/es/application/16';
import Catalog16 from '@carbon/icons/es/catalog/16';
import Layers16 from '@carbon/icons/es/layers/16';
import Activity16 from '@carbon/icons/es/activity/16';
import Home16 from '@carbon/icons/es/home/16';

interface AdminItem {
  label: string;
  route: string;
}
interface AdminGroup {
  id: string;
  label: string;
  icon: any;
  items: AdminItem[];
}

/**
 * AdminLayout — "콘솔 관리" 섹션 레이아웃 (Model A: 1단 진입 → 2단 보조메뉴 + 콘텐츠).
 * 2단 메뉴 표준 = OpenSphere AI Hub 방식(전역 .cm-nav: Clarity clr-vertical-nav, 흰 배경, 왼쪽 blue bar active).
 * /manage 개요, Extensions, R2D2는 독립 링크, 나머지는 책임 영역별 Clarity tree로 묶는다.
 * 아이콘은 Clarity Vertical Nav 규칙에 따라 최상위 항목에만 표시한다.
 */
@Component({
  selector: 'os-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ClarityModule, CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="cc-frame">
      <clr-vertical-nav
        class="cm-nav manage-nav"
        [clrVerticalNavCollapsible]="false"
        aria-label="콘솔 관리 보조 내비"
      >
        <div class="cm-brand"><strong>콘솔 관리</strong></div>

        <a
          clrVerticalNavLink
          routerLink="/manage"
          routerLinkActive="active"
          [routerLinkActiveOptions]="{ exact: true }"
          ariaCurrentWhenActive="page"
        >
          <os-cicon clrVerticalNavIcon [icon]="overviewIcon" [size]="16" />개요
        </a>

        <a
          clrVerticalNavLink
          [routerLink]="extensionItem.route"
          routerLinkActive="active"
          ariaCurrentWhenActive="page"
        >
          <os-cicon clrVerticalNavIcon [icon]="extensionItem.icon" [size]="16" />{{
            extensionItem.label
          }}
        </a>

        <a
          clrVerticalNavLink
          [routerLink]="r2d2Item.route"
          routerLinkActive="active"
          ariaCurrentWhenActive="page"
        >
          <os-cicon clrVerticalNavIcon [icon]="r2d2Item.icon" [size]="16" />{{
            r2d2Item.label
          }}
        </a>

        <div class="nav-divider manage-extension-divider" role="separator"></div>
        @for (group of groups; track group.label) {
          <clr-vertical-nav-group
            routerLinkActive="active"
            [clrVerticalNavGroupExpanded]="isExpanded(group.id)"
            (clrVerticalNavGroupExpandedChange)="setExpanded(group.id, $event)"
          >
            <os-cicon clrVerticalNavIcon [icon]="group.icon" [size]="16" />{{ group.label }}
            <clr-vertical-nav-group-children>
              @for (item of group.items; track item.route) {
                <a
                  clrVerticalNavLink
                  [routerLink]="item.route"
                  routerLinkActive="active"
                  ariaCurrentWhenActive="page"
                >
                  {{ item.label }}
                </a>
              }
            </clr-vertical-nav-group-children>
          </clr-vertical-nav-group>
        }
      </clr-vertical-nav>
      <div class="cc-content"><router-outlet /></div>
    </div>
  `,
  styles: [
    `
      /* 풀블리드(1단 레일·헤더 밀착) — Clarity 기본 vertical-nav 폭(15rem)을 보존한다. */
      .cc-frame {
        display: grid;
        grid-template-columns: 15rem minmax(0, 1fr);
        margin: -1.5rem;
        min-height: calc(100% + 3rem);
        overflow-x: hidden;
      }
      /* 콘텐츠 — 섹션 공통 배경 토큰 + 패딩. (.cm-nav 스타일은 전역 styles.scss) */
      .cc-content {
        min-width: 0;
        overflow-x: hidden;
        padding: 1.5rem 2rem;
        color: var(--os-ink);
        background: var(--os-overview-bg);
      }
      .manage-extension-divider {
        margin: 0.45rem 0.75rem;
      }
      .manage-nav {
        width: 100%;
        min-width: 0;
      }
      @media (max-width: 56rem) {
        .cc-frame {
          grid-template-columns: minmax(0, 1fr);
          overflow: visible;
        }
        .manage-nav {
          max-height: 42vh;
          overflow-y: auto;
          border-right: 0;
          border-bottom: 1px solid var(--os-hairline);
        }
        .cc-content {
          padding: 1rem;
        }
      }
    `,
  ],
})
export class AdminLayout {
  private readonly router = inject(Router);
  readonly overviewIcon = Home16;
  readonly extensionItem = {
    label: 'Modules & Extensions',
    route: '/manage/extensions',
    icon: Application16,
  };
  readonly r2d2Item = {
    label: 'R2D2',
    route: '/manage/osaa',
    icon: Activity16,
  };
  readonly expanded = signal<Record<string, boolean>>({});
  readonly groups: AdminGroup[] = [
    {
      id: 'foundation',
      label: 'CBSS 자원 서비스',
      icon: Layers16,
      items: [
        { label: '개요', route: '/manage/foundation-services' },
        { label: 'Data & Identity', route: '/manage/data-identity' },
        { label: '선언형 상태 변경', route: '/manage/state-changes' },
        { label: 'Infrastructure Monitoring', route: '/manage/infrastructure-monitoring' },
      ],
    },
    {
      id: 'assets',
      label: '개발 자산',
      icon: Catalog16,
      items: [
        { label: 'Developer Catalog', route: '/manage/catalog' },
        { label: 'APIs', route: '/manage/apis' },
        { label: 'Console CLI', route: '/manage/cli' },
      ],
    },
    {
      id: 'access',
      label: '신원 및 접근',
      icon: UserAdmin16,
      items: [
        { label: '콘솔 관리자', route: '/manage/console-admins' },
        { label: '역할', route: '/manage/roles' },
      ],
    },
    {
      id: 'platform',
      label: '플랫폼 제어',
      icon: Layers16,
      items: [
        { label: 'Control Plane', route: '/manage/platform-control' },
        { label: 'Platform Release', route: '/manage/platform-release' },
        { label: 'HISS Observability', route: '/manage/observability' },
      ],
    },
    {
      id: 'operations',
      label: '운영 및 증거',
      icon: Activity16,
      items: [
        { label: '알림', route: '/manage/notifications' },
        { label: '외부 채널', route: '/manage/external-channels' },
        { label: '감사 로그', route: '/manage/audit' },
      ],
    },
  ];

  constructor() {
    this.expandRouteGroup(this.router.url);
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => this.expandRouteGroup(event.urlAfterRedirects));
  }

  isExpanded(id: string): boolean {
    return !!this.expanded()[id];
  }

  setExpanded(id: string, expanded: boolean): void {
    this.expanded.update((state) => ({ ...state, [id]: expanded }));
  }

  private expandRouteGroup(route: string): void {
    const path = route.split(/[?#]/, 1)[0];
    const active = this.groups.find((group) =>
      group.items.some((item) => path === item.route || path.startsWith(`${item.route}/`)),
    );
    if (active) this.setExpanded(active.id, true);
  }
}
