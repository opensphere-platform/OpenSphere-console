import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** RuntimeClasses 목록 — 제네릭 프록시(/apis/node.k8s.io/v1/runtimeclasses) 기반. cluster-scoped. */
@Component({
  selector: 'app-res-runtimeclasses',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Runtime Classes" path="/apis/node.k8s.io/v1/runtimeclasses" [namespaced]="false" kind="RuntimeClass" [columns]="cols" />`,
})
export class RuntimeClassComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'handler', label: 'Handler', get: o => o.handler },
    { id: 'podOverhead', label: 'Pod Overhead (CPU)', get: o => o.overhead?.podFixed?.cpu },
    { id: 'nodeSelector', label: 'Node Selector', kind: 'tags', get: o => Object.entries(o.scheduling?.nodeSelector ?? {}).map(([k, v]) => `${k}=${v}`) },
    { id: 'tolerations', label: 'Tolerations', get: o => o.scheduling?.tolerations?.length ?? 0 },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
