import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** spec.ingress / spec.egress 배열 유무로 정책 방향을 도출(Ingress/Egress/Both/None). */
const policyType = (o: any): string => {
  const hasIngress = (o.spec?.ingress?.length ?? 0) > 0;
  const hasEgress = (o.spec?.egress?.length ?? 0) > 0;
  if (hasIngress && hasEgress) return 'Both';
  if (hasIngress) return 'Ingress';
  if (hasEgress) return 'Egress';
  return 'None';
};

/** spec.podSelector의 matchLabels(key=value) + matchExpressions(key op)를 배지 배열로. 비면 전체 선택. */
const podSelectorTags = (o: any): string[] => {
  const sel = o.spec?.podSelector;
  const labels = Object.entries(sel?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  const exprs = (sel?.matchExpressions ?? []).map((e: any) => `${e.key} ${e.operator}`);
  const all = [...labels, ...exprs];
  return all.length ? all : ['* (all pods)'];
};

@Component({
  selector: 'app-res-networkpolicies',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Network Policies" path="/apis/networking.k8s.io/v1/networkpolicies" [namespaced]="true" kind="NetworkPolicy" [columns]="cols" />`,
})
export class NetworkPolicyComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'type', label: 'Type', kind: 'status', get: o => policyType(o), statusOf: o => (policyType(o) === 'None' ? 'unknown' : 'info') },
    { id: 'podSelector', label: 'Pod Selector', kind: 'tags', get: o => podSelectorTags(o) },
    { id: 'policyTypes', label: 'Policy Types', kind: 'tags', get: o => o.spec?.policyTypes ?? [] },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
