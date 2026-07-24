import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** 기본 IngressClass 여부(어노테이션 ingressclass.kubernetes.io/is-default-class). */
const isDefault = (o: any) => o.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true';

/** IngressClasses 목록 — /apis/networking.k8s.io/v1/ingressclasses. cluster-scoped. */
@Component({
  selector: 'app-res-ingressclasses',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Ingress Classes" path="/apis/networking.k8s.io/v1/ingressclasses" [namespaced]="false" kind="IngressClass" [columns]="cols" />`,
})
export class IngressClassComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'controller', label: 'Controller', get: o => o.spec?.controller, facet: true },
    { id: 'default', label: 'Default', kind: 'status', get: o => (isDefault(o) ? 'Yes' : 'No'), statusOf: o => (isDefault(o) ? 'success' : 'unknown') },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
