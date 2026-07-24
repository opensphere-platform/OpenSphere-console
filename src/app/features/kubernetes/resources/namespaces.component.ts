import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

@Component({
  selector: 'app-res-namespaces', standalone: true, imports: [ResourceListComponent],
  template: `<app-resource-list title="Namespaces" path="/api/v1/namespaces" [namespaced]="false" kind="Namespace" [columns]="cols" />`,
})
export class NamespaceComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'status', label: 'Status', kind: 'status', get: o => o.status?.phase || 'Unknown', statusOf: o => (o.status?.phase === 'Active' ? 'success' : 'danger') },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
