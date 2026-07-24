import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

// EndpointSlice는 endpoints/ports/addressType를 객체 최상위에 둔다(discovery.k8s.io/v1).
const addresses = (o: any): string[] =>
  (o.endpoints || []).flatMap((e: any) => e.addresses || []);
const ports = (o: any): string[] =>
  (o.ports || []).map((p: any) => String(p.port)).filter((v: string) => v && v !== 'undefined');

@Component({
  selector: 'app-res-endpointslices',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Endpoint Slices" path="/apis/discovery.k8s.io/v1/endpointslices" [namespaced]="true" kind="EndpointSlice" [columns]="cols" />`,
})
export class EndpointSliceComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'addressType', label: 'Address Type', get: o => o.addressType },
    { id: 'endpoints', label: 'Endpoints', kind: 'tags', get: o => addresses(o) },
    { id: 'ports', label: 'Ports', kind: 'tags', get: o => ports(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
