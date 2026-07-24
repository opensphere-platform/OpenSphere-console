import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** PDB 건강 상태 — status.currentHealthy >= status.desiredHealthy 이면 충족(success). */
const isHealthy = (o: any): boolean =>
  o.status?.desiredHealthy != null && (o.status?.currentHealthy ?? 0) >= o.status.desiredHealthy;

@Component({
  selector: 'app-res-pdbs',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Pod Disruption Budgets" path="/apis/policy/v1/poddisruptionbudgets" [namespaced]="true" kind="PodDisruptionBudget" [columns]="cols" />`,
})
export class PodDisruptionBudgetComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'minAvailable', label: 'Min Available', get: o => o.spec?.minAvailable },
    { id: 'maxUnavailable', label: 'Max Unavailable', get: o => o.spec?.maxUnavailable },
    { id: 'allowedDisruptions', label: 'Allowed Disruptions', get: o => o.status?.disruptionsAllowed },
    {
      id: 'health', label: 'Health', kind: 'status',
      get: o => `${o.status?.currentHealthy ?? 0}/${o.status?.desiredHealthy ?? 0}`,
      statusOf: o => (isHealthy(o) ? 'success' : 'warning'),
    },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
