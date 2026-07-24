import { Component } from '@angular/core';
import { ColumnDef, ResourceListComponent } from '../shared/resource-list.component';

/** spec.rules[].host 목록 (host 없으면 '*'). */
const hosts = (o: any): string[] => {
  const rules: any[] = o.spec?.rules || [];
  const hs = rules.map(r => r.host || '*');
  return hs.length ? Array.from(new Set(hs)) : [];
};

/** spec.rules[].http.paths[] → 'path › service:port' 쌍 목록 (v1/legacy 정규화). */
const paths = (o: any): string[] => {
  const out: string[] = [];
  for (const r of o.spec?.rules || []) {
    for (const p of r.http?.paths || []) {
      const b = p.backend || {};
      const svc = b.service;
      const target = svc
        ? `${svc.name}:${svc.port?.number ?? svc.port?.name ?? ''}`
        : b.resource
          ? `${b.resource.kind}/${b.resource.name}`
          : `${b.serviceName ?? ''}:${b.servicePort ?? ''}`;
      out.push(`${p.path || '/'} › ${target}`);
    }
  }
  return out;
};

/** status.loadBalancer.ingress[].hostname|ip 목록. */
const addresses = (o: any): string[] =>
  (o.status?.loadBalancer?.ingress || [])
    .map((i: any) => i.hostname || i.ip)
    .filter(Boolean);

/** Ingresses 목록 — 제네릭 프록시(/apis/networking.k8s.io/v1/ingresses) 기반. namespaced. */
@Component({
  selector: 'app-res-ingresses',
  standalone: true,
  imports: [ResourceListComponent],
  template: `<app-resource-list title="Ingresses" path="/apis/networking.k8s.io/v1/ingresses" [namespaced]="true" kind="Ingress" [columns]="cols" />`,
})
export class IngressComponent {
  cols: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'name', get: o => o.metadata?.name },
    { id: 'class', label: 'Class Name', get: o => o.spec?.ingressClassName, facet: true },
    { id: 'hosts', label: 'Hosts', kind: 'tags', get: o => hosts(o) },
    { id: 'paths', label: 'Path', kind: 'tags', get: o => paths(o) },
    { id: 'address', label: 'Address', kind: 'tags', get: o => addresses(o) },
    { id: 'age', label: 'Age', kind: 'age', get: o => o.metadata?.creationTimestamp },
  ];
}
