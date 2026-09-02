import { Component, Input, ChangeDetectionStrategy } from '@angular/core';

/**
 * Core 페이지 graceful degradation (ADR-UI-003 §3.2) — core 기능의 백엔드가 미배포/불건전일 때
 * cryptic 502/Failed-to-fetch 대신 *친절한 상태*를 보인다. 콘솔 셸 자체는 정상임을 명시하고,
 * 백엔드 복구 시 자동 회복됨을 알린다. 기술 상세는 접어서 보존.
 */
@Component({
  selector: 'os-backend-unavailable',
  template: `
    <div class="os-bu">
      <div class="os-bu-icon" aria-hidden="true">⚠</div>
      <h2 class="os-bu-title">{{ feature || '이 기능' }}의 백엔드를 사용할 수 없습니다</h2>
      <p class="os-bu-body">
        @if (backend) {
          <code>{{ backend }}</code>
        }
        백엔드가 배포되지 않았거나 응답하지 않습니다. <strong>콘솔 자체는 정상</strong>이며,
        백엔드가 준비되면 새로고침 시 자동 복구됩니다.
      </p>
      @if (hint) {
        <p class="os-bu-hint">{{ hint }}</p>
      }
      @if (detail) {
        <details class="os-bu-detail">
          <summary>기술 상세</summary>
          <code>{{ detail }}</code>
        </details>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .os-bu {
        max-width: 520px;
        margin: 2.5rem auto;
        text-align: center;
        color: var(--os-muted);
      }
      .os-bu-icon {
        font-size: 2rem;
        opacity: 0.6;
        margin-bottom: 0.5rem;
      }
      .os-bu-title {
        font-size: 1rem;
        color: var(--os-ink);
        margin: 0 0 0.6rem;
      }
      .os-bu-body {
        font-size: 0.78rem;
        line-height: 1.5;
      }
      .os-bu-body code,
      .os-bu-detail code {
        font-family: monospace;
        font-size: 0.72rem;
        color: var(--os-ink);
      }
      .os-bu-hint {
        font-size: 0.72rem;
        margin-top: 0.6rem;
      }
      .os-bu-detail {
        margin-top: 1rem;
        font-size: 0.7rem;
        text-align: left;
        display: inline-block;
      }
      .os-bu-detail summary {
        cursor: pointer;
      }
    `,
  ],
})
export class BackendUnavailable {
  @Input() feature = '';
  @Input() backend = '';
  @Input() hint = '';
  @Input() detail = '';
}
