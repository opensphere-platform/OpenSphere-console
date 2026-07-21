import { Injectable, inject } from '@angular/core';
import { HttpService } from './http.service';

export interface ReadinessPrerequisite {
  key: string; label: string; ready: boolean; detail: string; route: string;
}
export interface ReadinessCondition {
  type: string; status: 'True' | 'False'; ready: boolean; reason: string; message: string;
  evidence: Record<string, unknown>[];
}
export interface ReadinessLifecycle {
  key: string; label: string; ready: boolean; state: string; detail: string; route: string;
}
export interface PlatformReadinessStatus {
  apiVersion: string;
  kind: string;
  observedAt: string;
  phase: string;
  ready: boolean;
  profile: {
    declared: boolean; crdReady: boolean; name: string; generation: number;
    lastVerifiedAt: string; status: Record<string, unknown> | null;
  };
  prerequisites: ReadinessPrerequisite[];
  capabilities: ReadinessCondition[];
  lifecycle: ReadinessLifecycle[];
  evidence: Record<string, unknown>;
  admission: {
    foundationStageAllowed: boolean;
    foundationActivationAllowed: boolean;
    foundationActivationOverride: boolean;
    foundationInstallAllowed: boolean;
    pfsPluginInstallAllowed: boolean;
    mode: 'Blocked' | 'PlatformSupportProfile' | 'DevelopmentOverride';
    reason: string;
  };
  pfs: { established: boolean; phase: string };
}

@Injectable({ providedIn: 'root' })
export class PlatformReadinessService {
  private http = inject(HttpService);

  async status(): Promise<PlatformReadinessStatus> {
    const response = await this.http.request('/api/admin/platform-readiness/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`platform readiness HTTP ${response.status}`);
    return response.json();
  }

  async preflight(reason: string): Promise<PlatformReadinessStatus> {
    return this.mutate('preflight', reason);
  }

  async verify(reason: string): Promise<PlatformReadinessStatus> {
    return this.mutate('verify', reason);
  }

  private async mutate(operation: 'preflight' | 'verify', reason: string): Promise<PlatformReadinessStatus> {
    const response = await this.http.request(`/api/admin/platform-readiness/${operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
      let detail = '';
      try { detail = JSON.stringify(await response.json()); } catch { detail = ''; }
      throw new Error(`${operation} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.json();
  }
}
