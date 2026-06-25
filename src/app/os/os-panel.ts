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
 * → 그립 오버레이 + .modal-dialog 폭의 CSS 변수 오버라이드로 확장 (DESIGN-RULES.md #예외 1)
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
        [style.right.px]="width()"
        (mousedown)="startResize($event)"
        title="드래그로 폭 조절"
      ></div>
    }
    <clr-side-panel
      [clrSidePanelOpen]="open"
      (clrSidePanelOpenChange)="onOpenChange($event)"
      [clrSidePanelBackdrop]="true"
      [style.--os-panel-w]="width() + 'px'"
    >
      <div class="side-panel-title">
        {{ title }}
        @if (subtitle) {
          <div class="os-panel-sub">{{ subtitle }}</div>
        }
        @if (fullHref) {
          <a class="os-panel-full" [href]="fullHref" target="_blank" rel="noopener"
            >전체 페이지로 열기 ↗</a
          >
        }
      </div>
      <div class="side-panel-body">
        <ng-content />
      </div>
    </clr-side-panel>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      /* R2 확장: Clarity size 프리셋 대신 연속 폭 — 변수 하나만 주입
     * (.side-panel은 clr-side-panel 호스트 자신의 클래스) */
      :host ::ng-deep clr-side-panel.side-panel .modal-dialog {
        width: var(--os-panel-w, 72vw) !important;
        min-width: 420px;
        max-width: 92vw;
      }
      .os-panel-grip {
        position: fixed;
        top: 0;
        bottom: 0;
        width: 8px;
        z-index: 1060;
        cursor: col-resize;
      }
      .os-panel-grip:hover {
        background: rgba(76, 111, 255, 0.35);
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
    `,
  ],
})
export class OsPanel {
  @Input() open = false;
  @Input() title = '';
  @Input() subtitle = '';
  @Input() fullHref = '';
  @Output() closed = new EventEmitter<void>();

  readonly width = signal<number>(this.restoreWidth());

  private resizing = false;

  onOpenChange(open: boolean): void {
    if (!open) this.closed.emit();
  }

  /** R3 보강: 이 구성(임베드 side-panel)에서 Clarity ESC가 발화하지 않아 동작 글루로 복원.
   *  스타일이 아닌 동작이며, 닫힘 경로는 Clarity openChange와 동일하게 closed로 수렴. */
  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.open) this.closed.emit();
  }

  startResize(ev: MouseEvent): void {
    ev.preventDefault();
    this.resizing = true;
    const move = (e: MouseEvent) => {
      if (!this.resizing) return;
      const w = Math.min(Math.max(window.innerWidth - e.clientX, 420), window.innerWidth * 0.92);
      this.width.set(Math.round(w));
    };
    const up = () => {
      this.resizing = false;
      sessionStorage.setItem('os-panel-width', String(this.width()));
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  private restoreWidth(): number {
    const saved = Number(sessionStorage.getItem('os-panel-width'));
    return saved >= 420 ? saved : Math.round(window.innerWidth * 0.72);
  }
}
