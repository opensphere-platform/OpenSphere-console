import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** spec.scaleTargetRef → "Kind/name" (Headlamp referenceObject 헬퍼의 순수 재구현). */
const reference = (o: any) => {
  const r = o.spec?.scaleTargetRef;
  return r ? `${r.kind}/${r.name}` : undefined;
};

/** spec.metrics[] → 각 메트릭의 타깃 요약 배지 배열 (Headlamp metrics().shortValue 순수 재구현). */
const targets = (o: any) =>
  (o.spec?.metrics || []).map((m: any) => {
    switch (m.type) {
      case 'Resource': {
        const t = m.resource?.target;
        const v = t?.averageUtilization != null ? `${t.averageUtilization}%` : (t?.averageValue ?? t?.value);
        return `${m.resource?.name}: ${v ?? '?'}`;
      }
      case 'Pods': {
        const t = m.pods?.target;
        return `${m.pods?.metric?.name}: ${t?.averageValue ?? '?'}`;
      }
      case 'Object': {
        const t = m.object?.target;
        return `${m.object?.metric?.name}: ${t?.value ?? t?.averageValue ?? '?'}`;
      }
      case 'External': {
        const t = m.external?.target;
        return `${m.external?.metric?.name}: ${t?.value ?? t?.averageValue ?? '?'}`;
      }
      default:
        return m.type;
    }
  });

/** Horizontal Pod Autoscalers 목록 — 제네릭 프록시(/apis/autoscaling/v2/horizontalpodautoscalers) 기반. namespaced. */
@Component({
  selector: 'app-res-hpas',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Horizontal Pod Autoscalers" path="/apis/autoscaling/v2/horizontalpodautoscalers" [namespaced]="true" kind="HorizontalPodAutoscaler" [columns]="cols" />`,
})
export class HorizontalPodAutoscalerComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'reference', label: 'Reference', get: o => reference(o) },
    { id: 'targets', label: 'Targets', kind: 'tags', get: o => targets(o) },
    { id: 'minReplicas', label: 'MinReplicas', get: o => o.spec?.minReplicas },
    { id: 'maxReplicas', label: 'MaxReplicas', get: o => o.spec?.maxReplicas },
    { id: 'currentReplicas', label: 'Replicas', get: o => o.status?.currentReplicas },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
