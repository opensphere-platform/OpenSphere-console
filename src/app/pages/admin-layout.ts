import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { OsSubnav, SubnavItem } from '../os/os-subnav';
import UserAdmin16 from '@carbon/icons/es/user--admin/16';
import Application16 from '@carbon/icons/es/application/16';
import UserMultiple16 from '@carbon/icons/es/user--multiple/16';

/**
 * AdminLayout — "콘솔 관리" 섹션 레이아웃 (Model A: 1단 진입 → 2단 보조메뉴 + 콘텐츠).
 * 1단(셸 nav)의 "콘솔 관리"로 진입하면 이 레이아웃이 [2단 os-subnav | 자식 페이지]를 렌더한다.
 * 자식 = console-admins / plugins / roles (중첩 라우트).
 */
@Component({
  selector: 'os-admin-layout',
  imports: [RouterOutlet, OsSubnav],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-section">
      <os-subnav title="콘솔 관리" [items]="items" />
      <div class="os-section__content"><router-outlet /></div>
    </div>
  `,
  styles: [
    `
      /* content-area 패딩(1.5rem) 상쇄 → 2단 flush + 풀하이트. 마진=패딩 일치(오버플로 0). */
      .os-section { display: flex; align-items: stretch; margin: -1.5rem; min-height: calc(100% + 3rem); }
      .os-section__content {
        flex: 1 1 auto; min-width: 0; padding: 1.5rem 2rem; overflow-x: hidden;
        background:
          radial-gradient(circle at 82% 82%, rgba(190, 230, 255, 0.5), transparent 26rem),
          radial-gradient(circle at 92% 72%, rgba(255, 214, 232, 0.4), transparent 24rem),
          var(--os-surface-1);
      }
    `,
  ],
})
export class AdminLayout {
  readonly items: SubnavItem[] = [
    { label: '콘솔 관리자', route: '/manage/console-admins', icon: UserAdmin16 },
    { label: 'Plugins', route: '/manage/plugins', icon: Application16 },
    { label: '역할', route: '/manage/roles', icon: UserMultiple16 },
  ];
}
