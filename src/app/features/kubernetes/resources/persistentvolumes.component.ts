import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

const phaseColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  switch (o.status?.phase) {
    case 'Bound': return 'success';
    case 'Available': return 'info';
    case 'Released': return 'warning';
    case 'Failed': return 'danger';
    default: return 'unknown';
  }
};
/** spec.claimRef → "ns/name" (바인딩된 PVC). */
const claim = (o: any) => (o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : '');

/** PersistentVolumes 목록 — /api/v1/persistentvolumes. cluster-scoped. */
@Component({
  selector: 'app-res-pvs',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Persistent Volumes" path="/api/v1/persistentvolumes" [namespaced]="false" kind="PersistentVolume" [columns]="cols" />`,
})
export class PersistentVolumeComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status?.phase || 'Unknown', statusOf: o => phaseColor(o) },
    { id: 'capacity', label: 'Capacity', get: o => o.spec?.capacity?.storage },
    { id: 'accessModes', label: 'Access Modes', kind: 'tags', get: o => o.spec?.accessModes ?? [] },
    { id: 'reclaim', label: 'Reclaim Policy', get: o => o.spec?.persistentVolumeReclaimPolicy },
    { id: 'storageClass', label: 'Storage Class', get: o => o.spec?.storageClassName, facet: true },
    { id: 'claim', label: 'Claim', get: o => claim(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
