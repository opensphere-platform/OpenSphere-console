import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  Output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ClarityModule } from '@clr/angular';

/**
 * os-panel — OpenSphere 퀵뷰 패널 퍼사드 (명세 R1~R8).
 * 골격은 Clarity `clr-side-panel`(ESC·backdrop·X 닫기·role=dialog·포커스 트랩 전부 위임).
 *
 * [예외 등록] Clarity 부재로 자작 유지하는 단 한 가지: R2 마우스 드래그 폭 조절 + 폭 기억.
 * clr-side-panel의 size는 sm~full-screen 프리셋뿐이라 연속 폭 조절이 불가능하다.
 * → 그립 오버레이 + .modal-dialog 폭의 CSS 변수 오버라이드로 확장 (DESIGN-GUIDE.md §8 예외 1)
 *
 * 공개 API는 v0.1.2와 동일 — 화면(pages/*)은 한 줄도 바뀌지 않는다(퍼사드 절연).
 */
@Component({
  selector: 'os-panel',
  imports: [ClarityModule],
  template: `
    @if (open) {
      <div
        class="os-panel-grip"
        [class.is-resizing]="resizing()"
        [style.right.px]="width()"
        role="separator"
        aria-label="패널 폭 조절"
        aria-orientation="vertical"
        [attr.aria-valuemin]="minimumWidth"
        [attr.aria-valuemax]="maximumWidth()"
        [attr.aria-valuenow]="width()"
        tabindex="0"
        (pointerdown)="startResize($event)"
        (keydown)="resizeWithKeyboard($event)"
        title="드래그하거나 방향키로 폭 조절"
      ></div>
    }
    <clr-side-panel
      [clrSidePanelOpen]="open"
      (clrSidePanelOpenChange)="onOpenChange($event)"
      [clrSidePanelBackdrop]="true"
      [style.--os-panel-w]="width() + 'px'"
    >
      <div class="side-panel-title">
        <div class="os-panel-title-row">
          @if (logoSrc) {
            <span class="os-panel-logo-chip"><img class="os-panel-logo" [src]="logoSrc" alt="" /></span>
          }
          <div class="os-panel-title-text">
            {{ title }}
            @if (subtitle) {
              <div class="os-panel-sub">{{ subtitle }}</div>
            }
          </div>
        </div>
        @if (fullHref) {
          <a class="os-panel-full" [href]="fullHref" target="_blank" rel="noopener"
            >전체 페이지로 열기 ↗</a
          >
        }
      </div>
      <div class="side-panel-body">
        <div class="os-panel-content clr-form-full-width">
          <ng-content />
        </div>
      </div>
      <div class="side-panel-footer os-panel-footer">
        <ng-content select="[osPanelFooter]" />
      </div>
    </clr-side-panel>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* R2 확장: Clarity size 프리셋 대신 연속 폭 — 변수 하나만 주입
     * (.side-panel은 clr-side-panel 호스트 자신의 클래스) */
      /* Clarity owns the fixed viewport layer on .modal, not on the inner
       * .modal-dialog. Offset the whole layer so its title, close control,
       * body and hit area all begin below the Main Shell header. */
      :host ::ng-deep clr-side-panel.side-panel .modal:not(.modal-full-screen) {
        top: var(--os-header-height, 3rem);
        height: calc(100vh - var(--os-header-height, 3rem)) !important;
      }
      :host ::ng-deep clr-side-panel.side-panel .modal-dialog {
        width: var(--os-panel-w, 72vw) !important;
        height: 100% !important;
        min-width: 420px;
        max-width: 92vw;
      }
      .os-panel-grip {
        position: fixed;
        top: var(--os-header-height, 3rem);
        bottom: 0;
        width: 12px;
        transform: translateX(50%);
        z-index: var(--os-z-panel-grip, 1060);
        cursor: col-resize;
        touch-action: none;
        outline: none;
      }
      .os-panel-grip::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        width: 4px;
        height: 64px;
        border: 1px solid rgba(55, 73, 110, 0.28);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 1px 5px rgba(20, 33, 61, 0.18);
        transform: translate(-50%, -50%);
        transition:
          background 120ms ease,
          border-color 120ms ease,
          width 120ms ease;
      }
      .os-panel-grip:hover::after,
      .os-panel-grip:focus-visible::after,
      .os-panel-grip.is-resizing::after {
        width: 6px;
        border-color: var(--cds-alias-object-interaction-color, #4c6fff);
        background: var(--cds-alias-object-interaction-color, #4c6fff);
      }
      .os-panel-grip:focus-visible {
        box-shadow: 0 0 0 3px rgba(76, 111, 255, 0.22);
      }
      .os-panel-title-row {
        display: flex;
        align-items: center;
        gap: 0.7rem;
      }
      .os-panel-logo-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }
      .os-panel-logo {
        width: 56px;
        height: 56px;
      }
      .os-panel-title-text {
        min-width: 0;
      }
      .os-panel-sub {
        font-size: 0.65rem;
        color: var(--os-muted, #667193);
        font-weight: 400;
      }
      .os-panel-full {
        font-size: 0.65rem;
        font-weight: 400;
        white-space: nowrap;
      }
      .os-panel-content {
        width: 100%;
        min-height: 100%;
        display: flex;
        flex-direction: column;
      }
      .os-panel-footer {
        min-height: 3.25rem;
        align-items: center;
        padding: 0.65rem 1.2rem;
        border-top: 1px solid var(--os-hairline, #d7dce1);
        background: var(--os-canvas, #fff);
      }
      .os-panel-footer:empty {
        display: none;
      }
      .os-panel-footer > [osPanelFooter] {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
        margin: 0;
      }
    `,
  ],
})
export class OsPanel {
  @Input() open = false;
  @Input() title = '';
  @Input() subtitle = '';
  @Input() logoSrc = '';
  @Input() fullHref = '';
  @Output() closed = new EventEmitter<void>();

