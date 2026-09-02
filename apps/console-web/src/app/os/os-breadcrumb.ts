import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink } from '@angular/router';

export interface Crumb {
  label: string;
  route?: string;
}

/**
 * os-breadcrumb — 페이지 경로 표시(ACC: "IBM Cloud / API Management / Overview").
 * route 있는 항목은 링크(액센트), 마지막(현재 페이지)은 일반 텍스트. 구분자 "/".
 */
@Component({
  selector: 'os-breadcrumb',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="os-bc" aria-label="breadcrumb">
      @for (it of items; track $index; let last = $last) {
        @if (!last && it.route) {
          <a class="os-bc-link" [routerLink]="it.route">{{ it.label }}</a>
        } @else {
          <span class="os-bc-cur">{{ it.label }}</span>
        }
        @if (!last) { <span class="os-bc-sep">/</span> }
      }
    </nav>
  `,
  styles: [
    `
      .os-bc { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; font-size: 0.8125rem; margin: 0 0 0.75rem; }
      .os-bc-link { color: var(--os-accent); text-decoration: none; }
      .os-bc-link:hover { text-decoration: underline; }
      .os-bc-sep { color: var(--os-ink-subtle); }
      .os-bc-cur { color: var(--os-ink-muted); }
    `,
  ],
})
export class OsBreadcrumb {
  @Input({ required: true }) items: Crumb[] = [];
}
