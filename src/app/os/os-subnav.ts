import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CarbonIcon } from './carbon-icon';

export interface SubnavItem {
  label: string;
  route: string;
  icon: any;
}

/**
 * os-subnav — 재사용 2단 보조 사이드 내비 (ACC SecondMenu 패턴).
 * 한 섹션에 진입했을 때 그 하위 페이지들을 좌측 2단으로 노출(1단 = 셸 nav).
 * 디자인 토큰(docs/DESIGN-TOKENS.md): 화이트 패널 · 활성=sphere-blue 좌측 바 · Carbon 아이콘.
 */
@Component({
  selector: 'os-subnav',
  imports: [RouterLink, RouterLinkActive, CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <nav class="os-secondbar" [attr.aria-label]="title + ' 보조 내비'">
      <div class="os-secondbar__title"><strong>{{ title }}</strong></div>
      <div class="os-secondbar__items" role="menu">
        @for (it of items; track it.route) {
          <a class="os-secondbar__item" role="menuitem" [routerLink]="it.route" routerLinkActive="is-active">
            <os-cicon [icon]="it.icon" [size]="16" /><span>{{ it.label }}</span>
          </a>
        }
      </div>
    </nav>
  `,
  styles: [
    `
      /* 호스트가 섹션 높이를 꽉 채우고(secondbar가 페이지 바닥까지) 내부 스크롤. */
      :host { display: flex; flex-direction: column; align-self: stretch; }
      .os-secondbar {
        flex: 1 1 auto; width: 15.75rem; overflow-y: auto;
        background: #ffffff; border-inline-end: 1px solid var(--os-hairline);
      }
      .os-secondbar__title {
        display: flex; align-items: center; min-height: 3.25rem;
        padding-inline: 1rem; border-block-end: 1px solid var(--os-hairline);
      }
      .os-secondbar__title strong { font-size: 0.875rem; font-weight: 600; color: var(--os-ink); }
      .os-secondbar__items { padding-block: 0; }
      .os-secondbar__item {
        display: grid; grid-template-columns: 1rem minmax(0, 1fr) auto; column-gap: 0.5rem;
        align-items: center; min-height: 2.25rem; padding: 0.5rem 1rem;
        color: var(--os-ink-muted); font-size: 0.875rem; text-decoration: none; cursor: pointer;
        border-left: 3px solid transparent;
      }
      .os-secondbar__item os-cicon { color: var(--os-ink-muted); }
      .os-secondbar__item:hover { background: var(--os-nav-hover); color: var(--os-ink); }
      .os-secondbar__item.is-active {
        background: var(--os-nav-hover); border-left-color: var(--os-accent);
        color: var(--os-ink); font-weight: 600;
      }
    `,
  ],
})
export class OsSubnav {
  @Input({ required: true }) title!: string;
  @Input({ required: true }) items!: SubnavItem[];
}
