import { Injectable, inject } from '@angular/core';
import { HttpService } from './http.service';

/** Control API 클라이언트 — Admin UI는 K8s를 직접 안 만지고 이것만 호출(계획서 §8).
 *  사용자 신원은 X-OpenSphere-User로 전달(audit·권한). 셸 nginx가 controller로 프록시. */
export interface CatalogItem {
  name: string; displayName: string; version: string; owner: string;
  description: string; nav?: { band: string; label: string; icon?: string; labelOverride?: string; bandOverride?: string | null; order?: number };
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
    client?: 'cli:os' | 'console:web'; operationId?: string;
  };
  status: {
    phase?: string; reason?: string; manifestUrl?: string; lastTransitionTime?: string;
    retryable?: boolean; nextRetryAt?: string; observedGeneration?: number;
    observedVersion?: string; currentVersion?: string; currentCompatibilityVersion?: string;
    currentBuildAuthority?: 'localhost' | 'github-actions'; currentDigest?: string;
    currentManifestSha256?: string; currentRequestedRef?: string;
    currentRequestedChannel?: string; currentResolvedAt?: string;
    currentSource?: string; currentRevision?: string;
    currentSignatureIdentity?: string; currentEvidenceRefs?: string[];
    previousDigest?: string; previousManifestSha256?: string;
    previousVersion?: string; previousCompatibilityVersion?: string;
    previousBuildAuthority?: 'localhost' | 'github-actions';
    previousRequestedRef?: string; previousRequestedChannel?: string;
    previousSource?: string; previousRevision?: string;
    previousSignatureIdentity?: string; previousEvidenceRefs?: string[];
    previousRegistryCredentialsRequired?: boolean;
    currentChannelDigest?: string;
    channelState?: 'Current' | 'UpdateAvailable' | 'SecurityActionRequired' | 'ChannelUnavailable';
    channelCheckedAt?: string; channelReason?: string;
    host?: { ref?: string; observedApiVersion?: string; phase?: string };
    workload?: { phase?: string };
    verification?: {
      manifest?: string; signature?: string; entryDigest?: string; permissions?: string;
    };
    serving?: {
      phase?: 'Current' | 'LastKnownGood' | 'Unavailable' | string;
      reason?: string; observedAt?: string;
    };
    revalidation?: {
      phase?: 'Pending' | 'Passed' | 'Failed' | string;
      reason?: string; observedAt?: string;
    };
    // An installed consumer whose activation still waits on a platform capability
    // reports what is missing here, so the page can name the remaining work.
    admission?: {
      activationAllowed?: boolean; reason?: string;
      pendingCapabilities?: string[]; satisfiedCapabilities?: string[];
      route?: string; checkedAt?: string;
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
  phase?: string; verified?: boolean; authenticationMode?: string; refreshPolicy?: string;
  expiresAt?: string | null; refreshExpiresAt?: string | null; verifiedAt?: string | null;
  errorCode?: string | null; oauthAvailable?: boolean; oauthProductionVerified?: boolean;
  synchronizedNamespaces?: string[]; requiredNamespaceCount?: number;
  authorization?: { userCode: string; verificationUri: string; expiresAt: string } | null;
  connectionId: 'opensphere-ghcr'; registryOrigin: 'ghcr.io'; namespace: 'opensphere-platform';
  username: string | null; credentialPresent: boolean; credentialVersion: string | null;
  configurationState: string; lastVerifiedAt: string | null; lastVerificationCode: string | null; updatedAt: string;
}
export interface ImageRevocation {
  imageRef: string; replacementImageRef?: string | null; operationId: string; payloadDigest: string; actionVersion: string; claimEpoch: number; revokedAt: string;
}
export interface RegistryConnectionVerification {
  connectionId: 'opensphere-ghcr'; result: 'Verified'; credentialVersion: string;
  authenticationMode: 'pat' | 'github-device'; expiresAt: string | null; verifiedAt: string; imageCount: number;
}
export interface OperationReceipt {
  schemaVersion: '1.0'; operationId: string; actionId: string; actionVersion: string;
  targetRef: string; state: 'Planned' | 'Authorized' | 'Submitted' | 'Reconciling' | 'Applied' | 'Verified' | 'Failed' | 'Unknown' | 'RolledBack';
  stateVersion: number; approvalRequired: boolean; correlationId: string;
}
interface ReadEnvelope<T> { schemaVersion: '1.0'; data: T; authority: string; observedAt: string; freshness: string; correlationId: string; evidenceRefs: string[]; }
export interface ExtensionProjectionStatus {
  ready: boolean;
  state: 'live' | 'stale' | 'unavailable';
  observedAt?: string;
  ageSeconds?: number;
  reason?: string;
}
export interface ExtensionProjectionResult<T> {
  items: T[];
  projection: ExtensionProjectionStatus;
}
// Binding — 비-UI 콘솔 확장(CLIDownload 등). UI plugin(UIPluginPackage)과 별개 kind. 콘솔이 '선언'을 인식·노출.
export interface BindingLink { os?: string; arch?: string; text: string; href: string; }
export interface Binding { kind: string; name: string; displayName: string; description?: string; enabled?: boolean; links: BindingLink[]; }

@Injectable({ providedIn: 'root' })
export class PluginControlClient {
  private http = inject(HttpService);

  async catalogSnapshot(): Promise<ExtensionProjectionResult<CatalogItem>> {
    const r = await this.http.request('/api/admin/plugins/catalog', { cache: 'no-store' });
    if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
    return r.json();
  }
  async catalog(): Promise<CatalogItem[]> {
    return (await this.catalogSnapshot()).items;
  }
  async registrationsSnapshot(): Promise<ExtensionProjectionResult<Registration>> {
    const r = await this.http.request('/api/admin/plugins/registrations', { cache: 'no-store' });
    if (!r.ok) throw new Error(`registrations HTTP ${r.status}`);
    return r.json();
  }
  async registrations(): Promise<Registration[]> {
    return (await this.registrationsSnapshot()).items;
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
    return this.http.request('/api/admin/extensions/registry-connections/opensphere-ghcr', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`registry connection HTTP ${r.status}`);
        return (await r.json() as ReadEnvelope<RegistryCredentialStatus>).data;
      });
  }
  beginRegistryOAuth(reason: string): Promise<{ connection: RegistryCredentialStatus; receipt: OperationReceipt }> {
    return this.http.request('/api/admin/extensions/registry-connections/opensphere-ghcr/oauth', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
    }).then(async (r) => { if (!r.ok) throw new Error('GitHub 인증 요청 실패: HTTP ' + r.status); return r.json(); });
  }
  verifyRegistryCredentials(): Promise<RegistryConnectionVerification> {
    return this.http.request('/api/admin/extensions/registry-connections/opensphere-ghcr/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(async (r) => {
      if (!r.ok) throw new Error(`registry verification HTTP ${r.status}: ${JSON.stringify(await r.json().catch(() => ({})))}`);
      return (await r.json() as ReadEnvelope<RegistryConnectionVerification>).data;
    });
  }
  configureRegistryCredentials(username: string, credential: string, reason: string): Promise<OperationReceipt> {
    return this.http.request('/api/admin/extensions/registry-connections/opensphere-ghcr', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, credential, reason }),
    }).then(async (r) => { if (!r.ok) throw new Error(`registry connection HTTP ${r.status}: ${JSON.stringify(await r.json())}`); return r.json(); });
  }
  removeRegistryCredentials(reason: string, confirmation: string): Promise<OperationReceipt> {
    return this.http.request('/api/admin/extensions/registry-connections/opensphere-ghcr', {
      method: 'DELETE',
      headers: { 'X-OpenSphere-Reason': reason, 'X-OpenSphere-Confirmation': confirmation },
    }).then(async (r) => { if (!r.ok) throw new Error(`registry connection HTTP ${r.status}: ${JSON.stringify(await r.json())}`); return r.json(); });
  }
  revocations(): Promise<ImageRevocation[]> {
    return this.http.request('/api/admin/extensions/revocations', { cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(`revocations HTTP ${r.status}`); return (await r.json() as ReadEnvelope<ImageRevocation[]>).data; });
  }
  revokeImage(image: string, replacementImage: string, reason: string, confirmation: string): Promise<OperationReceipt> {
    return this.http.request('/api/admin/extensions/revocations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, ...(replacementImage ? { replacementImage } : {}), reason, confirmation }),
    }).then(async (r) => { if (!r.ok) throw new Error(`revoke image HTTP ${r.status}: ${JSON.stringify(await r.json())}`); return r.json(); });
  }
  install(descriptorId: string, catalogRevision: string, reason: string): Promise<OperationReceipt> {
    return this.http.request('/api/admin/extensions/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ descriptorId: descriptorId.trim(), catalogRevision: catalogRevision.trim(), reason: reason.trim() }),
    }).then(async (r) => {
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { message?: unknown; error?: unknown };
        throw new Error(`install HTTP ${r.status}: ${String(body.message || body.error || 'request failed')}`);
      }
      return r.json() as Promise<OperationReceipt>;
    });
  }
  /** binding 소프트 토글(spec.enabled). disable=콘솔 노출만 제거(선언·서빙 유지). */
  bindingAction(name: string, action: 'enable' | 'disable') {
    return this.http.request(`/api/admin/bindings/${name}/${action}`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error(`${action} HTTP ${r.status}`); return r.json(); });
  }
  private act(id: string, action: 'install' | 'enable' | 'disable' | 'uninstall' | 'rollback', reason?: string) {
    return this.http.request(`/api/admin/plugins/registrations/${id}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: reason ?? '' }),
    }).then(async (r) => {
      if (!r.ok) {
        let detail = '';
        try {
          const body = await r.json() as { message?: unknown; error?: unknown };
          detail = String(body.message || body.error || '').trim();
        } catch {
          // HTTP status remains useful when an intermediary returns a non-JSON error.
        }
        throw new Error(`${action} HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
      }
      return r.json();
    });
  }
  enable(id: string, reason: string) { return this.act(id, 'enable', reason); }
  disable(id: string, reason: string) { return this.act(id, 'disable', reason); }
  uninstall(id: string, reason: string) { return this.act(id, 'uninstall', reason); }
  rollback(id: string, reason: string) { return this.act(id, 'rollback', reason); }
  /** 1단 아이콘 지정 — durable Console navigation preference(Carbon 토큰명). 빈 문자열=기본 아이콘. */
  setIcon(id: string, icon: string) {
    return this.http.request(`/api/admin/plugins/packages/${id}/icon`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ icon }),
    }).then((r) => { if (!r.ok) throw new Error(`set-icon HTTP ${r.status}`); return r.json(); });
  }
  /** Main Shell 1단 메뉴 표현 설정. 빈 labelOverride는 원래 displayName 사용. */
  setNavigation(id: string, settings: { icon?: string; labelOverride?: string; bandOverride?: string }) {
    return this.http.request(`/api/admin/plugins/packages/${id}/navigation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`set-navigation HTTP ${r.status}: ${JSON.stringify(await r.json().catch(() => ({})))}`);
      return r.json();
    });
  }
  /** 설치된 Main Shell subShell의 구역별 메뉴 순서를 한 요청으로 저장. */
  setNavigationOrder(ids: readonly string[]) {
    return this.http.request('/api/admin/plugins/navigation-order', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`set-navigation-order HTTP ${r.status}: ${JSON.stringify(await r.json().catch(() => ({})))}`);
      return r.json();
    });
  }
}
