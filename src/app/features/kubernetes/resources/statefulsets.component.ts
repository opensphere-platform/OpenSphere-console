import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

const replicas = (o: any) => o.spec?.replicas ?? 0;
const ready = (o: any) => o.status?.readyReplicas ?? 0;
const containers = (o: any) =>
  (o.spec?.template?.spec?.containers || []).map((c: any) => c.name).filter(Boolean);
const images = (o: any) =>
  (o.spec?.template?.spec?.containers || []).map((c: any) => c.image).filter(Boolean);

/** StatefulSets 목록 — 제네릭 프록시(/apis/apps/v1/statefulsets) 기반. namespaced. */
@Component({
  selector: 'app-res-statefulsets',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="StatefulSets" path="/apis/apps/v1/statefulsets" [namespaced]="true" kind="StatefulSet" [scalable]="true" [restartable]="true" [columns]="cols" />`,
})
export class StatefulSetComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    {
      id: 'pods', label: 'Pods', kind: 'status',
      get: o => `${ready(o)}/${replicas(o)}`,
      statusOf: o => (ready(o) >= replicas(o) ? 'success' : ready(o) > 0 ? 'warning' : 'danger'),
    },
    { id: 'replicas', label: 'Replicas', get: o => replicas(o) },
    { id: 'containers', label: 'Containers', kind: 'tags', get: o => containers(o) },
    { id: 'images', label: 'Images', kind: 'tags', get: o => images(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
