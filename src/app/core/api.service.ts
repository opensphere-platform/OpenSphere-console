import { Injectable, inject } from '@angular/core';
import { HttpService } from './http.service';

/** rhdh-self(headless 엔진)와 기능 컨테이너 API 소비.
 *  경로는 셸 nginx가 프록시: /api/rhdh/* → RHDH, /api/status/* → platform-status.
 *  헌법 §4: 엔진은 흡수하되 UI는 임베드하지 않는다 — 그 실행형.
 */
export interface CatalogEntity {
  kind: string;
  metadata: { name: string; namespace?: string; description?: string; uid?: string };
  spec?: Record<string, unknown>;
  relations?: { type: string; targetRef: string }[];
}

export interface RuntimeResource {
  cluster: string;
  type: string;
  namespace: string;
  name: string;
  status: string;
  healthy: boolean;
}

/** 리소스 종류별 상태 요약 (TAP Status 열 대응) */
function summarizeStatus(type: string, o: any): string {
  const s = o.status ?? {};
  switch (type) {
    case 'pods': {
      const ready = (s.containerStatuses ?? []).filter((c: any) => c.ready).length;
      const total = (s.containerStatuses ?? []).length;
      return `${s.phase ?? '?'} (${ready}/${total})`;
    }
    case 'deployments':
    case 'statefulsets':
      return `${s.availableReplicas ?? 0}/${o.spec?.replicas ?? 0} available`;
    case 'replicasets':
      return `${s.readyReplicas ?? 0}/${o.spec?.replicas ?? 0} ready`;
    case 'services':
      return o.spec?.type ?? 'ClusterIP';
    default:
      return '—';
  }
}

function isHealthy(type: string, o: any): boolean {
  const s = o.status ?? {};
  switch (type) {
    case 'pods':
      return s.phase === 'Running' && (s.containerStatuses ?? []).every((c: any) => c.ready);
    case 'deployments':
    case 'statefulsets':
      return (s.availableReplicas ?? 0) >= (o.spec?.replicas ?? 0) && (o.spec?.replicas ?? 0) > 0;
    case 'replicasets':
      // 구세대 RS(replicas 0)는 정상 상태의 일부
      return (o.spec?.replicas ?? 0) === 0 || (s.readyReplicas ?? 0) >= (o.spec?.replicas ?? 0);
    default:
      return true;
  }
}

export interface PlatformStatus {
  meta: { service: string; version: string; servedBy: string; time: string };
  platformConfigs: { name: string; spec: Record<string, any>; status: Record<string, any> }[];
  platformVersions: { name: string; spec: Record<string, any>; status: Record<string, any> }[];
  hostRequirements: { name: string; spec: Record<string, any>; status: Record<string, any> }[];
  observabilityStacks: { name: string; spec: Record<string, any>; status: Record<string, any> }[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpService);

  async catalogEntities(): Promise<CatalogEntity[]> {
    const res = await this.http.request('/api/rhdh/catalog/entities?limit=200');
    if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
    return res.json();
  }

  /** kind=API만 — RHDH 'APIs'(API Explorer) 메뉴의 셸판 데이터 */
  async apiEntities(): Promise<CatalogEntity[]> {
    const res = await this.http.request('/api/rhdh/catalog/entities?filter=kind=api&limit=200');
    if (!res.ok) throw new Error(`apis: HTTP ${res.status}`);
    return res.json();
  }

  /** 엔티티의 살아있는 K8s 리소스 — rhdh-self kubernetes backend 플러그인 소비
   *  (TAP 'Runtime Resources' 대응 — 헌법 §10: 흡수, 재구현 아님) */
  async runtimeResources(entity: CatalogEntity): Promise<RuntimeResource[]> {
    const res = await this.http.request(`/api/rhdh/kubernetes/services/${entity.metadata.name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity }),
    });
    if (!res.ok) throw new Error(`kubernetes: HTTP ${res.status}`);
    const data = await res.json();
    const out: RuntimeResource[] = [];
    for (const item of data.items ?? []) {
      for (const group of item.resources ?? []) {
        for (const o of group.resources ?? []) {
          out.push({
            cluster: item.cluster?.name ?? '-',
            type: group.type,
            namespace: o.metadata?.namespace ?? '-',
            name: o.metadata?.name ?? '-',
            status: summarizeStatus(group.type, o),
            healthy: isHealthy(group.type, o),
          });
        }
      }
    }
    return out;
  }

  async platformStatus(): Promise<PlatformStatus> {
    const res = await this.http.request('/api/status/api/status');
    if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
    return res.json();
  }
}
