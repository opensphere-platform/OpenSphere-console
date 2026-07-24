import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** 기본 StorageClass 여부(어노테이션 storageclass.kubernetes.io/is-default-class). */
const isDefault = (o: any) => o.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';

/** StorageClasses 목록 — /apis/storage.k8s.io/v1/storageclasses. cluster-scoped. */
@Component({
  selector: 'app-res-storageclasses',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Storage Classes" path="/apis/storage.k8s.io/v1/storageclasses" [namespaced]="false" kind="StorageClass" [columns]="cols" />`,
})
export class StorageClassComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'provisioner', label: 'Provisioner', get: o => o.provisioner, facet: true },
    { id: 'reclaim', label: 'Reclaim Policy', get: o => o.reclaimPolicy },
    { id: 'binding', label: 'Volume Binding Mode', get: o => o.volumeBindingMode },
    { id: 'expansion', label: 'Allow Expansion', get: o => (o.allowVolumeExpansion === true ? 'Yes' : 'No') },
    { id: 'default', label: 'Default', kind: 'status', get: o => (isDefault(o) ? 'Yes' : 'No'), statusOf: o => (isDefault(o) ? 'success' : 'unknown') },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
