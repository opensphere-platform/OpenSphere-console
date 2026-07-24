import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/**
 * KubeVirt VirtualMachineClusterInstancetype 실연동 (구 DummyInstanceTypesComponent 대체).
 * Kubernetes 관리 관점 안에서 capability-gate로 노출되는 KubeVirt 리소스.
 * InstanceType은 VM의 컴퓨트(CPU/메모리) 사전정의 — cluster-scoped 변형(*ClusterInstancetype)이라
 * namespaced=false. namespaced 변형(VirtualMachineInstancetype)은 별 리소스로 둔다.
 * 읽기 전용 — 생성 위저드 없음(createLabel 미지정). app.component capability-gate
 * (instancetype.kubevirt.io CRD 존재)를 통과해야 nav에 노출. 404면 ResourceList가 friendly 처리.
 * API: instancetype.kubevirt.io/v1beta1 가 현행 stable(구 v1alpha1/v1alpha2는 deprecated).
 */
@Component({
  selector: 'app-res-vm-instancetypes',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Instance Types" path="/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterinstancetypes" [namespaced]="false" kind="VirtualMachineClusterInstancetype" [columns]="cols" />`,
})
export class VmInstanceTypesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'vcpu', label: 'vCPU', get: o => o.spec?.cpu?.guest ?? '—' },
    { id: 'memory', label: 'Memory', get: o => o.spec?.memory?.guest ?? '—' },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
