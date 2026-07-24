import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// CDI DataSource status.conditions에서 type=Ready의 status('True'/'False'/'Unknown') 추출.
const readyOf = (o: any): string => {
  const c = (o.status?.conditions || []).find((x: any) => x?.type === 'Ready');
  return c?.status || 'Unknown';
};

// Ready 상태 → 색상 매핑.
const readyColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const v = readyOf(o);
  if (v === 'True') return 'success';
  if (v === 'False') return 'danger';
  return 'unknown';
};

/**
 * CDI(Containerized Data Importer) DataSource 실연동 — 부팅 가능 볼륨(Bootable Volumes).
 * 구 DummyBootableVolumesComponent 대체. 읽기 전용(생성 버튼 없음).
 * OKD-perspective-binding §7.1: Virtualization 뷰 스코프의 한 리소스.
 * app.component의 capability-gate(cdi.kubevirt.io CRD 존재)를 통과해야 nav에 노출된다.
 * 그래도 404면 ResourceListComponent가 friendly(info)로 처리(빨간 에러 아님).
 */
@Component({
  selector: 'app-res-vm-bootablevolumes',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Bootable Volumes" path="/apis/cdi.kubevirt.io/v1beta1/datasources" [namespaced]="true" kind="DataSource" [columns]="cols" />`,
})
export class VmBootableVolumesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'source', label: 'Source', get: o => o.spec?.source?.pvc?.name || '—' },
    { id: 'ready', label: 'Ready', kind: 'status', get: o => readyOf(o), statusOf: o => readyColor(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
