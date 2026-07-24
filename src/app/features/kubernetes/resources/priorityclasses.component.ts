import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** PriorityClasses 목록 — 제네릭 프록시(/apis/scheduling.k8s.io/v1/priorityclasses) 기반. cluster-scoped. */
@Component({
  selector: 'app-res-priorityclasses',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Priority Classes" path="/apis/scheduling.k8s.io/v1/priorityclasses" [namespaced]="false" kind="PriorityClass" [columns]="cols" />`,
})
export class PriorityClassComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'value', label: 'Value', get: o => o.value },
    { id: 'globalDefault', label: 'Global Default', kind: 'status', get: o => (o.globalDefault ? 'True' : 'False'), statusOf: o => (o.globalDefault ? 'success' : 'unknown') },
    { id: 'preemptionPolicy', label: 'Preemption Policy', get: o => o.preemptionPolicy },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
