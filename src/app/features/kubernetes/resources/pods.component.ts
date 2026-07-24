import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// 컨테이너 상태 배열에서 ready 개수와 전체 개수를 'ready/total'로.
const readyRatio = (o: any) => {
  const cs: any[] = o.status?.containerStatuses ?? [];
  const ready = cs.filter((c: any) => c.ready).length;
  const total = cs.length || (o.spec?.containers?.length ?? 0);
  return `${ready}/${total}`;
};
// 모든 컨테이너의 restartCount 합.
const restarts = (o: any) =>
  (o.status?.containerStatuses ?? []).reduce((n: number, c: any) => n + (c.restartCount || 0), 0);
// 표시용 파드 상태: 종료/평가 reason이 있으면 우선, 없으면 phase.
const podStatus = (o: any) => o.status?.reason || o.status?.phase || 'Unknown';
// phase/조건을 색상으로 매핑.
const statusColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const phase = o.status?.phase;
  if (phase === 'Running' || phase === 'Succeeded') return 'success';
  if (phase === 'Failed') return 'danger';
  if (phase === 'Pending') return 'warning';
  return 'unknown';
};

@Component({
  selector: 'app-res-pods',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Pods" path="/api/v1/pods" [namespaced]="true" kind="Pod" [columns]="cols" />`,
})
export class PodComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'ready', label: 'Ready', get: o => readyRatio(o) },
    { id: 'status', label: 'Status', kind: 'status', get: o => podStatus(o), statusOf: o => statusColor(o) },
    { id: 'restarts', label: 'Restarts', get: o => restarts(o) },
    { id: 'ip', label: 'IP', get: o => o.status?.podIP },
    { id: 'node', label: 'Node', get: o => o.spec?.nodeName, facet: true },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
