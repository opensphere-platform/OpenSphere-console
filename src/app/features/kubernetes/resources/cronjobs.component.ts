import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** CronJob의 컨테이너 배열(spec.jobTemplate.spec.template.spec.containers)에서 필드 추출 */
const containers = (o: any): any[] => o.spec?.jobTemplate?.spec?.template?.spec?.containers ?? [];

@Component({
  selector: 'app-res-cronjobs',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="CronJobs" path="/apis/batch/v1/cronjobs" [namespaced]="true" kind="CronJob" [columns]="cols" />`,
})
export class CronJobComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'schedule', label: 'Schedule', get: o => o.spec?.schedule },
    {
      id: 'suspend', label: 'Suspend', kind: 'status',
      get: o => (o.spec?.suspend ? 'Suspended' : 'Active'),
      statusOf: o => (o.spec?.suspend ? 'warning' : 'success'),
    },
    { id: 'active', label: 'Active', get: o => o.status?.active?.length ?? 0 },
    { id: 'lastScheduleTime', label: 'Last Schedule', kind: 'age', get: o => o.status?.lastScheduleTime },
    { id: 'containers', label: 'Containers', kind: 'tags', get: o => containers(o).map((c: any) => c.name) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
