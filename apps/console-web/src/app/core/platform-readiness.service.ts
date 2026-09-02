import { Injectable, inject } from '@angular/core';
import { HttpService } from './http.service';
import {
  asRecord,
  evaluateReleaseLockReadiness,
  evaluateSupabaseReadiness,
  type BackboneComponentId,
  type BackboneReadinessComponent,
  type PlatformReadinessStatus,
} from './platform-readiness.model';
export type { BackboneReadinessComponent, PlatformReadinessStatus } from './platform-readiness.model';

interface ComponentDefinition {
  id: BackboneComponentId;
  label: string;
  authority: string;
  endpoint: string;
  route: string;
  evaluate: (document: Record<string, unknown>) => { ready: boolean; detail: string };
}

const DEFINITIONS: readonly ComponentDefinition[] = [
  {
    id: 'supabase',
    label: 'Supabase Data & Identity',
    authority: 'SupabaseAuth + PostgreSQL',
    endpoint: '/api/identity/supabase/status',
    route: '/manage/data-identity',
    evaluate: evaluateSupabaseReadiness,
  },
  {
    id: 'gitea',
    label: 'Gitea Change Control',
    authority: 'Gitea',
    endpoint: '/api/platform/gitea/status',
    route: '/manage/platform-control',
    evaluate(document) {
      const ready = document['ready'] === true;
      return { ready, detail: ready ? 'Repository and governed change path Ready' : String(document['reason'] || 'Gitea readiness evidence is incomplete') };
    },
  },
  {
    id: 'release',
    label: 'Installed Release Lock',
    authority: 'OpenSphere Release Lock',
    endpoint: '/api/platform/releases/status',
    route: '/manage/platform-release',
    evaluate: evaluateReleaseLockReadiness,
  },
  {
    id: 'beszel',
    label: 'Beszel Baseline Monitoring',
    authority: 'Beszel',
    endpoint: '/api/monitoring/baseline/v1/data-health',
    route: '/manage/infrastructure-monitoring',
    evaluate(document) {
      const status = String(document['status'] || 'unknown');
      return { ready: status === 'healthy', detail: status === 'healthy' ? 'Hub reader and node telemetry are healthy' : `Baseline monitoring reports ${status}` };
    },
  },
];

function observationTime(document: Record<string, unknown>, fallback: string): string {
  const meta = asRecord(document['meta']);
  for (const value of [document['observedAt'], document['checkedAt'], meta['checkedAt']]) {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  }
  return fallback;
}

@Injectable({ providedIn: 'root' })
export class PlatformReadinessService {
  private readonly http = inject(HttpService);

  async status(): Promise<PlatformReadinessStatus> {
    const checkedAt = new Date().toISOString();
    const components = await Promise.all(DEFINITIONS.map((definition) => this.read(definition, checkedAt)));
    const ready = components.every((component) => component.ready);
    return {
      schemaVersion: '1.0',
      kind: 'ConsoleBackboneReadiness',
      observedAt: checkedAt,
      phase: ready ? 'Ready' : 'Attention',
      ready,
      components,
    };
  }

  private async read(definition: ComponentDefinition, checkedAt: string): Promise<BackboneReadinessComponent> {
    try {
      const response = await this.http.request(definition.endpoint, { cache: 'no-store' });
      if (!response.ok) {
        return this.component(definition, false, 'AuthorityUnavailable', `HTTP ${response.status}`, checkedAt, null);
      }
      const document = asRecord(await response.json());
      const result = definition.evaluate(document);
      return this.component(definition, result.ready, result.ready ? 'Ready' : 'Attention', result.detail, observationTime(document, checkedAt), document);
    } catch (error) {
      return this.component(definition, false, 'AuthorityUnavailable', String(error), checkedAt, null);
    }
  }

  private component(
    definition: ComponentDefinition,
    ready: boolean,
    state: BackboneReadinessComponent['state'],
    detail: string,
    observedAt: string,
    evidence: Record<string, unknown> | null,
  ): BackboneReadinessComponent {
    return {
      id: definition.id,
      label: definition.label,
      authority: definition.authority,
      endpoint: definition.endpoint,
      route: definition.route,
      ready,
      state,
      detail,
      observedAt,
      evidence,
    };
  }
}