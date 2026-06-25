import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { ClarityModule } from '@clr/angular';

export interface OsColumn {
  key: string;
  label: string;
}

/**
 * os-datagrid — Clarity datagrid 퍼사드.
 * 화면은 이 컴포넌트만 보고, @clr/* 직접 import는 금지(ADR-UI-001 원칙①).
 * 실증: ng-clarity 18에서 clrDgSingleSelected 입력이 제거됐지만(→ click 방식으로 내부 교체)
 * 화면 코드는 한 줄도 바뀌지 않았다 — 이것이 포크 보험의 절연층이다.
 */
@Component({
  selector: 'os-datagrid',
  imports: [ClarityModule],
  template: `
    <clr-datagrid>
      @for (c of columns; track c.key) {
        <clr-dg-column>{{ c.label }}</clr-dg-column>
      }
      @for (row of rows; track $index) {
        <clr-dg-row (click)="rowClick.emit(row)" [class.os-row-active]="row === selected">
          @for (c of columns; track c.key) {
            <clr-dg-cell>{{ cell(row, c.key) }}</clr-dg-cell>
          }
        </clr-dg-row>
      }
      <clr-dg-footer>{{ rows.length }} 건</clr-dg-footer>
    </clr-datagrid>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      clr-dg-row {
        cursor: pointer;
      }
      clr-dg-row:hover {
        background: rgba(76, 111, 255, 0.06);
      }
      .os-row-active {
        background: rgba(76, 111, 255, 0.12);
        box-shadow: inset 3px 0 0 var(--os-brand-500);
      }
    `,
  ],
})
export class OsDatagrid {
  @Input() columns: OsColumn[] = [];
  @Input() rows: any[] = [];
  @Input() selected: any = null;
  @Output() rowClick = new EventEmitter<any>();

  cell(row: any, path: string): string {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
    return v == null ? '—' : String(v);
  }
}
