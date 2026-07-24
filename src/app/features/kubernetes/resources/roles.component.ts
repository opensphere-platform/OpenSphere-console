import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** Roles 목록 — 제네릭 프록시(/apis/rbac.authorization.k8s.io/v1/roles) 기반. namespaced.
 *  headlamp-inventory.json(kind=Role) listColumns 반영:
 *  type(label "Kind", resource.kind), name(kind:name, metadata.name),
 *  namespace/cluster/labels(자동·생략), age(kind:age, metadata.creationTimestamp).
 *  inventory detailSections(headlamp.role-rules: item.rules[] → API Groups/Resources/Verbs)에서
 *  RBAC Role의 핵심인 rules 배열을 목록 컬럼(Resources/Verbs, kind:tags)으로 함께 노출.
 *  get은 원시 K8s 객체(metadata/kind/rules) 직접 접근(Headlamp 헬퍼/래퍼 호출 금지, 순수 재구현). */
@Component({
  selector: 'app-res-roles',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Roles" path="/apis/rbac.authorization.k8s.io/v1/roles" [namespaced]="true" kind="Role" [columns]="cols" />`,
})
export class RoleComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'type', label: 'Kind', get: o => o.kind || 'Role' },
    { id: 'resources', label: 'Resources', kind: 'tags', get: o => [...new Set((o.rules || []).flatMap((r: any) => r.resources || []))] },
    { id: 'verbs', label: 'Verbs', kind: 'tags', get: o => [...new Set((o.rules || []).flatMap((r: any) => r.verbs || []))] },
    { id: 'rules', label: 'Rules', get: o => (o.rules || []).length },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
