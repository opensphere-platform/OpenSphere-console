import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** ConfigMap의 데이터 키 개수(data + binaryData 합산). 원시 K8s 객체 직접 접근. */
const dataCount = (o: any) =>
  Object.keys(o.data || {}).length + Object.keys(o.binaryData || {}).length;
/** ConfigMap의 데이터 키 목록(data + binaryData). 배지(tags)로 표시. */
const dataKeys = (o: any) => [
  ...Object.keys(o.data || {}),
  ...Object.keys(o.binaryData || {}),
];

/** ConfigMaps 목록 — 제네릭 프록시(/api/v1/configmaps) 기반. namespaced.
 *  headlamp-inventory.json(kind=ConfigMap) listColumns 반영:
 *  name(kind:name), namespace/cluster/labels(자동·생략), data(키 개수), age(kind:age). */
@Component({
  selector: 'app-res-configmaps',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="ConfigMaps" path="/api/v1/configmaps" [namespaced]="true" kind="ConfigMap" [columns]="cols" />`,
})
export class ConfigMapComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'data', label: 'Data', get: o => dataCount(o) },
    { id: 'keys', label: 'Keys', kind: 'tags', get: o => dataKeys(o) },
    { id: 'immutable', label: 'Immutable', get: o => (o.immutable === true ? 'Yes' : 'No') },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
