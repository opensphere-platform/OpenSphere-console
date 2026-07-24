import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// CSI external-snapshotter VolumeSnapshot의 status.readyToUse(boolean) → 상태 색상.
// true=사용 가능(success), false=아직 준비 중(info), 미정의=상태 불명(unknown).
const readyColor = (o: any): 'success' | 'danger' | 'warning' | 'info' | 'unknown' => {
  const r = o.status?.readyToUse;
  if (r === true) return 'success';
  if (r === false) return 'info';
  if (o.status?.error) return 'danger';
  return 'unknown';
};

/**
 * CSI VolumeSnapshot 실연동 (구 DummyVolumeSnapshotsComponent 대체).
 * snapshot.storage.k8s.io/v1 — external-snapshotter CRD가 GA(v1)로 졸업한 현행 apiVersion.
 * apiGroup=snapshot.storage.k8s.io 는 app.component capability-gate 키이므로 그룹은 고정.
 * CRD 미설치 클러스터에서는 404 → ResourceListComponent가 friendly(info) 처리.
 * 읽기 전용 — createLabel/dummy/staticRows 없음.
 */
@Component({
  selector: 'app-res-volumesnapshots',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Volume Snapshots" path="/apis/snapshot.storage.k8s.io/v1/volumesnapshots" [namespaced]="true" kind="VolumeSnapshot" [columns]="cols" />`,
})
export class VolumeSnapshotsComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'ready', label: 'Ready To Use', kind: 'status', get: o => (o.status?.readyToUse === true ? 'True' : o.status?.readyToUse === false ? 'False' : 'Unknown'), statusOf: o => readyColor(o) },
    { id: 'sourcePvc', label: 'Source PVC', get: o => o.spec?.source?.persistentVolumeClaimName, facet: true },
    { id: 'restoreSize', label: 'Restore Size', get: o => o.status?.restoreSize },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
