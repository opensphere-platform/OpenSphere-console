import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

@Component({
  selector: 'app-res-serviceaccounts', standalone: true, imports: [ResourceListComponent],
  template: `<app-resource-list title="Service Accounts" path="/api/v1/serviceaccounts" [namespaced]="true" kind="ServiceAccount" [columns]="cols" />`,
})
export class ServiceAccountComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'secrets', label: 'Secrets', get: o => (o.secrets?.length ?? 0) },
    { id: 'imagePullSecrets', label: 'Image Pull Secrets', kind: 'tags', get: o => (o.imagePullSecrets || []).map((s: any) => s.name) },
    { id: 'automount', label: 'Automount Token', get: o => (o.automountServiceAccountToken == null ? '—' : String(o.automountServiceAccountToken)) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
