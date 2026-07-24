import { Component, Input, Output, EventEmitter, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ClarityModule } from '@clr/angular';
import { MutationPlan } from '../core/mutation.types';

/**
 * MutationConfirmComponent — 변경 확인 UI(ADR-UI-004 D3 / §3.2). 소유=호출 컴포넌트.
 * confirmTier: toast=마찰0(이 컴포넌트 미사용), modal=요약+diff, modal+type=이름 타이핑 게이트.
 * sarAllowed===false면 확인 버튼 비활성+툴팁. diff는 색(빨강 remove/초록 add/노랑 change).
 */
@Component({
  selector: 'os-mutation-confirm',
  standalone: true,
  imports: [CommonModule, ClarityModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <clr-modal [clrModalOpen]="!!plan" [clrModalClosable]="true" (clrModalOpenChange)="!$event && cancel()">
      <h3 class="modal-title">{{ titleFor() }}</h3>
      <div class="modal-body">
        <p class="mc-summary">{{ plan?.intent?.summary }}</p>

        <ul class="mc-reasons" *ngIf="plan?.reasons?.length">
          <li *ngFor="let r of plan!.reasons" [class.mc-red]="plan!.risk === 'red'">{{ r }}</li>
        </ul>

        <div class="mc-diff" *ngIf="plan?.diff?.length">
          <div class="mc-diff-h">변경 내용</div>
          <div class="mc-row" *ngFor="let d of plan!.diff">
            <span class="mc-path">{{ d.path }}</span>
            <span class="mc-before" *ngIf="d.kind !== 'add'">{{ fmt(d.before) }}</span>
            <span class="mc-arrow" *ngIf="d.kind === 'change'">→</span>
            <span class="mc-after" *ngIf="d.kind !== 'remove'">{{ fmt(d.after) }}</span>
          </div>
        </div>

        <div class="mc-type" *ngIf="plan?.confirmTier === 'modal+type'">
          <label>위험한 작업입니다. 계속하려면 리소스 이름 <strong>{{ targetName() }}</strong> 을(를) 입력하세요.</label>
          <input class="clr-input mc-type-input" [value]="typed()" (input)="typed.set($any($event.target).value)" placeholder="{{ targetName() }}" />
        </div>

        <p class="mc-denied" *ngIf="plan && !plan.sarAllowed">이 작업을 수행할 권한이 없습니다(RBAC).</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" (click)="cancel()">취소</button>
        <button class="btn"
          [class.btn-danger]="plan?.risk === 'red'"
          [disabled]="!canConfirm()"
          [title]="plan && !plan.sarAllowed ? '권한 없음(RBAC)' : ''"
          (click)="ok()">{{ plan?.risk === 'red' ? '위험 감수하고 실행' : '실행' }}</button>
      </div>
    </clr-modal>
  `,
  styles: [`
    .mc-summary { font-size: 0.9rem; color: var(--os-ink, #161616); margin: 0 0 0.6rem; }
    .mc-reasons { margin: 0 0 0.7rem; padding-left: 1.1rem; font-size: 0.8rem; color: #525252; }
    .mc-reasons .mc-red { color: #da1e28; font-weight: 600; }
    .mc-diff-h { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: #8c8c8c; margin: 0.4rem 0 0.3rem; }
    .mc-row { display: flex; gap: 0.4rem; align-items: center; font-family: var(--os-font-mono, monospace); font-size: 0.72rem; padding: 0.15rem 0; border-bottom: 1px solid #f0f0f0; }
    .mc-path { color: #525252; min-width: 11rem; word-break: break-all; }
    .mc-before { color: #da1e28; text-decoration: line-through; }
    .mc-after { color: #1c7d3a; }
    .mc-arrow { color: #8c8c8c; }
    .mc-type { margin: 0.7rem 0 0; font-size: 0.8rem; }
    .mc-type-input { width: 100%; margin-top: 0.3rem; }
    .mc-denied { color: #da1e28; font-size: 0.8rem; margin-top: 0.6rem; }
  `],
})
export class MutationConfirmComponent {
  @Input() plan: MutationPlan | null = null;
  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();

  readonly typed = signal('');

  titleFor(): string {
    if (!this.plan) return '확인';
    return this.plan.risk === 'red' ? '위험 작업 확인' : '변경 확인';
  }
  targetName(): string {
    const p = this.plan?.intent;
    return p?.sar?.name || p?.body?.metadata?.name || (p?.path.split('?')[0].split('/').pop() ?? '');
  }
  canConfirm(): boolean {
    if (!this.plan) return false;
    if (!this.plan.sarAllowed) return false;
    if (this.plan.confirmTier === 'modal+type') return this.typed().trim() === this.targetName();
    return true;
  }
  fmt(v: any): string {
    if (v === undefined || v === null) return '∅';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  ok(): void { if (this.canConfirm()) { this.confirmed.emit(); this.typed.set(''); } }
  cancel(): void { this.cancelled.emit(); this.typed.set(''); }
}
