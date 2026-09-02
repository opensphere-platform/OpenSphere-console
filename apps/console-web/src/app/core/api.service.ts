import { Injectable, inject } from '@angular/core';
import { HttpService } from './http.service';

/** rhdh-self(headless 엔진)와 기능 컨테이너 API 소비.
 *  경로는 셸 nginx가 프록시: /api/catalog/*·/api/kubernetes/* → Console backend.
 *  헌법 §4: 엔진은 흡수하되 UI는 임베드하지 않는다 — 그 실행형.
 */
export interface CatalogEntity {
  kind: string;
  metadata: { name: string; namespace?: string; description?: string; uid?: string };
  spec?: Record<string, unknown>;
  relations?: { type: string; targetRef: string }[];
}

export interface CatalogCoverage {
  expected: number;
  published: number;
  rejected: number;
  missing: { id: string; class: string; code: string; message: string }[];
}

export interface CatalogProjection {
  revision: string;
  filter: 'all' | 'api';
  returned: number;
  coverage: CatalogCoverage;
  items: CatalogEntity[];
}

interface CatalogEnvelope {
  schemaVersion: '1.0';
  data: CatalogProjection;
  authority: 'OpenSphereRegistry';
  observedAt: string;
  freshness: 'fresh';
  correlationId: string;
  evidenceRefs: string[];
}

export interface RuntimeResource {
  cluster: string;
  type: string;
  namespace: string;
  name: string;
  status: string;
  healthy: boolean;
}

export class RuntimeObservationUnavailableError extends Error {
  override readonly name = 'RuntimeObservationUnavailableError';

  constructor() {
    super('Kubernetes runtime observation owner is not configured');
  }
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

export class PlatformStatusUnavailableError extends Error {
  override readonly name = 'PlatformStatusUnavailableError';

  constructor() {
    super('Platform status observation owner is not configured');
  }
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpService);

  async catalogProjection(apiOnly = false): Promise<CatalogProjection> {
    const path = '/api/catalog/entities?' + (apiOnly ? 'filter=kind=api&' : '') + 'limit=200';
    const res = await this.http.request(path);
    if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
    const envelope = await res.json() as CatalogEnvelope;
    if (envelope?.schemaVersion !== '1.0' || envelope.authority !== 'OpenSphereRegistry'
      || envelope.freshness !== 'fresh' || !Array.isArray(envelope.data?.items)
      || envelope.data.returned !== envelope.data.items.length) {
      throw new Error('catalog: invalid authority projection');
    }
    return envelope.data;
  }

  async catalogEntities(): Promise<CatalogEntity[]> {
    return (await this.catalogProjection()).items;
  }

  /** kind=API만 — RHDH 'APIs'(API Explorer) 메뉴의 셸판 데이터 */
  async apiEntities(): Promise<CatalogEntity[]> {
    return (await this.catalogProjection(true)).items;
  }

  /** Runtime observation stays unavailable until a bounded owner is configured.
   *  C_API deliberately receives no Kubernetes credential or RBAC. */
  async runtimeResources(entity: CatalogEntity): Promise<RuntimeResource[]> {
    const res = await this.http.request(`/api/kubernetes/services/${entity.metadata.name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: { metadata: { name: entity.metadata.name } } }),
    });
    if (!res.ok) {
      const error = await res.clone().json().catch(() => null) as {
        code?: string;
        details?: { reasonCode?: string; authority?: string };
      } | null;
      if (res.status === 503 && error?.code === 'AuthorityUnavailable'
        && error.details?.reasonCode === 'RuntimeObservationOwnerUnconfigured'
        && error.details.authority === 'KubernetesRuntimeObservation') {
        throw new RuntimeObservationUnavailableError();
      }
      throw new Error(`kubernetes: HTTP ${res.status}`);
    }
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

  async platformStatus(): Promise<never> {
    const res = await this.http.request('/api/status/api/status');
    const error = await res.clone().json().catch(() => null) as {
      code?: string;
      details?: { reasonCode?: string; authority?: string };
    } | null;
    if (res.status === 503 && error?.code === 'AuthorityUnavailable'
      && error.details?.reasonCode === 'PlatformStatusOwnerUnconfigured'
      && error.details.authority === 'PlatformStatusObservation') {
      throw new PlatformStatusUnavailableError();
    }
    throw new Error(`status: unexpected HTTP ${res.status}`);
  }
}
