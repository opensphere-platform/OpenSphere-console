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
        @if (assurance) {
          <div class="security-assurance" [class.is-verified]="assurance === 'aal2'" role="status">
            <strong>{{ assurance === 'aal2' ? '현재 MFA 확인됨' : 'OTP 재확인 예정' }}</strong>
            <span>
              {{ assurance === 'aal2'
                ? '현재 세션의 다중 인증(AAL2)이 유효합니다. 제출할 때 OTP 창을 다시 열지 않고 이 인증을 사용합니다.'
                : '현재 세션은 비밀번호 인증(AAL1) 상태입니다. 제출 후 인증 앱의 6자리 코드 재확인이 표시됩니다.' }}
            </span>
          </div>
        }
        @if (error) {
          <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="false">
            <clr-alert-item><span class="alert-text">{{ error }}</span></clr-alert-item>
          </clr-alert>
        }
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
  styles: [`
    clr-textarea-container{display:block;width:100%}
    textarea[clrTextarea]{box-sizing:border-box;width:100%;min-width:100%;min-height:8rem;resize:vertical}
    .modal-body p{white-space:pre-line;overflow-wrap:anywhere}
    .security-assurance{display:grid;gap:.2rem;margin:.75rem 0;padding:.65rem .75rem;border-left:.15rem solid var(--os-warning);background:var(--os-surface-1);color:var(--os-ink-muted);font-size:.7rem;line-height:1.45}
    .security-assurance strong{color:var(--os-ink);font-size:.72rem}
    .security-assurance.is-verified{border-left-color:var(--os-success)}
    .security-assurance.is-verified strong{color:var(--os-success)}
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class OsActionDialog implements OnChanges {
  @Input() open = false;
  @Input() title = '동작 확인';
  @Input() message = '';
  @Input() confirmLabel = '확인';
  @Input() danger = false;
  @Input() busy = false;
  @Input() error = '';
  @Input() reasonRequired = false;
  @Input() reasonLabel = '변경 사유';
  @Input() minReasonLength = 8;
  @Input() assurance: 'aal1' | 'aal2' | '' = '';
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
