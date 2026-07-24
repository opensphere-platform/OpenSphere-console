import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** subjects[] → "Kind:name"(ServiceAccount는 ns 포함) 배지 배열. */
const subjects = (o: any): string[] =>
  (o.subjects || []).map((s: any) =>
    s.kind === 'ServiceAccount' && s.namespace ? `${s.kind}:${s.namespace}/${s.name}` : `${s.kind}:${s.name}`);

/** ClusterRoleBindings 목록 — /apis/rbac.authorization.k8s.io/v1/clusterrolebindings. cluster-scoped. */
@Component({
  selector: 'app-res-clusterrolebindings',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Cluster Role Bindings" path="/apis/rbac.authorization.k8s.io/v1/clusterrolebindings" [namespaced]="false" kind="ClusterRoleBinding" [columns]="cols" />`,
})
export class ClusterRoleBindingComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'role', label: 'Role', get: o => `${o.roleRef?.kind || ''}/${o.roleRef?.name || ''}`, facet: true },
    { id: 'subjects', label: 'Subjects', kind: 'tags', get: o => subjects(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
