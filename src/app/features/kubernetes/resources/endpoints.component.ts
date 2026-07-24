import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/**
 * Endpoints의 주소 목록을 원시 K8s 객체에서 직접 도출한다.
 * Headlamp의 endpoint.getAddresses()를 순수 재구현: 각 subset의 addresses[].ip 를
 * 해당 subset의 ports[].port 와 결합해 "IP:port" 배지 배열로 만든다.
 * (포트가 없으면 IP만, subsets 자체가 없으면 빈 배열)
 */
const getAddresses = (o: any): string[] => {
  const subsets: any[] = o.subsets || [];
  const out: string[] = [];
  for (const s of subsets) {
    const ips: string[] = (s.addresses || []).map((a: any) => a.ip).filter((ip: any) => !!ip);
    const ports: number[] = (s.ports || []).map((p: any) => p.port).filter((p: any) => p != null);
    if (ports.length === 0) {
      out.push(...ips);
    } else {
      for (const ip of ips) {
        for (const port of ports) out.push(`${ip}:${port}`);
      }
    }
  }
  return out;
};

@Component({
  selector: 'app-res-endpoints',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Endpoints" path="/api/v1/endpoints" [namespaced]="true" kind="Endpoints" [columns]="cols" />`,
})
export class EndpointsComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'addresses', label: 'Addresses', kind: 'tags', get: o => getAddresses(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
