import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { filter } from 'rxjs';
import { CarbonIcon } from '../os/carbon-icon';
import UserAdmin16 from '@carbon/icons/es/user--admin/16';
import Catalog16 from '@carbon/icons/es/catalog/16';
import Layers16 from '@carbon/icons/es/layers/16';
import Activity16 from '@carbon/icons/es/activity/16';
import Application16 from '@carbon/icons/es/application/16';
import Dashboard16 from '@carbon/icons/es/dashboard/16';
import HybridNetworking16 from '@carbon/icons/es/hybrid-networking/16';
import { ManageCapabilityService, ManageFeature } from '../core/manage-capability.service';

interface AdminItem {
  label: string;
  route: string;
  feature?: ManageFeature;
}

interface AdminDirectItem extends AdminItem {
  icon: any;
}

interface AdminGroup {
  id: string;
  label: string;
  icon: any;
  items: AdminItem[];
}

/**
 * AdminLayout — "콘솔 관리" 섹션 레이아웃 (Model A: 1단 진입 → 2단 보조메뉴 + 콘텐츠).
 * Clarity Vertical Navigation의 hierarchy 계약을 그대로 사용한다.
 * 상위 관리 도메인은 펼침/접힘 가능한 그룹, 실제 페이지는 선택 강조되는 하위 항목이다.
 */
