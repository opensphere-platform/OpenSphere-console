import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

const desired = (o: any) => o.status?.desiredNumberScheduled ?? 0;
const ready = (o: any) => o.status?.numberReady ?? 0;
const nodeSelector = (o: any) =>
  Object.entries(o.spec?.template?.spec?.nodeSelector || {}).map(([k, v]) => `${k}=${v}`);
const images = (o: any) =>
  (o.spec?.template?.spec?.containers || []).map((c: any) => c.image).filter(Boolean);

/** DaemonSets 목록 — 제네릭 프록시(/apis/apps/v1/daemonsets) 기반. namespaced. */
@Component({
  selector: 'app-res-daemonsets',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="DaemonSets" path="/apis/apps/v1/daemonsets" [namespaced]="true" kind="DaemonSet" [restartable]="true" [columns]="cols" />`,
})
export class DaemonSetComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'desired', label: 'Desired', get: o => desired(o) },
    { id: 'current', label: 'Current', get: o => o.status?.currentNumberScheduled ?? 0 },
    {
      id: 'ready', label: 'Ready', kind: 'status',
      get: o => `${ready(o)}/${desired(o)}`,
      statusOf: o => (ready(o) >= desired(o) ? 'success' : ready(o) > 0 ? 'warning' : 'danger'),
    },
    { id: 'nodeSelector', label: 'Node Selector', kind: 'tags', get: o => nodeSelector(o) },
    { id: 'images', label: 'Images', kind: 'tags', get: o => images(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
