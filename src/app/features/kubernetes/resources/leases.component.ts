import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** Leases 목록 — 제네릭 프록시(/apis/coordination.k8s.io/v1/leases) 기반. namespaced.
 *  headlamp-inventory.json(kind=Lease) listColumns 반영:
 *  name(kind:name), namespace/cluster/labels(자동·생략), holder(spec.holderIdentity), age(kind:age).
 *  inventory detailSections의 extraInfo(Holder Identity, Lease Duration Seconds, Renew Time)를
 *  핵심 목록 컬럼으로 함께 노출. get은 원시 K8s 객체(spec/metadata) 직접 접근(헬퍼/래퍼 호출 금지). */
@Component({
  selector: 'app-res-leases',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Leases" path="/apis/coordination.k8s.io/v1/leases" [namespaced]="true" kind="Lease" [columns]="cols" />`,
})
export class LeaseComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'holder', label: 'Holder', get: o => o.spec?.holderIdentity },
    { id: 'duration', label: 'Duration (s)', get: o => o.spec?.leaseDurationSeconds },
    { id: 'renewTime', label: 'Renew Time', kind: 'age', get: o => o.spec?.renewTime },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
