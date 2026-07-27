import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { CarbonIcon } from '../os/carbon-icon';
import UserAdmin16 from '@carbon/icons/es/user--admin/16';
import Application16 from '@carbon/icons/es/application/16';
import UserMultiple16 from '@carbon/icons/es/user--multiple/16';
import Catalog16 from '@carbon/icons/es/catalog/16';
import Api16 from '@carbon/icons/es/api/16';
import Layers16 from '@carbon/icons/es/layers/16';
import ChatBot16 from '@carbon/icons/es/chat-bot/16';
import Activity16 from '@carbon/icons/es/activity/16';
import Notification16 from '@carbon/icons/es/notification/16';
import Terminal16 from '@carbon/icons/es/terminal/16';
import List16 from '@carbon/icons/es/list/16';
import ChartLine16 from '@carbon/icons/es/chart--line/16';

interface AdminItem { label: string; route: string; icon: any }
interface AdminGroup { label: string; items: AdminItem[] }

/**
 * AdminLayout — "콘솔 관리" 섹션 레이아웃 (Model A: 1단 진입 → 2단 보조메뉴 + 콘텐츠).
 * 2단 메뉴 표준 = OpenSphere AI Hub 방식(전역 .cm-nav: Clarity clr-vertical-nav, 흰 배경, 왼쪽 blue bar active).
 * 관리 대상의 성격에 따라 자산·신원·기반·운영 트리로 묶는다.
 */
@Component({
  selector: 'os-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ClarityModule, CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="cc-frame">
      <clr-vertical-nav class="cm-nav" [clrVerticalNavCollapsible]="false" aria-label="콘솔 관리 보조 내비">
        <div class="cm-brand"><strong>콘솔 관리</strong></div>
        @for (group of groups; track group.label) {
          <section class="cm-tree-group" [attr.aria-label]="group.label">
            <div class="cm-tree-label">{{ group.label }}</div>
            @for (item of group.items; track item.route) {
              <a clrVerticalNavLink class="cm-tree-item" [routerLink]="item.route" routerLinkActive="active">
                <os-cicon clrVerticalNavIcon [icon]="item.icon" [size]="16" />{{ item.label }}
              </a>
            }
          </section>
        }
      </clr-vertical-nav>
      <div class="cm-mobile-nav">
        <label for="console-management-section">콘솔 관리 메뉴</label>
        <select id="console-management-section" (change)="navigate($event)">
          <option value="">이동할 관리 화면 선택</option>
          @for (group of groups; track group.label) {
            <optgroup [label]="group.label">
              @for (item of group.items; track item.route) {
                <option [value]="item.route">{{ item.label }}</option>
              }
            </optgroup>
          }
        </select>
      </div>
      <div class="cc-content"><router-outlet /></div>
    </div>
  `,
  styles: [
    `
      /* 풀블리드(1단 레일·헤더 밀착) — 네이티브 라우트라 페이지가 콘솔 패딩 상쇄. AI 표준 그리드 12rem|1fr. */
      .cc-frame { display: grid; grid-template-columns: 12rem minmax(0, 1fr); margin: -1.5rem; min-height: calc(100% + 3rem); overflow-x: hidden; }
      /* 콘텐츠 — 섹션 공통 배경 토큰 + 패딩. (.cm-nav 스타일은 전역 styles.scss) */
      .cc-content { min-width: 0; overflow-x: hidden; padding: 1.5rem 2rem; color: var(--os-ink); background: var(--os-overview-bg); }
      .cm-tree-group { display: block; margin: 0; padding: 0; }
      .cm-tree-label { padding: .8rem .85rem .25rem; color: var(--os-ink-subtle); font-size: .58rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
      .cm-tree-item { padding-left: 1rem; }
      .cm-mobile-nav { display: none; }
      @media (max-width: 64rem) {
        .cc-frame { grid-template-columns: minmax(0, 1fr); }
        .cm-nav { display: none; }
        .cm-mobile-nav { display: flex; align-items: center; gap: var(--os-4); min-width: 0; padding: var(--os-4) var(--os-5); border-bottom: 1px solid var(--os-hairline); background: var(--os-canvas); }
        .cm-mobile-nav label { flex: 0 0 auto; font-size: .68rem; font-weight: 600; }
        .cm-mobile-nav select { min-width: 0; width: min(24rem, 100%); height: 1.8rem; border: 1px solid var(--os-hairline-strong); background: var(--os-canvas); color: var(--os-ink); font: inherit; }
        .cc-content { padding: 1rem 1.25rem 1.5rem; }
      }
    `,
  ],
})
export class AdminLayout {
  private readonly router = inject(Router);
  readonly groups: AdminGroup[] = [
    {
      label: '자산 및 확장',
      items: [
        { label: 'Developer Catalog', route: '/manage/catalog', icon: Catalog16 },
        { label: 'APIs', route: '/manage/apis', icon: Api16 },
        { label: 'Console CLI', route: '/manage/cli', icon: Terminal16 },
        { label: 'Extensions', route: '/manage/extensions', icon: Application16 },
      ],
    },
    {
      label: '신원 및 접근',
      items: [
        { label: '콘솔 관리자', route: '/manage/console-admins', icon: UserAdmin16 },
        { label: '역할', route: '/manage/roles', icon: UserMultiple16 },
      ],
    },
    {
      label: '플랫폼 제어',
      items: [
        { label: 'Control Plane', route: '/manage/platform-control', icon: Layers16 },
        { label: 'Data & Identity', route: '/manage/data-identity', icon: UserAdmin16 },
        { label: '상태 변경 관리', route: '/manage/state-changes', icon: List16 },
        { label: 'OAA', route: '/manage/oaa', icon: ChatBot16 },
        { label: '인프라 모니터링', route: '/manage/infrastructure-monitoring', icon: ChartLine16 },
        { label: 'HIS Observability', route: '/manage/observability', icon: Activity16 },
      ],
    },
    {
      label: '운영 및 증거',
      items: [
      { label: '알림', route: '/manage/notifications', icon: Notification16 },
      { label: '외부 채널', route: '/manage/external-channels', icon: Notification16 },
        { label: '감사 로그', route: '/manage/audit', icon: List16 },
      ],
    },
  ];

  navigate(event: Event): void {
    const route = (event.target as HTMLSelectElement | null)?.value || '';
    if (route.startsWith('/manage/')) void this.router.navigateByUrl(route);
  }
}
