import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { OsPageHeader } from '../os/os-page-header';
import { OsDatagrid, OsColumn } from '../os/os-datagrid';
import { OsBreadcrumb, Crumb } from '../os/os-breadcrumb';

/**
 * ContainersPage — Containers 하위 항목 공통 더미 페이지.
 * 라우트 data({ title, group })를 구독해 제목·breadcrumb 표시(같은 컴포넌트가 형제 라우트에 재사용되므로 구독).
 * 단일 데이터그리드(OsDatagrid) 빈 상태로 리소스 목록 페이지 형태를 일관되게 표현.
 */
@Component({
  selector: 'os-containers-page',
  imports: [OsPageHeader, OsDatagrid, OsBreadcrumb],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-breadcrumb [items]="crumbs()" />
      <os-page-header [title]="title()" [tag]="group()">
        <p>{{ title() }} — 더미 페이지(2단 내비·라우팅·active 표시 검증용).</p>
      </os-page-header>
      <os-datagrid [columns]="cols" [rows]="[]" empty="항목 없음 — 더미 페이지"></os-datagrid>
    </div>
  `,
})
export class ContainersPage {
  private route = inject(ActivatedRoute);
  readonly title = signal('Containers');
  readonly group = signal('');
  readonly cols: OsColumn[] = [
    { key: 'name', label: '이름' },
    { key: 'status', label: '상태' },
    { key: 'created', label: '생성' },
  ];

  /** 페이지 경로(ACC식): OpenSphere / Containers / [그룹] / 현재. */
  readonly crumbs = computed<Crumb[]>(() => {
    const c: Crumb[] = [
      { label: 'OpenSphere', route: '/' },
      { label: 'Containers', route: '/containers/overview' },
    ];
    if (this.group()) c.push({ label: this.group() });
    c.push({ label: this.title() });
    return c;
  });

  constructor() {
    this.route.data.subscribe((d) => {
      this.title.set((d['title'] as string) ?? 'Containers');
      this.group.set((d['group'] as string) ?? '');
    });
  }
}
