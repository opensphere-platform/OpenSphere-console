import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/**
 * Forklift/MTV(Migration Toolkit for Virtualization) Plan의 status.conditions[] → 상태 라벨/색.
 * Plan에는 단일 phase 문자열이 없으므로, status:True 인 카테고리 컨디션(Succeeded/Failed/...)에서
 * 표시 상태를 도출한다(없으면 Pending). OKD MTV 콘솔 상태 컬럼과 동등.
 */
const TRUE = (c: any): boolean => c?.status === 'True';
const planCond = (o: any): string => {
  const cs: any[] = o?.status?.conditions || [];
  const has = (t: string) => cs.some(c => c.type === t && TRUE(c));
  if (has('Failed')) return 'Failed';
  if (has('Canceled')) return 'Canceled';
  if (has('Succeeded')) return 'Succeeded';
  if (has('Executing')) return 'Executing';
  if (has('Running')) return 'Running';
  if (has('Ready')) return 'Ready';
  return 'Pending';
};
const planStatusColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const s = planCond(o);
  if (s === 'Succeeded' || s === 'Ready') return 'success';
  if (s === 'Executing' || s === 'Running') return 'info';
  if (s === 'Failed') return 'danger';
  if (s === 'Canceled') return 'warning';
  return 'unknown';
};

/**
 * Forklift/MTV Plan 실연동 (구 DummyMtvPlansComponent 대체).
 * 읽기 전용 — 생성 버튼 없음(createLabel 미지정). app.component의 capability-gate(forklift.konveyor.io CRD)
 * 통과 시 nav에 노출되며, 404면 ResourceListComponent가 friendly로 처리(빨간 에러 아님).
 */
@Component({
  selector: 'app-res-mtv-plans',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Plans" path="/apis/forklift.konveyor.io/v1beta1/plans" [namespaced]="true" kind="Plan" [columns]="cols" />`,
})
export class MtvPlansComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => planCond(o), statusOf: o => planStatusColor(o) },
    { id: 'source', label: 'Source', get: o => o.spec?.provider?.source?.name || '—', facet: true },
    { id: 'target', label: 'Target', get: o => o.spec?.provider?.destination?.name || '—', facet: true },
    { id: 'vms', label: 'VMs', get: o => (Array.isArray(o.spec?.vms) ? o.spec.vms.length : 0) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