  readonly minimumWidth = 420;
  readonly width = signal<number>(this.restoreWidth());
  readonly resizing = signal(false);

  onOpenChange(open: boolean): void {
    if (!open) this.closed.emit();
  }

  /** R3 보강: 이 구성(임베드 side-panel)에서 Clarity ESC가 발화하지 않아 동작 글루로 복원.
   *  스타일이 아닌 동작이며, 닫힘 경로는 Clarity openChange와 동일하게 closed로 수렴. */
  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.open) this.closed.emit();
  }

  startResize(ev: PointerEvent): void {
    ev.preventDefault();
    this.resizing.set(true);
    const move = (e: PointerEvent) => {
      if (!this.resizing()) return;
      this.width.set(this.clampWidth(window.innerWidth - e.clientX));
    };
    const up = () => {
      this.resizing.set(false);
      this.rememberWidth();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  resizeWithKeyboard(ev: KeyboardEvent): void {
    const step = ev.shiftKey ? 64 : 24;
    let next = this.width();
    if (ev.key === 'ArrowLeft') next += step;
    else if (ev.key === 'ArrowRight') next -= step;
    else if (ev.key === 'Home') next = this.minimumWidth;
    else if (ev.key === 'End') next = this.maximumWidth();
    else return;
    ev.preventDefault();
    this.width.set(this.clampWidth(next));
    this.rememberWidth();
  }

  @HostListener('window:resize')
  onViewportResize(): void {
    this.width.set(this.clampWidth(this.width()));
  }

  maximumWidth(): number {
    return Math.max(this.minimumWidth, Math.round(window.innerWidth * 0.92));
  }

  private clampWidth(value: number): number {
    return Math.round(Math.min(Math.max(value, this.minimumWidth), this.maximumWidth()));
  }

  private rememberWidth(): void {
    sessionStorage.setItem('os-panel-width', String(this.width()));
  }

  private restoreWidth(): number {
    const saved = Number(sessionStorage.getItem('os-panel-width'));
    return this.clampWidth(saved >= this.minimumWidth ? saved : window.innerWidth * 0.72);
  }
}
