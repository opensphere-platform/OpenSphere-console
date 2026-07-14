import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';

/**
 * Clarity 기반 위험 동작 확인창.
 * native prompt/confirm을 대체해 포커스 트랩, ESC, 키보드 탐색을 Clarity에 위임한다.
 */
@Component({
  selector: 'os-action-dialog',
  imports: [ClarityModule, FormsModule],
  template: `
    <clr-modal
      [clrModalOpen]="open"
      (clrModalOpenChange)="onOpenChange($event)"
      [clrModalClosable]="!busy"
      [clrModalSize]="'md'"
    >
      <h3 class="modal-title">{{ title }}</h3>
      <div class="modal-body">
        <p>{{ message }}</p>
        @if (reasonRequired) {
          <clr-textarea-container>
            <label>{{ reasonLabel }}</label>
            <textarea
              clrTextarea
              [(ngModel)]="reason"
              name="os-action-reason"
              maxlength="240"
              [disabled]="busy"
              required
            ></textarea>
            <clr-control-helper>영구 감사에 기록됩니다({{ minReasonLength }}자 이상).</clr-control-helper>
          </clr-textarea-container>
        }
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline" (click)="cancel()" [disabled]="busy">취소</button>
        <button
          type="button"
          class="btn"
          [class.btn-danger]="danger"
          [class.btn-primary]="!danger"
          (click)="confirm()"
          [disabled]="busy || (reasonRequired && reason.trim().length < minReasonLength)"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </clr-modal>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class OsActionDialog implements OnChanges {
  @Input() open = false;
  @Input() title = '동작 확인';
  @Input() message = '';
  @Input() confirmLabel = '확인';
  @Input() danger = false;
  @Input() busy = false;
  @Input() reasonRequired = false;
  @Input() reasonLabel = '변경 사유';
  @Input() minReasonLength = 8;
  @Output() confirmed = new EventEmitter<string>();
  @Output() cancelled = new EventEmitter<void>();

  reason = '';

  ngOnChanges(): void {
    if (!this.open) this.reason = '';
  }

  onOpenChange(open: boolean): void {
    if (!open && this.open && !this.busy) this.cancel();
  }

  cancel(): void {
    if (this.busy) return;
    this.reason = '';
    this.cancelled.emit();
  }

  confirm(): void {
    const reason = this.reason.trim();
    if (this.busy || (this.reasonRequired && reason.length < this.minReasonLength)) return;
    this.confirmed.emit(reason);
  }
}
