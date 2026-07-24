import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** CustomResourceDefinitions 목록 — 제네릭 프록시(/apis/apiextensions.k8s.io/v1/customresourcedefinitions) 기반. cluster-scoped. */
@Component({
  selector: 'app-res-crds',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Custom Resource Definitions" path="/apis/apiextensions.k8s.io/v1/customresourcedefinitions" [namespaced]="false" kind="CustomResourceDefinition" [columns]="cols" />`,
})
export class CustomResourceDefinitionComponent {
  cols: ColumnDef[] = [
    { id: 'definition', label: 'Definition', kind: 'name', get: o => o.metadata?.name },
    { id: 'resource', label: 'Resource', get: o => o.spec?.names?.kind },
    { id: 'group', label: 'Group', get: o => o.spec?.group },
    { id: 'scope', label: 'Scope', kind: 'status', get: o => o.spec?.scope, statusOf: o => (o.spec?.scope === 'Namespaced' ? 'info' : 'success') },
    { id: 'categories', label: 'Categories', kind: 'tags', get: o => o.spec?.names?.categories || [] },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
