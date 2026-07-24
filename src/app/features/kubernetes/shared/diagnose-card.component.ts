import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Diagnosis, DiagAction } from './diagnose.model';

/**
 * DiagnoseCardComponent — "왜 안 떠 있나"의 평문 진단 + 추천 액션(C3/§5.3).
 * 문제 있을 때만 렌더(diagnoses.length>0). 읽기 전용 — 액션은 act emit만(실행은 호출측).
 * ⚠️ Clarity 전역 CSS 트랩 회피: <header>/<h3> 미사용(div/strong/p만) — 메모리 console-clarity-semantic-tag-trap.
 */
@Component({
  selector: 'app-diagnose-card',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dg" *ngFor="let d of diagnoses" [class.dg-danger]="d.severity === 'danger'" [class.dg-warn]="d.severity === 'warning'">
      <div class="dg-head">
        <span class="dg-dot"></span>
        <strong class="dg-title">{{ d.title }}</strong>
      </div>
      <p class="dg-detail" *ngIf="d.detail">{{ d.detail }}</p>
      <div class="dg-actions">
        <button type="button" class="dg-btn" *ngFor="let a of d.actions" (click)="act.emit(a)">{{ a.label }}</button>
      </div>
      <div class="dg-src">근거: <span class="dg-mono">{{ d.source }}</span></div>
    </div>
  `,
  styles: [`
    .dg { border: 1px solid #e0e0e0; border-left: 4px solid #8c8c8c; border-radius: 4px; padding: 0.6rem 0.85rem; margin: 0 0 0.6rem; background: #fff; }
    .dg-danger { border-left-color: #da1e28; background: rgba(218,30,40,0.05); }
    .dg-warn { border-left-color: #f1c21b; background: rgba(241,194,27,0.07); }
    .dg-head { display: flex; align-items: center; gap: 0.5rem; }
    .dg-dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: #8c8c8c; flex: 0 0 auto; }
    .dg-danger .dg-dot { background: #da1e28; }
    .dg-warn .dg-dot { background: #f1c21b; }
    .dg-title { font-size: 0.9rem; color: #161616; font-weight: 600; }
    .dg-detail { margin: 0.35rem 0 0.5rem 1.05rem; color: #525252; font-size: 0.82rem; }
    .dg-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-left: 1.05rem; }
    .dg-btn { border: 1px solid #4c6fff; background: #fff; color: #4c6fff; border-radius: 4px; padding: 0.2rem 0.6rem; font-size: 0.78rem; cursor: pointer; }
    .dg-btn:hover { background: rgba(76,111,255,0.08); }
    .dg-src { margin: 0.5rem 0 0 1.05rem; font-size: 0.66rem; color: #8c8c8c; }
    .dg-mono { font-family: var(--os-font-mono, monospace); }
  `],
})
export class DiagnoseCardComponent {
  @Input({ required: true }) diagnoses!: Diagnosis[];
  @Output() act = new EventEmitter<DiagAction>();
}
