import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/**
 * VolumeSnapshotClass 실연동 (구 DummyVolumeSnapshotClassesComponent 대체).
 * external-snapshotter(CSI) CRD — /apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses.
 * cluster-scoped, 읽기 전용(생성 버튼 없음 — phantom 금지). driver/deletionPolicy는 top-level 필드.
 * apiGroup snapshot.storage.k8s.io는 app.component capability-gate 키 — CRD 미설치 시 404를
 * ResourceListComponent가 friendly로 처리(빨간 에러 아님).
 */
@Component({
  selector: 'app-res-volumesnapshotclasses',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Volume Snapshot Classes" path="/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses" [namespaced]="false" kind="VolumeSnapshotClass" [columns]="cols" />`,
})
export class VolumeSnapshotClassesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'driver', label: 'Driver', get: o => o.driver, facet: true },
    { id: 'deletionPolicy', label: 'Deletion Policy', get: o => o.deletionPolicy },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
