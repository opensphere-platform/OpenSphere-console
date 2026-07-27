import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'os-session-step-up',
  imports: [ClarityModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <clr-modal
      [clrModalOpen]="auth.stepUpRequired()"
      [clrModalClosable]="!auth.stepUpBusy()"
      [clrModalSize]="'sm'"
      (clrModalOpenChange)="modalChanged($event)"
    >
      <h3 class="modal-title">보안 작업 재확인</h3>
      <div class="modal-body">
        <p>보안 설정이나 운영 상태를 변경하려면 최근 5분 이내의 다중 인증이 필요합니다.</p>
        <form clrForm clrLayout="vertical" (ngSubmit)="submit()">
          <clr-input-container>
            <label>인증 앱의 6자리 코드</label>
            <input
              clrInput
              name="step-up-code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              pattern="[0-9]{6}"
              [(ngModel)]="code"
              [disabled]="auth.stepUpBusy()"
              required
            />
            <clr-control-helper>확인 후 5분 동안 고위험 작업을 수행할 수 있습니다.</clr-control-helper>
          </clr-input-container>
          @if (auth.stepUpError()) {
            <clr-alert clrAlertType="danger" [clrAlertClosable]="false">
              <clr-alert-item><span class="alert-text">{{ auth.stepUpError() }}</span></clr-alert-item>
            </clr-alert>
          }
        </form>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline" (click)="auth.cancelStepUp()" [disabled]="auth.stepUpBusy()">취소</button>
        <button type="button" class="btn btn-primary" (click)="submit()" [disabled]="auth.stepUpBusy() || !validCode()">
          @if (auth.stepUpBusy()) { <span class="spinner spinner-inline" aria-hidden="true"></span> }
          재확인
        </button>
      </div>
    </clr-modal>
  `,
  styles: [`
    .modal-body p{margin:0 0 var(--os-5);color:var(--os-ink-muted);font-size:.72rem;line-height:1.5}
    clr-input-container{margin-top:0}
    clr-alert{display:block;margin-top:var(--os-4)}
  `],
})
export class OsSessionStepUp {
  readonly auth = inject(AuthService);
  code = '';

  validCode(): boolean { return /^\d{6}$/.test(this.code.trim()); }

  modalChanged(open: boolean): void {
    if (!open && !this.auth.stepUpBusy()) {
      this.code = '';
      this.auth.cancelStepUp();
    }
  }

  async submit(): Promise<void> {
    if (!this.validCode() || this.auth.stepUpBusy()) return;
    try {
      await this.auth.completeStepUp(this.code);
      this.code = '';
    } catch {
      // The service exposes a modal-scoped error without leaking factor detail.
    }
  }
}
