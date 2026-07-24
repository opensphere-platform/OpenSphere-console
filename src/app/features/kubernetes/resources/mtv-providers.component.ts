import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// Forklift/MTV Provider의 status.conditions에서 type=Ready 조건을 찾는다.
const readyCond = (o: any) => o.status?.conditions?.find((c: any) => c.type === 'Ready');
const isReady = (o: any) => readyCond(o)?.status === 'True';

/**
 * Forklift / Migration Toolkit for Virtualization (MTV) Provider 실연동
 * (구 더미 Providers 페이지 대체).
 * apiGroup `forklift.konveyor.io`, 현행 stored 버전 v1beta1, plural `providers`, kind `Provider`.
 * 이 컴포넌트는 app.component의 capability-gate(forklift.konveyor.io CRD 존재)를 통과해야 nav에 노출된다.
 * 그래도 404면 ResourceListComponent가 friendly(빨간 에러 아님)로 처리한다.
 * 읽기 전용 — create 버튼 없음.
 */
@Component({
  selector: 'app-res-mtv-providers',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Providers" path="/apis/forklift.konveyor.io/v1beta1/providers" [namespaced]="true" kind="Provider" [columns]="cols" />`,
})
export class MtvProvidersComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'type', label: 'Type', get: o => o.spec?.type || '—', facet: true },
    { id: 'url', label: 'URL', get: o => o.spec?.url || '—' },
    { id: 'ready', label: 'Ready', kind: 'status', get: o => (isReady(o) ? 'Ready' : 'NotReady'), statusOf: o => (isReady(o) ? 'success' : 'danger') },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
