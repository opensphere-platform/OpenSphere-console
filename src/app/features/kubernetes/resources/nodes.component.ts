import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

const roles = (o: any) =>
  Object.keys(o.metadata?.labels || {})
    .filter(k => k.startsWith('node-role.kubernetes.io/'))
    .map(k => k.split('/')[1])
    .filter(Boolean);
const isReady = (o: any) => !!o.status?.conditions?.find((c: any) => c.type === 'Ready' && c.status === 'True');

/** Nodes 목록 — 제네릭 프록시(/api/v1/nodes) 기반. cluster-scoped. */
@Component({
  selector: 'app-nodes',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Nodes" path="/api/v1/nodes" [namespaced]="false" kind="Node" [cordonable]="true" [columns]="cols" />`,
})
export class NodesComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'ready', label: 'Ready', kind: 'status', get: o => (isReady(o) ? 'Ready' : 'NotReady'), statusOf: o => (isReady(o) ? 'success' : 'danger') },
    { id: 'roles', label: 'Roles', kind: 'tags', get: o => roles(o), facet: true },
    { id: 'version', label: 'Version', get: o => o.status?.nodeInfo?.kubeletVersion },
    { id: 'ip', label: 'Internal IP', get: o => (o.status?.addresses || []).find((a: any) => a.type === 'InternalIP')?.address },
    { id: 'os', label: 'OS / Arch', get: o => `${o.status?.nodeInfo?.osImage || ''} · ${o.status?.nodeInfo?.architecture || ''}` },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
