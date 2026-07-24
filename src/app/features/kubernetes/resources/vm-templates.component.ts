import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/**
 * OpenShift Template 실연동 (구 DummyVmTemplatesComponent 대체).
 * template.openshift.io/v1 Template — VM 템플릿(및 일반 앱 템플릿)의 정의체. 읽기 전용.
 * OpenShift 전용 CRD라 비OpenShift 클러스터엔 없음 → app.component capability-gate
 * (template.openshift.io)로 자동 숨김. 그래도 404면 ResourceListComponent가 friendly로 처리.
 */
@Component({
  selector: 'app-res-vm-templates',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Templates" path="/apis/template.openshift.io/v1/templates" [namespaced]="true" kind="Template" [columns]="cols" />`,
})
export class VmTemplatesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'displayname', label: 'Display name', get: o => o.metadata?.annotations?.['openshift.io/display-name'] || '—' },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
