import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { HttpService } from '../../core/http.service';
import { SystemPluginRegistryService } from '../../core/system-plugin-registry.service';
import type { OsShellBlocker, OsShellReadiness, OsShellReleaseEvidence } from './os-shell.types';

const DEFAULT_BLOCKER: OsShellBlocker = Object.freeze({
  code: 'OsShellRuntimeNotObserved',
  message: 'CBSS OS Shell runtime의 준비 상태를 아직 확인하지 못했습니다.',
  nextAction: 'Console Backend와 OS Shell runtime이 준비되면 다시 확인하세요.',
  owner: 'cbss-main-shell',
});

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ''): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

@Injectable({ providedIn: 'root' })
export class OsShellReadinessService {
  private readonly http = inject(HttpService);
  private readonly auth = inject(AuthService);
  private readonly registry = inject(SystemPluginRegistryService);
  private inFlight?: Promise<OsShellReadiness>;

  readonly status = signal<OsShellReadiness>({
    state: 'Disabled',
    authorized: false,
    enabled: false,
    ready: false,
    observedAt: '',
    freshness: 'missing',
    sessionClass: 'operator-interactive',
    runtimeAdapterId: 'cbss.kubernetes-pod',
    networkProfile: 'console-only',
    blocker: DEFAULT_BLOCKER,
    release: {},
  });
  readonly busy = signal(false);

  refresh(): Promise<OsShellReadiness> {
    if (this.inFlight) return this.inFlight;
    this.busy.set(true);
    this.status.update((current) => ({ ...current, state: 'Checking' }));
    const request = this.load().finally(() => {
      this.busy.set(false);
      this.inFlight = undefined;
    });
    this.inFlight = request;
    return request;
  }

  private async load(): Promise<OsShellReadiness> {
    const descriptor = this.registry.get('os-shell');
    if (!descriptor || !this.registry.hasGrant('os-shell', 'session:attach')) {
      return this.setBlocked('SystemPluginContractInvalid', 'OS Shell system descriptor 또는 session:attach grant가 유효하지 않습니다.', 'Console release contract를 복구하세요.');
    }
    if (!this.auth.subject() || this.auth.loginRequired()) {
      return this.setBlocked('ConsoleSessionRequired', '유효한 Console 세션이 필요합니다.', 'Console에 다시 로그인하세요.');
    }
    try {
      const response = await this.http.request('/api/os-shell/readiness', { cache: 'no-store', timeoutMs: 10000 });
      if (response.status === 401) return this.setBlocked('ConsoleSessionRequired', 'Console 세션을 확인할 수 없습니다.', 'Console에 다시 로그인하세요.');
      if (response.status === 403) return this.setBlocked('SessionAttachDenied', '현재 사용자에게 OS Shell 연결 권한이 없습니다.', 'console-admins 또는 console-operators 권한을 요청하세요.');
      if (!response.ok) return this.setBlocked('OsShellControlPlaneUnavailable', `OS Shell readiness API가 HTTP ${response.status}로 응답했습니다.`, 'Console Backend와 session control 상태를 확인하세요.');
      const normalized = this.normalize(await response.json());
      this.status.set(normalized);
      return normalized;
    } catch {
      return this.setBlocked('OsShellControlPlaneUnavailable', 'OS Shell session control에 연결할 수 없습니다.', 'Console Backend와 /api/os-shell 경로를 확인하세요.');
    }
  }

  private normalize(value: unknown): OsShellReadiness {
    const root = object(value);
    const readiness = object(root['readiness']);
    const source = Object.keys(readiness).length ? readiness : root;
    const blockerValue = object(source['blocker']);
    const releaseValue = object(source['release'] ?? source['releaseEvidence']);
    const observedAt = text(source['observedAt'] ?? source['observed_at']);
    const observedMs = Date.parse(observedAt);
    const freshness: OsShellReadiness['freshness'] = !Number.isFinite(observedMs)
      ? 'missing'
      : Date.now() - observedMs > 60_000 ? 'stale' : 'fresh';
    const authorized = bool(source['authorized'] ?? source['grantApproved'] ?? source['sessionAttachGranted']);
    const enabled = bool(source['enabled']);
    const reportedReady = bool(source['ready'] ?? source['readyToCreate'] ?? source['readyToExecute']);
    const ready = authorized && enabled && reportedReady && freshness === 'fresh';
    const release: OsShellReleaseEvidence = {
      runtimeImageDigest: text(releaseValue['runtimeImageDigest'] ?? releaseValue['runtime_image_digest']) || undefined,
      osArtifactDigest: text(releaseValue['osArtifactDigest'] ?? releaseValue['os_artifact_digest']) || undefined,
      releaseEvidenceRef: text(releaseValue['releaseEvidenceRef'] ?? releaseValue['release_evidence_ref']) || undefined,
      sessionPolicyRevision: text(releaseValue['sessionPolicyRevision'] ?? releaseValue['session_policy_revision']) || undefined,
    };
    let blocker: OsShellBlocker | null = null;
    if (!ready) {
      const defaultCode = !authorized ? 'SessionAttachNotGranted'
        : !enabled ? 'OsShellDisabled'
          : freshness !== 'fresh' ? 'OsShellReadinessStale'
            : 'OsShellRuntimeNotReady';
      blocker = {
        code: text(blockerValue['code'], defaultCode),
        message: text(blockerValue['message'] ?? blockerValue['detail'], 'OS Shell runtime이 아직 세션을 수락할 준비가 되지 않았습니다.'),
        nextAction: text(blockerValue['nextAction'] ?? blockerValue['remediation'], 'CBSS runtime 상태를 확인한 뒤 다시 시도하세요.'),
        owner: text(blockerValue['owner'], 'cbss-main-shell'),
      };
    }
    const normalized: OsShellReadiness = {
      state: ready ? 'Ready' : enabled ? 'Blocked' : 'Disabled',
      authorized,
      enabled,
      ready,
      observedAt,
      freshness,
      sessionClass: 'operator-interactive',
      runtimeAdapterId: 'cbss.kubernetes-pod',
      networkProfile: 'console-only',
      blocker,
      release,
    };
    return normalized;
  }

  private setBlocked(code: string, message: string, nextAction: string): OsShellReadiness {
    const value: OsShellReadiness = {
      state: 'Blocked',
      authorized: false,
      enabled: false,
      ready: false,
      observedAt: new Date().toISOString(),
      freshness: 'missing',
      sessionClass: 'operator-interactive',
      runtimeAdapterId: 'cbss.kubernetes-pod',
      networkProfile: 'console-only',
      blocker: { code, message, nextAction, owner: 'cbss-main-shell' },
      release: {},
    };
    this.status.set(value);
    return value;
  }
}
