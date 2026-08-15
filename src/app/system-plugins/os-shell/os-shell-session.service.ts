import { Injectable, inject } from '@angular/core';
import { HttpService } from '../../core/http.service';
import { OS_SHELL_PTY_PROTOCOL } from './os-shell-protocol';
import type { OsShellAttachTicket, OsShellReleaseEvidence, OsShellSession } from './os-shell.types';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

@Injectable({ providedIn: 'root' })
export class OsShellSessionService {
  private readonly http = inject(HttpService);

  async create(): Promise<OsShellSession> {
    const response = await this.http.request('/api/os-shell/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ networkProfile: 'console-only' }),
      timeoutMs: 30000,
    });
    return this.sessionResponse(response);
  }

  async get(sessionId: string): Promise<OsShellSession> {
    const response = await this.http.request(`/api/os-shell/sessions/${encodeURIComponent(this.sessionId(sessionId))}`, {
      cache: 'no-store',
    });
    return this.sessionResponse(response);
  }

  async list(): Promise<readonly OsShellSession[]> {
    const response = await this.http.request('/api/os-shell/sessions', { cache: 'no-store' });
    if (!response.ok) throw new Error(await this.error(response));
    const body = object(await response.json());
    const values = Array.isArray(body['items']) ? body['items'] : Array.isArray(body['sessions']) ? body['sessions'] : [];
    return values.map((item) => this.normalizeSession(item));
  }

  async terminate(sessionId: string): Promise<void> {
    const response = await this.http.request(`/api/os-shell/sessions/${encodeURIComponent(this.sessionId(sessionId))}`, {
      method: 'DELETE',
      timeoutMs: 30000,
    });
    if (!response.ok && response.status !== 404) throw new Error(await this.error(response));
  }

  async issueAttachTicket(sessionId: string): Promise<OsShellAttachTicket> {
    const response = await this.http.request(`/api/os-shell/sessions/${encodeURIComponent(this.sessionId(sessionId))}/attach-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      timeoutMs: 10000,
    });
    if (!response.ok) throw new Error(await this.error(response));
    const body = object(await response.json());
    const ticketValue = object(body['attachTicket']);
    const source = Object.keys(ticketValue).length ? ticketValue : body;
    const ticket = text(source['ticket']);
    const expiresAt = text(source['expiresAt'] ?? source['expires_at']);
    const protocol = text(source['protocol']);
    const boundSessionId = this.sessionId(text(source['sessionId'] ?? source['session_id']));
    const generation = number(source['generation']);
    const fencingEpoch = number(source['fencingEpoch'] ?? source['fencing_epoch']);
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket) || !Number.isFinite(Date.parse(expiresAt)) || protocol !== OS_SHELL_PTY_PROTOCOL
        || boundSessionId !== sessionId || generation < 1 || fencingEpoch < 1) {
      throw new Error('AttachTicketContractInvalid');
    }
    return { ticket, expiresAt, protocol: OS_SHELL_PTY_PROTOCOL, sessionId: boundSessionId, generation, fencingEpoch };
  }

  private async sessionResponse(response: Response): Promise<OsShellSession> {
    if (!response.ok) throw new Error(await this.error(response));
    const body = object(await response.json());
    return this.normalizeSession(body['session'] ?? body);
  }

  private normalizeSession(value: unknown): OsShellSession {
    const source = object(value);
    const releaseSource = object(source['release'] ?? source['releaseEvidence']);
    const sessionId = this.sessionId(text(source['sessionId'] ?? source['session_id']));
    const sessionClass = text(source['sessionClass'] ?? source['session_class']);
    const runtimeAdapterId = text(source['runtimeAdapterId'] ?? source['runtime_adapter_id']);
    const expiresAt = text(source['expiresAt'] ?? source['expires_at']);
    if (sessionClass !== 'operator-interactive' || runtimeAdapterId !== 'cbss.kubernetes-pod' || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('OsShellSessionContractInvalid');
    }
    const release: OsShellReleaseEvidence = {
      runtimeImageDigest: text(releaseSource['runtimeImageDigest'] ?? source['runtimeImageDigest']) || undefined,
      osArtifactDigest: text(releaseSource['osArtifactDigest'] ?? source['osArtifactDigest']) || undefined,
      releaseEvidenceRef: text(releaseSource['releaseEvidenceRef'] ?? source['releaseEvidenceRef']) || undefined,
      sessionPolicyRevision: text(releaseSource['sessionPolicyRevision'] ?? source['sessionPolicyRevision']) || undefined,
    };
    return {
      sessionId,
      sessionClass: 'operator-interactive',
      runtimeAdapterId: 'cbss.kubernetes-pod',
      generation: number(source['generation'], 1),
      fencingEpoch: number(source['fencingEpoch'] ?? source['fencing_epoch'], 1),
      desiredState: text(source['desiredState'] ?? source['desired_state']) || 'Ready',
      observedState: text(source['observedState'] ?? source['observed_state']) || 'Pending',
      expiresAt,
      createdAt: text(source['createdAt'] ?? source['created_at']) || undefined,
      updatedAt: text(source['updatedAt'] ?? source['updated_at']) || undefined,
      idleExpiresAt: text(source['idleExpiresAt'] ?? source['idle_expires_at']) || undefined,
      release,
    };
  }

  private sessionId(value: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new Error('OsShellSessionIdInvalid');
    return value;
  }

  private async error(response: Response): Promise<string> {
    try {
      const body = object(await response.clone().json());
      return text(body['code'] ?? body['error'] ?? body['message']) || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}
