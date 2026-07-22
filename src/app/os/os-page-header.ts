import { Component, Input, ChangeDetectionStrategy } from '@angular/core';

/**
 * os-page-header — 모든 셸 네이티브 페이지의 공통 헤더(페이지 템플릿 강제).
 * 일관된 타이틀 타이포(디자인 토큰) + 보조 태그 + lead 슬롯(<ng-content>).
 * 사용: <os-page-header title="콘솔 관리자" tag="Supabase Identity"><p>lead…</p></os-page-header>
 * 주의: Clarity 전역 CSS가 <header>/<h3>를 다크 처리 → div + h1만 사용.
 */
@Component({
  selector: 'os-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="oph">
      <h1 class="oph-title">{{ title }}@if (tag) { <span class="oph-tag">{{ tag }}</span> }</h1>
      <div class="oph-lead"><ng-content /></div>
    </div>
  `,
  styles: [
    `
      .oph { margin: 0 0 1.25rem; }
      .oph-title {
        margin: 0; font-size: 1.75rem; font-weight: 400; line-height: 1.2;
        letter-spacing: -0.01em; color: var(--os-ink);
      }
      .oph-tag { margin-left: 0.55rem; font-size: 0.8rem; font-weight: 400; color: var(--os-ink-subtle); }
      .oph-lead { margin: 0.5rem 0 0; color: var(--os-ink-muted); font-size: 0.9rem; line-height: 1.5; max-width: 62rem; }
      .oph-lead ::ng-deep p { margin: 0; }
      .oph-lead ::ng-deep code {
        font-family: monospace; font-size: 0.85em; background: var(--os-surface-1);
        padding: 0.05rem 0.3rem; border-radius: 3px;
      }
    `,
  ],
})
export class OsPageHeader {
  @Input({ required: true }) title = '';
  @Input() tag = '';
}
