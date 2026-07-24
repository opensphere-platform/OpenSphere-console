import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// KubeVirt MigrationPolicy의 불리언 정책 플래그 → 상태 색상/라벨.
// 미지정(undefined)은 KubeVirt 기본값(false)으로 취급 → 'Disabled'(info).
const flagLabel = (v: unknown): string => (v === true ? 'Enabled' : 'Disabled');
const flagColor = (v: unknown): 'success' | 'info' => (v === true ? 'success' : 'info');

/**
 * KubeVirt MigrationPolicy 실연동 (구 DummyVmMigrationPoliciesComponent 대체).
 * migrations.kubevirt.io/v1alpha1 · cluster-scoped(namespaced=false) CRD.
 * spec.allowAutoConverge / spec.allowPostCopy 는 라이브 마이그레이션 정책 플래그(불리언).
 * 이 컴포넌트는 app.component의 capability-gate(migrations.kubevirt.io CRD 존재)를 통과해야 nav에 노출된다.
 * 그래도 404면 ResourceListComponent가 friendly로 처리(빨간 에러 아님).
 * 읽기 전용 — createLabel 없음(생성 버튼 미노출).
 */
@Component({
  selector: 'app-res-vm-migrationpolicies',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Migration Policies" path="/apis/migrations.kubevirt.io/v1alpha1/migrationpolicies" [namespaced]="false" kind="MigrationPolicy" [columns]="cols" />`,
})
export class VmMigrationPoliciesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'autoconverge', label: 'Allow Auto Converge', kind: 'status', get: o => flagLabel(o.spec?.allowAutoConverge), statusOf: o => flagColor(o.spec?.allowAutoConverge) },
    { id: 'postcopy', label: 'Allow Post Copy', kind: 'status', get: o => flagLabel(o.spec?.allowPostCopy), statusOf: o => flagColor(o.spec?.allowPostCopy) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
