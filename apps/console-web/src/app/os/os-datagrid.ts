import {
  Component,
  ContentChildren,
  Directive,
  EventEmitter,
  Input,
  Output,
  QueryList,
  TemplateRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ClarityModule } from '@clr/angular';

export interface OsColumn {
  key: string;
  label: string;
}

/**
 * os-cell — 컬럼별 커스텀 셀 렌더 정의(리치/인터랙티브 셀).
 * 사용: <ng-template osCell="status" let-row>…</ng-template> (컨텍스트 $implicit=row, row=row).
 * 이게 있어야 칩·버튼·입력 같은 셀도 os-datagrid 하나로 표현 가능(콘솔 전 그리드 단일화).
 */
@Directive({ selector: '[osCell]' })
export class OsCellDef {
  @Input('osCell') key = '';
  constructor(public tpl: TemplateRef<unknown>) {}
}

/**
 * os-datagrid — Clarity datagrid 퍼사드(콘솔 단일 데이터그리드).
 * 화면은 이 컴포넌트만 보고 @clr/* 직접 import 금지(ADR-UI-001 원칙①).
 * 플레인 셀은 columns/rows만으로, 리치 셀은 <ng-template osCell="key">로 렌더 → 모든 페이지 동일 그리드.
 */
@Component({
  selector: 'os-datagrid',
  imports: [ClarityModule, NgTemplateOutlet],
  template: `
    <clr-datagrid [clrDgLoading]="loading">
      @for (c of columns; track c.key) {
        <clr-dg-column>{{ c.label }}</clr-dg-column>
      }
      @for (row of rows; track $index) {
        <clr-dg-row (click)="rowClick.emit(row)" [class.os-row-active]="row === selected">
          @for (c of columns; track c.key) {
            <clr-dg-cell>
              @if (tplFor(c.key); as tpl) {
                <ng-container *ngTemplateOutlet="tpl; context: { $implicit: row, row: row }" />
              } @else {
                {{ cell(row, c.key) }}
              }
            </clr-dg-cell>
          }
        </clr-dg-row>
      } @empty {
        <clr-dg-placeholder>{{ empty }}</clr-dg-placeholder>
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
        background: var(--os-surface-1);
      }
      .os-row-active {
        background: var(--os-accent-subtle);
        box-shadow: inset 3px 0 0 var(--os-accent);
      }
    `,
  ],
})
export class OsDatagrid {
  @Input() columns: OsColumn[] = [];
  @Input() rows: any[] = [];
  @Input() selected: any = null;
  @Input() empty = '항목 없음';
  @Input() loading = false;
  @Output() rowClick = new EventEmitter<any>();
  @ContentChildren(OsCellDef) cellDefs!: QueryList<OsCellDef>;

  tplFor(key: string): TemplateRef<unknown> | null {
    return this.cellDefs?.find((d) => d.key === key)?.tpl ?? null;
  }

  cell(row: any, path: string): string {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
    return v == null ? '—' : String(v);
  }
}
