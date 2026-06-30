import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { CarbonIcon } from '../os/carbon-icon';
import UserAdmin16 from '@carbon/icons/es/user--admin/16';
import Application16 from '@carbon/icons/es/application/16';
import UserMultiple16 from '@carbon/icons/es/user--multiple/16';
import Layers16 from '@carbon/icons/es/layers/16';
import Activity16 from '@carbon/icons/es/activity/16';

interface AdminItem { label: string; route: string; icon: any }

/**
 * AdminLayout — "콘솔 관리" 섹션 레이아웃 (Model A: 1단 진입 → 2단 보조메뉴 + 콘텐츠).
 * 2단 메뉴 표준 = OpenSphere AI Hub 방식(전역 .cm-nav: Clarity clr-vertical-nav, 흰 배경, 왼쪽 blue bar active).
 * 네이티브 라우트라 풀블리드는 .cc-frame margin:-1.5rem 가 담당. 자식 = console-admins / plugins / roles.
 */
@Component({
  selector: 'os-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ClarityModule, CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="cc-frame">
      <clr-vertical-nav class="cm-nav" [clrVerticalNavCollapsible]="false" aria-label="콘솔 관리 보조 내비">
        <div class="cm-brand"><strong>콘솔 관리</strong></div>
        @for (it of items; track it.route) {
          <a clrVerticalNavLink [routerLink]="it.route" routerLinkActive="active">
            <os-cicon clrVerticalNavIcon [icon]="it.icon" [size]="16" />{{ it.label }}
          </a>
        }
      </clr-vertical-nav>
      <div class="cc-content"><router-outlet /></div>
    </div>
  `,
  styles: [
    `
      /* 풀블리드(1단 레일·헤더 밀착) — 네이티브 라우트라 페이지가 콘솔 패딩 상쇄. AI 표준 그리드 12rem|1fr. */
      .cc-frame { display: grid; grid-template-columns: 12rem minmax(0, 1fr); margin: -1.5rem; min-height: calc(100% + 3rem); overflow-x: hidden; }
      /* 콘텐츠 — 섹션 공통 배경 토큰 + 패딩. (.cm-nav 스타일은 전역 styles.scss) */
      .cc-content { min-width: 0; overflow-x: hidden; padding: 1.5rem 2rem; color: var(--os-ink); background: var(--os-overview-bg); }
    `,
  ],
})
export class AdminLayout {
  readonly items: AdminItem[] = [
    { label: '콘솔 관리자', route: '/manage/console-admins', icon: UserAdmin16 },
    { label: 'Plugins', route: '/manage/plugins', icon: Application16 },
    { label: '역할', route: '/manage/roles', icon: UserMultiple16 },
    { label: 'Backbone', route: '/manage/backbone', icon: Layers16 },
    { label: 'Observability', route: '/manage/observability', icon: Activity16 },
  ];
}