@Component({
  selector: 'os-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ClarityModule, CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="cc-frame">
      <clr-vertical-nav
        class="cm-nav cm-admin-nav"
        [clrVerticalNavCollapsible]="false"
        aria-label="콘솔 관리 메뉴"
      >
        <div class="cm-brand"><strong>콘솔 관리</strong></div>
        @for (item of directItems; track item.route) {
          @if (!item.feature || capabilities.isNavigable(item.feature)) {
            <a
              clrVerticalNavLink
              class="cm-direct-item"
              [routerLink]="item.route"
              routerLinkActive="active"
              ariaCurrentWhenActive="page"
              [routerLinkActiveOptions]="{
                paths: 'exact',
                queryParams: 'ignored',
                matrixParams: 'ignored',
                fragment: 'ignored',
              }"
            >
              <os-cicon clrVerticalNavIcon [icon]="item.icon" [size]="16" />
              {{ item.label }}
              @if (item.feature && capabilities.state(item.feature).phase !== 'available') {
                <span class="cm-capability-badge">{{
                  capabilities.state(item.feature).label
                }}</span>
              }
            </a>
          } @else {
            <span
              class="cm-unavailable-item cm-direct-unavailable"
              aria-disabled="true"
              [title]="capabilities.state(item.feature).detail"
            >
              <os-cicon [icon]="item.icon" [size]="16" />
              <span>{{ item.label }}</span>
              <span class="cm-capability-badge">{{ capabilities.state(item.feature).label }}</span>
            </span>
          }
        }
        <div class="cm-section-divider" aria-hidden="true"></div>
        @for (group of groups; track group.id) {
          <clr-vertical-nav-group
            [clrVerticalNavGroupExpanded]="isGroupExpanded(group.id)"
            (clrVerticalNavGroupExpandedChange)="setGroupExpanded(group.id, $event)"
          >
            <os-cicon clrVerticalNavIcon [icon]="group.icon" [size]="16" />
            {{ group.label }}
            <clr-vertical-nav-group-children>
              @for (item of group.items; track item.route) {
                @if (!item.feature || capabilities.isNavigable(item.feature)) {
                  <a
                    clrVerticalNavLink
                    [routerLink]="item.route"
                    routerLinkActive="active"
                    ariaCurrentWhenActive="page"
                    [routerLinkActiveOptions]="{
                      paths: 'exact',
                      queryParams: 'ignored',
                      matrixParams: 'ignored',
                      fragment: 'ignored',
                    }"
                  >
                    {{ item.label }}
                    @if (item.feature && capabilities.state(item.feature).phase !== 'available') {
                      <span class="cm-capability-badge">{{
                        capabilities.state(item.feature).label
                      }}</span>
                    }
                  </a>
                } @else {
                  <span
                    class="cm-unavailable-item"
                    aria-disabled="true"
                    [title]="capabilities.state(item.feature).detail"
                  >
                    <span>{{ item.label }}</span>
                    <span class="cm-capability-badge">{{
                      capabilities.state(item.feature).label
                    }}</span>
                  </span>
                }
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
      /* Clarity 기본 vertical-nav 폭(15rem)에 맞춰 콘텐츠 침범 없이 hierarchy를 표시한다. */
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
        overflow-x: auto;
        padding: 1.5rem 2rem;
        color: var(--os-ink);
        background: var(--os-overview-bg);
      }
      .cm-admin-nav {
        width: 100%;
        min-width: 0;
      }
      .cm-direct-item {
        font-weight: 500;
      }
      .cm-section-divider {
        height: 1px;
        margin: 0.5rem 0.75rem;
        background: var(--os-hairline);
      }
      .cm-unavailable-item {
        display: flex;
        align-items: center;
        min-height: 1.8rem;
        gap: 0.45rem;
        padding: 0.35rem 0.75rem 0.35rem 2.15rem;
        color: var(--os-ink-subtle);
        cursor: not-allowed;
        font-size: 0.7rem;
      }
      .cm-direct-unavailable {
        padding-left: 1rem;
        font-weight: 500;
      }
      .cm-capability-badge {
        margin-left: auto;
        padding: 0.05rem 0.28rem;
        border: 1px solid var(--os-hairline);
        border-radius: 999px;
        color: var(--os-muted);
        font-size: 0.52rem;
        font-weight: 600;
        line-height: 1.25;
        white-space: nowrap;
      }
      @media (max-width: 56rem) {
        .cc-frame {
          grid-template-columns: minmax(0, 1fr);
          overflow: visible;
        }
        .cm-admin-nav {
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
  private readonly destroyRef = inject(DestroyRef);
  readonly capabilities = inject(ManageCapabilityService);

  readonly expandedGroups = signal<ReadonlySet<string>>(new Set());
  readonly directItems: readonly AdminDirectItem[] = [
    { label: '개요', route: '/manage', icon: Dashboard16 },
    {
      label: 'Console Extensions',
      route: '/manage/extensions',
      icon: Application16,
      feature: 'extensions',
    },
  ];
  readonly groups: readonly AdminGroup[] = [
    {
      id: 'bbss',
      label: 'Backbone Service Stack',
      icon: HybridNetworking16,
      items: [
        { label: '개요', route: '/manage/bbss' },
        { label: 'Supabase', route: '/manage/bbss/supabase' },
        { label: 'Gitea', route: '/manage/bbss/gitea' },
        { label: 'Beszel', route: '/manage/bbss/beszel' },
      ],
    },
    {
      id: 'developer-tools',
      label: '개발 도구',
      icon: Catalog16,
      items: [
        { label: '개발자 카탈로그', route: '/manage/catalog' },
        { label: 'API', route: '/manage/apis' },
        { label: '콘솔 CLI', route: '/manage/cli', feature: 'cli' },
      ],
    },
    {
      id: 'console-access',
      label: '콘솔 및 접근',
      icon: UserAdmin16,
      items: [
        { label: '콘솔 관리자', route: '/manage/console-admins' },
        { label: '역할 및 권한', route: '/manage/roles' },
      ],
    },
    {
      id: 'platform-control',
      label: '플랫폼 제어',
      icon: Layers16,
      items: [
        { label: '제어 평면', route: '/manage/platform-control' },
        { label: '데이터 및 신원', route: '/manage/data-identity' },
        { label: '변경 통제', route: '/manage/change-control' },
        { label: 'OAA', route: '/manage/oaa', feature: 'oaa' },
        { label: 'HIS Observability', route: '/manage/observability', feature: 'observability' },
      ],
    },
    {
      id: 'operations-evidence',
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
    void this.capabilities.load();
    const capabilityTimer = window.setInterval(() => void this.capabilities.load(), 60_000);
    this.destroyRef.onDestroy(() => window.clearInterval(capabilityTimer));
    this.expandGroupForUrl(this.router.url);
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => this.expandGroupForUrl(event.urlAfterRedirects));
  }

  isGroupExpanded(groupId: string): boolean {
    return this.expandedGroups().has(groupId);
  }

  setGroupExpanded(groupId: string, expanded: boolean): void {
    this.expandedGroups.update((current) => {
      const next = new Set(current);
      if (expanded) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
  }

  private expandGroupForUrl(url: string): void {
    const path = (url.split(/[?#]/, 1)[0] || '/').replace(/\/+$/, '') || '/';
    const activeGroup = this.groups.find((group) =>
      group.items.some((item) => path === item.route || path.startsWith(`${item.route}/`)),
    );
    if (activeGroup) this.setGroupExpanded(activeGroup.id, true);
  }
}
