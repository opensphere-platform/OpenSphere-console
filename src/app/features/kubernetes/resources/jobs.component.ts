import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** Job 컨테이너 목록(원시 spec.template 직접 접근). */
const containers = (o: any): any[] => o.spec?.template?.spec?.containers || [];

/** 완료 진행도 — completions/parallelism (없으면 1로 보정). */
const completions = (o: any): string => {
  const c = o.spec?.completions ?? 1;
  const p = o.spec?.parallelism ?? 1;
  return `${c}/${p}`;
};

/** Job 상태 라벨 — status.conditions에서 우선순위(Failed > Complete > Suspended) 판정. */
const jobStatus = (o: any): string => {
  if (o.spec?.suspend) return 'Suspended';
  const conds: any[] = o.status?.conditions || [];
  if (conds.find(c => c.type === 'Failed' && c.status === 'True')) return 'Failed';
  if (conds.find(c => c.type === 'Complete' && c.status === 'True')) return 'Complete';
  if (conds.find(c => c.type === 'Suspended' && c.status === 'True')) return 'Suspended';
  return o.status?.active ? 'Running' : 'Pending';
};

/** 상태 → Clarity 라벨 색상 매핑. */
const jobStatusColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  switch (jobStatus(o)) {
    case 'Complete': return 'success';
    case 'Failed': return 'danger';
    case 'Suspended': return 'warning';
    case 'Running': return 'info';
    default: return 'unknown';
  }
};

/** 실행 시간 — startTime ~ (completionTime | 현재)의 상대 길이. */
const duration = (o: any): string => {
  const start = o.status?.startTime;
  if (!start) return '';
  const end = o.status?.completionTime ? new Date(o.status.completionTime).getTime() : Date.now();
  const ms = end - new Date(start).getTime();
  if (ms < 0) return '';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
};

/** Jobs 목록 — 제네릭 프록시(/apis/batch/v1/jobs) 기반. namespaced. */
@Component({
  selector: 'app-res-jobs',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Jobs" path="/apis/batch/v1/jobs" [namespaced]="true" kind="Job" [columns]="cols" />`,
})
export class JobComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'completions', label: 'Completions', get: o => completions(o) },
    { id: 'conditions', label: 'Conditions', kind: 'status', get: o => jobStatus(o), statusOf: o => jobStatusColor(o) },
    { id: 'duration', label: 'Duration', get: o => duration(o) },
    { id: 'containers', label: 'Containers', kind: 'tags', get: o => containers(o).map(c => c.name).filter(Boolean) },
    { id: 'images', label: 'Images', kind: 'tags', get: o => containers(o).map(c => c.image).filter(Boolean) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
