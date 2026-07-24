import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

const phaseColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  switch (o.status?.phase) {
    case 'Bound': return 'success';
    case 'Pending': return 'warning';
    case 'Lost': return 'danger';
    default: return 'unknown';
  }
};

/** PersistentVolumeClaims 목록 — /api/v1/persistentvolumeclaims. namespaced. */
@Component({
  selector: 'app-res-pvcs',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Persistent Volume Claims" path="/api/v1/persistentvolumeclaims" [namespaced]="true" kind="PersistentVolumeClaim" [columns]="cols" />`,
})
export class PersistentVolumeClaimComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status?.phase || 'Unknown', statusOf: o => phaseColor(o) },
    { id: 'volume', label: 'Volume', get: o => o.spec?.volumeName },
    { id: 'capacity', label: 'Capacity', get: o => o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage },
    { id: 'accessModes', label: 'Access Modes', kind: 'tags', get: o => o.spec?.accessModes ?? [] },
    { id: 'storageClass', label: 'Storage Class', get: o => o.spec?.storageClassName, facet: true },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
