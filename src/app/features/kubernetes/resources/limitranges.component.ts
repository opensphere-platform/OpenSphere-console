import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// spec.limits[].type 목록 (Container, Pod, PersistentVolumeClaim 등)
const limitTypes = (o: any): string[] =>
  (o.spec?.limits || []).map((l: any) => l?.type).filter(Boolean);

// spec.limits[0]의 특정 필드(default/defaultRequest/max/min)를 "k=v" 배지 배열로 변환
const kv = (m: any): string[] =>
  m ? Object.keys(m).map(k => `${k}=${m[k]}`) : [];

@Component({
  selector: 'app-res-limitranges',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Limit Ranges" path="/api/v1/limitranges" [namespaced]="true" kind="LimitRange" [columns]="cols" />`,
})
export class LimitRangeComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'limitTypes', label: 'Limit Types', kind: 'tags', get: o => limitTypes(o) },
    { id: 'default', label: 'Default', kind: 'tags', get: o => kv(o.spec?.limits?.[0]?.default) },
    { id: 'defaultRequest', label: 'Default Request', kind: 'tags', get: o => kv(o.spec?.limits?.[0]?.defaultRequest) },
    { id: 'max', label: 'Max', kind: 'tags', get: o => kv(o.spec?.limits?.[0]?.max) },
    { id: 'min', label: 'Min', kind: 'tags', get: o => kv(o.spec?.limits?.[0]?.min) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
