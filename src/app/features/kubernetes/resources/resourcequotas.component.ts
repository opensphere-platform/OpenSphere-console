import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// spec.hard에서 키를 골라 'key: value' 목록 문자열로 합친다(순수 재구현, Headlamp 헬퍼 미사용).
const pickHard = (o: any, match: (k: string) => boolean): string => {
  const hard = o.spec?.hard || {};
  const parts = Object.keys(hard)
    .filter(match)
    .map(k => `${k}: ${hard[k]}`);
  return parts.length ? parts.join(', ') : '';
};
// Request: cpu, memory, requests.* 키
const isRequest = (k: string) => k === 'cpu' || k === 'memory' || k.startsWith('requests.');
// Limit: limits.* 키
const isLimit = (k: string) => k.startsWith('limits.');

@Component({
  selector: 'app-res-resourcequotas',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Resource Quotas" path="/api/v1/resourcequotas" [namespaced]="true" kind="ResourceQuota" [columns]="cols" />`,
})
export class ResourceQuotaComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'requests', label: 'Request', get: o => pickHard(o, isRequest) },
    { id: 'limits', label: 'Limit', get: o => pickHard(o, isLimit) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
