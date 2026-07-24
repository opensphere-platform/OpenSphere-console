import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/**
 * Service의 External IP를 원시 K8s 객체에서 직접 도출한다.
 * Headlamp의 service.getExternalAddresses()를 순수 재구현:
 *  - LoadBalancer: status.loadBalancer.ingress[].ip 또는 .hostname
 *  - spec.externalIPs[] (모든 타입에서 직접 지정 가능)
 *  - ExternalName: spec.externalName 으로 대체
 * 아무 것도 없으면 빈 배열.
 */
const getExternalAddresses = (o: any): string[] => {
  const out: string[] = [];
  const ingress: any[] = o.status?.loadBalancer?.ingress || [];
  for (const ing of ingress) {
    const addr = ing.ip || ing.hostname;
    if (addr) out.push(addr);
  }
  for (const ip of (o.spec?.externalIPs || [])) {
    if (ip) out.push(ip);
  }
  if (o.spec?.type === 'ExternalName' && o.spec?.externalName) {
    out.push(o.spec.externalName);
  }
  return out;
};

/**
 * Service의 포트 목록을 원시 K8s 객체에서 직접 도출한다.
 * Headlamp의 service.getFormattedPorts()를 순수 재구현:
 *  spec.ports[] 각 항목을 "port:targetPort/protocol" (NodePort면 ":nodePort" 부가)로 포맷.
 *  targetPort가 없으면 port와 동일 취급, protocol 기본값 TCP.
 */
const getFormattedPorts = (o: any): string[] => {
  const ports: any[] = o.spec?.ports || [];
  return ports.map((p: any) => {
    const proto = p.protocol || 'TCP';
    const target = p.targetPort != null ? p.targetPort : p.port;
    let label = `${p.port}:${target}/${proto}`;
    if (p.nodePort != null) label += ` (NodePort ${p.nodePort})`;
    return label;
  });
};

@Component({
  selector: 'app-res-services',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Services" path="/api/v1/services" [namespaced]="true" kind="Service" [columns]="cols" />`,
})
export class ServiceComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'type', label: 'Type', get: o => o.spec?.type, facet: true },
    { id: 'clusterIP', label: 'Cluster IP', get: o => o.spec?.clusterIP },
    { id: 'externalIP', label: 'External IP', kind: 'tags', get: o => getExternalAddresses(o) },
    { id: 'ports', label: 'Ports', kind: 'tags', get: o => getFormattedPorts(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
