import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

const firstRec = (o: any) => o.status?.recommendation?.containerRecommendations?.[0]?.target;
const provided = (o: any) =>
  o.status?.conditions?.find((c: any) => c.type === 'RecommendationProvided')?.status;

@Component({
  selector: 'app-res-vpas',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Vertical Pod Autoscalers" path="/apis/autoscaling.k8s.io/v1/verticalpodautoscalers" [namespaced]="true" kind="VerticalPodAutoscaler" [columns]="cols" />`,
})
export class VerticalPodAutoscalerComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'cpu', label: 'CPU', get: o => firstRec(o)?.cpu },
    { id: 'memory', label: 'Memory', get: o => firstRec(o)?.memory },
    {
      id: 'provided',
      label: 'Provided',
      kind: 'status',
      get: o => provided(o) ?? 'Unknown',
      statusOf: o => (provided(o) === 'True' ? 'success' : provided(o) === 'False' ? 'danger' : 'unknown'),
    },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
