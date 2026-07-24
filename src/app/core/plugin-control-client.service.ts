import { Injectable, inject } from '@angular/core';
import { HttpService } from './http.service';

/** Control API 클라이언트 — Admin UI는 K8s를 직접 안 만지고 이것만 호출(계획서 §8).
 *  사용자 신원은 X-OpenSphere-User로 전달(audit·권한). 셸 nginx가 controller로 프록시. */
export interface CatalogItem {
  name: string; displayName: string; version: string; owner: string;
  description: string; nav?: { band: string; label: string; icon?: string };
  shellCompat: string; permissions: string[];
  kind: 'subShell' | 'plugin'; hostRef: string; hostApiVersion?: string; hostCompat: string;
  contributions: Record<string, unknown>;
  scope?: string; core?: boolean;
  requestedChannel?: string; installedDigest?: string; currentChannelDigest?: string;
  updateState?: 'Current' | 'UpdateAvailable' | 'SecurityActionRequired' | 'ChannelUnavailable';
  channelCheckedAt?: string; channelReason?: string;
}
export interface Registration {
  name: string; desiredState: string;
  installation?: {
    requestedAt?: string; requestedBy?: string; requestedById?: string;
    client?: 'cli:os'; operationId?: string;
  };
  status: {
    phase?: string; reason?: string; manifestUrl?: string; lastTransitionTime?: string;
    retryable?: boolean; nextRetryAt?: string; observedGeneration?: number;
    observedVersion?: string; currentVersion?: string; currentDigest?: string;
    currentManifestSha256?: string; currentRequestedRef?: string;
    currentRequestedChannel?: string; currentResolvedAt?: string;
    currentSource?: string; currentRevision?: string;
    currentSignatureIdentity?: string; currentEvidenceRefs?: string[];
    currentChannelDigest?: string;
    channelState?: 'Current' | 'UpdateAvailable' | 'SecurityActionRequired' | 'ChannelUnavailable';
    channelCheckedAt?: string; channelReason?: string;
    host?: { ref?: string; observedApiVersion?: string; phase?: string };
    workload?: { phase?: string };
    verification?: {
      manifest?: string; signature?: string; entryDigest?: string; permissions?: string;
    };
    integrations?: Record<string, IntegrationStatus>;
  };
  approval?: { requestedBy?: string; reason?: string };
  health?: 'Ready' | 'NotReady' | 'N/A'; // P2-2: 활성 플러그인 워크로드 health(컨트롤러 제공)
}
export interface IntegrationStatus {
  phase: 'Ready' | 'Disabled' | 'Failed' | 'Degraded' | 'DependencyPending' | string;
  reason?: string; message?: string; retryable?: boolean; nextRetryAt?: string;
  lastTransitionTime?: string; observedVersion?: string;
}
export interface AuditEvent {
  time: string; actor: string; actorId?: string; action: string; target: string;
  result: string; reason: string; opId?: string; source?: string;
}
export interface RegistryCredentialStatus {
  registry: 'ghcr.io'; configured: boolean; username?: string; secretName: string; updatedAt?: string;
}
export interface ImageRevocation {
  repository: string; digest: string; replacementDigest?: string; revokedAt: string; actor: string; reason: string;
}
// Binding — 비-UI 콘솔 확장(CLIDownload 등). UI plugin(UIPluginPackage)과 별개 kind. 콘솔이 '선언'을 인식·노출.
export interface BindingLink { os?: string; arch?: string; text: string; href: string; }
export interface Binding { kind: string; name: string; displayName: string; description?: string; enabled?: boolean; links: BindingLink[]; }

@Injectable({ providedIn: 'root' })
export class PluginControlClient {
  private http = inject(HttpService);

  async catalog(): Promise<CatalogItem[]> {
    const r = await this.http.request('/api/admin/plugins/catalog', { cache: 'no-store' });
    if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
    return (await r.json()).items;
  }
  async registrations(): Promise<Registration[]> {
    const r = await this.http.request('/api/admin/plugins/registrations', { cache: 'no-store' });
    if (!r.ok) throw new Error(`registrations HTTP ${r.status}`);
    return (await r.json()).items;
  }
  async events(): Promise<AuditEvent[]> {
    const r = await this.http.request('/api/admin/plugins/events', { cache: 'no-store' });
    if (!r.ok) throw new Error(`events HTTP ${r.status}`);
    return (await r.json()).items;
  }
  /** headless 바인딩(CLIDownload 등) — UI plugin과 별개 채널. controller /api/admin/bindings. */
  async bindings(): Promise<Binding[]> {
    const r = await this.http.request('/api/admin/bindings', { cache: 'no-store' });
    if (!r.ok) throw new Error(`bindings HTTP ${r.status}`);
    return (await r.json()).items;
  }
  registryCredentialStatus(): Promise<RegistryCredentialStatus> {
    return this.http.request('/api/admin/extensions/registry-credentials', { cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(`registry credentials HTTP ${r.status}`); return r.json(); });
  }
  configureRegistryCredentials(username: string, token: string, reason: string): Promise<RegistryCredentialStatus> {
    return this.http.request('/api/admin/extensions/registry-credentials', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, token, reason }),
    }).then(async (r) => { if (!r.ok) throw new Error(`registry credentials HTTP ${r.status}: ${JSON.stringify(await r.json())}`); return r.json(); });
  }
  removeRegistryCredentials(reason: string): Promise<RegistryCredentialStatus> {
    return this.http.request('/api/admin/extensions/registry-credentials', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
    }).then(async (r) => { if (!r.ok) throw new Error(`registry credentials HTTP ${r.status}: ${JSON.stringify(await r.json())}`); return r.json(); });
  }
  revocations(): Promise<ImageRevocation[]> {
    return this.http.request('/api/admin/extensions/revocations', { cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(`revocations HTTP ${r.status}`); return (await r.json()).items; });
  }
  revokeImage(image: string, replacementImage: string, reason: string): Promise<ImageRevocation> {
    return this.http.request('/api/admin/extensions/revocations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, replacementImage, reason }),
    }).then(async (r) => { if (!r.ok) throw new Error(`revoke image HTTP ${r.status}: ${JSON.stringify(await r.json())}`); return (await r.json()).item; });
  }
  /** binding 소프트 토글(spec.enabled). disable=콘솔 노출만 제거(선언·서빙 유지). */
  bindingAction(name: string, action: 'enable' | 'disable') {
    return this.http.request(`/api/admin/bindings/${name}/${action}`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error(`${action} HTTP ${r.status}`); return r.json(); });
  }
  private act(id: string, action: 'enable' | 'disable' | 'uninstall', reason?: string) {
    return this.http.request(`/api/admin/plugins/registrations/${id}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: reason ?? '' }),
    }).then((r) => { if (!r.ok) throw new Error(`${action} HTTP ${r.status}`); return r.json(); });
  }
  enable(id: string) { return this.act(id, 'enable'); }
  disable(id: string) { return this.act(id, 'disable'); }
  uninstall(id: string) { return this.act(id, 'uninstall'); }
  /** 1단 아이콘 지정 — UIPluginPackage spec.nav.icon 패치(Carbon 토큰명). 빈 문자열=기본 아이콘. */
  setIcon(id: string, icon: string) {
    return this.http.request(`/api/admin/plugins/packages/${id}/icon`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ icon }),
    }).then((r) => { if (!r.ok) throw new Error(`set-icon HTTP ${r.status}`); return r.json(); });
  }
}
