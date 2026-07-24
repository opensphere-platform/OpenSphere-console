import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

const containers = (o: any) => (o.spec?.template?.spec?.containers || []).map((c: any) => c.name).filter(Boolean);
const images = (o: any) => (o.spec?.template?.spec?.containers || []).map((c: any) => c.image).filter(Boolean);

/** ReplicaSets 목록 — 제네릭 프록시(/apis/apps/v1/replicasets) 기반. namespaced. */
@Component({
  selector: 'app-res-replicasets',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="ReplicaSets" path="/apis/apps/v1/replicasets" [namespaced]="true" kind="ReplicaSet" [scalable]="true" [columns]="cols" />`,
})
export class ReplicaSetComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'currentReplicas', label: 'Current', get: o => o.status?.replicas ?? 0 },
    { id: 'desiredReplicas', label: 'Desired', get: o => o.spec?.replicas ?? 0 },
    { id: 'readyReplicas', label: 'Ready', get: o => o.status?.readyReplicas ?? 0 },
    { id: 'containers', label: 'Containers', kind: 'tags', get: o => containers(o) },
    { id: 'images', label: 'Images', kind: 'tags', get: o => images(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
