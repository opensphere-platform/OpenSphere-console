import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/**
 * Prometheus Operator PrometheusRule 실연동 (구 DummyAlertsComponent 대체).
 * Observe(Alerting) 스코프 — Alertmanager가 평가하는 알림/기록 규칙(PrometheusRule)을
 * 클러스터에서 직접 읽는다. apiGroup=monitoring.coreos.com 은 app.component capability-gate 키.
 * CRD 미설치(operator 부재) 시 ResourceListComponent가 404 → friendly 안내로 처리(빨간 에러 아님).
 *
 * apiVersion 확인: Prometheus Operator의 PrometheusRule 는 안정화 이후 줄곧 monitoring.coreos.com/v1
 * (plural=prometheusrules, namespaced). v1alpha1/v1beta1 변형 없음 → path 그대로 유효.
 * status 서브리소스 없음(평가 상태는 Alertmanager/Prometheus 런타임 측) → status 컬럼 없음.
 */
@Component({
  selector: 'app-res-mon-alerts',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Alerting Rules" path="/apis/monitoring.coreos.com/v1/prometheusrules" [namespaced]="true" kind="PrometheusRule" [columns]="cols" />`,
})
export class PrometheusRulesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'groups', label: 'Groups', get: o => o.spec?.groups?.length ?? 0 },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
