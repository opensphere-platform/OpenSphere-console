import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** ClusterRoles 목록 — /apis/rbac.authorization.k8s.io/v1/clusterroles. cluster-scoped. */
@Component({
  selector: 'app-res-clusterroles',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Cluster Roles" path="/apis/rbac.authorization.k8s.io/v1/clusterroles" [namespaced]="false" kind="ClusterRole" [columns]="cols" />`,
})
export class ClusterRoleComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'resources', label: 'Resources', kind: 'tags', get: o => [...new Set((o.rules || []).flatMap((r: any) => r.resources || []))] },
    { id: 'verbs', label: 'Verbs', kind: 'tags', get: o => [...new Set((o.rules || []).flatMap((r: any) => r.verbs || []))] },
    { id: 'rules', label: 'Rules', get: o => (o.rules || []).length },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
