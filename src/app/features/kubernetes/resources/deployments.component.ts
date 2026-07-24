import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

const containers = (o: any) => (o.spec?.template?.spec?.containers || []).map((c: any) => c.name).filter(Boolean);
const images = (o: any) => (o.spec?.template?.spec?.containers || []).map((c: any) => c.image).filter(Boolean);
const pods = (o: any) => `${o.status?.availableReplicas ?? 0} / ${o.spec?.replicas ?? 0}`;
// status.conditions 중 Available 조건으로 가용성 요약(StatusLabel 대체).
const availableCond = (o: any) => o.status?.conditions?.find((c: any) => c.type === 'Available');
const isAvailable = (o: any) => availableCond(o)?.status === 'True';

/** Deployments 목록 — 제네릭 프록시(/apis/apps/v1/deployments) 기반. namespaced. */
@Component({
  selector: 'app-res-deployments',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Deployments" path="/apis/apps/v1/deployments" [namespaced]="true" kind="Deployment" [scalable]="true" [restartable]="true" [columns]="cols" />`,
})
export class DeploymentComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'pods', label: 'Pods', get: o => pods(o) },
    { id: 'replicas', label: 'Replicas', get: o => o.spec?.replicas ?? 0 },
    { id: 'conditions', label: 'Available', kind: 'status', get: o => (isAvailable(o) ? 'Available' : 'Unavailable'), statusOf: o => (isAvailable(o) ? 'success' : 'warning') },
    { id: 'containers', label: 'Containers', kind: 'tags', get: o => containers(o) },
    { id: 'images', label: 'Images', kind: 'tags', get: o => images(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
