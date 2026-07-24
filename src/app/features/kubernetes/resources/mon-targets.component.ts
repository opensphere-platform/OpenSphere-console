import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/**
 * Prometheus Operator ServiceMonitor 실연동 (구 DummyTargetsComponent 대체).
 * "Targets" 더미(스크레이프 타깃 목업)를 실 CRD 쿼리로 전환 — ServiceMonitor는 Operator가
 * Prometheus 스크레이프 설정을 선언적으로 생성하는 namespaced CRD(monitoring.coreos.com/v1).
 * 이 컴포넌트는 app.component의 capability-gate(monitoring.coreos.com CRD 존재)를 통과해야
 * nav에 노출된다. 그래도 404면 ResourceListComponent가 friendly로 처리(빨간 에러 아님).
 * 읽기 전용 — create 버튼 없음.
 */
@Component({
  selector: 'app-res-mon-targets',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Service Monitors" path="/apis/monitoring.coreos.com/v1/servicemonitors" [namespaced]="true" kind="ServiceMonitor" [columns]="cols" />`,
})
export class ServiceMonitorsComponent {
  // namespace 컬럼은 [namespaced]="true"일 때 ResourceListComponent가 자동으로 그린다(여기서 중복 정의하지 않음).
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'endpoints', label: 'Endpoints', get: o => (o.spec?.endpoints?.length ?? 0) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
