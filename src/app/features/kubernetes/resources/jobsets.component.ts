import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** JobSet 상태 라벨 — status.conditions를 우선순위 [Failed > Completed > Suspended > StartupPolicyCompleted]로 판정.
 *  (Headlamp getJobSetCondition 재구현; 원시 status.conditions 직접 접근) */
const jobSetCondition = (o: any): string => {
  const conds: any[] = o.status?.conditions || [];
  const has = (t: string) => conds.find(c => c.type === t && c.status === 'True');
  if (has('Failed')) return 'Failed';
  if (has('Completed')) return 'Completed';
  if (has('Suspended')) return 'Suspended';
  if (has('StartupPolicyCompleted')) return 'StartupPolicyCompleted';
  return o.spec?.suspend ? 'Suspended' : 'Running';
};

/** 상태 → Clarity 라벨 색상 매핑. */
const jobSetConditionColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  switch (jobSetCondition(o)) {
    case 'Completed': return 'success';
    case 'Failed': return 'danger';
    case 'Suspended': return 'warning';
    case 'Running': return 'info';
    case 'StartupPolicyCompleted': return 'info';
    default: return 'unknown';
  }
};

/** Job Sets 목록 — 제네릭 프록시(/apis/jobset.x-k8s.io/v1alpha2/jobsets) 기반. namespaced. */
@Component({
  selector: 'app-res-jobsets',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Job Sets" path="/apis/jobset.x-k8s.io/v1alpha2/jobsets" [namespaced]="true" kind="JobSet" [columns]="cols" />`,
})
export class JobSetComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'conditions', label: 'Conditions', kind: 'status', get: o => jobSetCondition(o), statusOf: o => jobSetConditionColor(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
