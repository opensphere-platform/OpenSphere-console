import { Injectable, signal } from '@angular/core';
import { createTotpQrCode } from './totp-qr';

interface ApiError {
  error?: string;
  error_description?: string;
  msg?: string;
  message?: string;
}

export type SessionDuration = 'browser' | '8h' | '24h' | '7d';

export interface BrowserSession {
  id: string;
  current: boolean;
  status: 'pending_mfa' | 'active' | 'revoked' | 'expired';
  assurance: 'aal1' | 'aal2';
  persistence: SessionDuration;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  userAgentDigest?: string | null;
}

interface SessionProjection {
  subject?: string;
  username?: string;
  email?: string;
  displayName?: string;
  groups?: unknown;
  permissions?: unknown;
  assurance?: 'aal1' | 'aal2';
  session?: BrowserSession | null;
  authorityDegraded?: boolean;
  error?: string;
}

export interface TotpEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
}

export interface SessionEvent {
  id: number;
  session_id: string | null;
  event: string;
  result: string;
  occurred_at: string;
}

/**
 * Supabase remains the identity authority, while the Console Backend is the
 * browser-session broker. Raw Supabase access/refresh tokens are never exposed
 * to browser JavaScript. The browser holds only Secure cookies (one HttpOnly
 * opaque handle plus a non-secret double-submit CSRF value).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly user = signal('');
  readonly groups = signal<string[]>([]);
  readonly roles = signal<string[]>([]);
  readonly email = signal('');
  readonly name = signal('');
  readonly subject = signal('');
  readonly tokenExp = signal(0);
  readonly idleExp = signal(0);
  readonly assurance = signal<'aal1' | 'aal2'>('aal1');
  readonly currentSession = signal<BrowserSession | null>(null);
  readonly browserSessions = signal<BrowserSession[]>([]);
  readonly sessionDurationPreference = signal<SessionDuration>(this.loadDurationPreference());
  readonly mfaRequired = signal(false);
  readonly mfaEnrollmentRequired = signal(false);
  readonly passwordRecoveryState = signal<'idle' | 'ready' | 'completed' | 'error'>('idle');
  readonly passwordRecoveryMessage = signal('');
  readonly initError = signal('');
  readonly authorityWarning = signal('');
  readonly setupRequired = signal(false);
  readonly setupBusy = signal(false);
  readonly setupDefaults = signal({ username: 'opensphere-admin', displayName: 'OpenSphere Administrator', email: 'admin@opensphere.local' });
  readonly loginRequired = signal(false);
  readonly stepUpRequired = signal(false);
  readonly stepUpBusy = signal(false);
  readonly stepUpError = signal('');
  readonly sessionEvents = signal<SessionEvent[]>([]);
  private passwordRecoveryToken = '';
  private readonly sessionChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel('opensphere.browser-session');

  constructor() {
    this.sessionChannel?.addEventListener('message', (event) => {
      if (event.data?.type !== 'session-ended') return;
      this.clearIdentity();
      this.loginRequired.set(true);
    });
  }

  setInitError(error: unknown): void {
    this.initError.set(String(error instanceof Error ? error.message : error || '인증 초기화 실패'));
  }

  /** @deprecated Browser bearer tokens are intentionally unavailable. */
  token(): string { return ''; }

  hasValidToken(clockSkewSeconds = 5): boolean {
    const now = Math.floor(Date.now() / 1000) + clockSkewSeconds;
    return !this.loginRequired() && Boolean(this.subject()) && this.tokenExp() > now && this.idleExp() > now;
  }

  isTokenExpired(): boolean { return !this.hasValidToken(); }
  accountUrl(): string { return '/me?tab=security'; }

  touchSession(): void {
    if (!this.subject() || !this.tokenExp()) return;
    this.idleExp.set(Math.min(this.tokenExp(), Math.floor(Date.now() / 1000) + 30 * 60));
  }

  async init(): Promise<void> {
    if (this.consumePasswordRecoveryRedirect()) return;
    if (window.location.pathname === '/auth/recovery') {
      this.passwordRecoveryState.set('error');
      this.passwordRecoveryMessage.set('비밀번호 설정 링크가 없거나 만료되었습니다. 관리자에게 새 링크를 요청하세요.');
      this.loginRequired.set(false);
      return;
    }
    if (await this.adoptLegacySession()) return;
    try {
      await this.refreshAuthorization();
      this.loginRequired.set(false);
      return;
    } catch (error) {
      if (this.statusOf(error) !== 401) throw error;
    }

    // A missing browser session is the only reason to ask whether first-time
    // setup is required. Bootstrap status is not a session authority and must
    // never eject an already authenticated operator from the Shell.
    this.clearIdentity();
    try {
      if (await this.refreshInitialSetup()) return;
      this.authorityWarning.set('');
    } catch (error) {
      this.authorityWarning.set(String(error instanceof Error ? error.message : error));
    }
    this.loginRequired.set(true);
  }

  private async adoptLegacySession(): Promise<boolean> {
    if (this.cookieValue('__Host-opensphere_csrf')) return false;
    let legacy: { refresh_token?: string } | null = null;
    try {
      legacy = JSON.parse(window.sessionStorage.getItem('opensphere.supabase.session') || 'null') as { refresh_token?: string } | null;
    } catch {
      legacy = null;
    }
    if (!legacy?.refresh_token) return false;
    try {
      const body = await this.api<{ mfaRequired?: boolean; session?: BrowserSession }>(
        '/api/identity/session/adopt',
        {
          method: 'POST',
          body: JSON.stringify({ refreshToken: legacy.refresh_token }),
        },
        false,
      );
      this.currentSession.set(body.session || null);
      this.mfaRequired.set(Boolean(body.mfaRequired));
      if (body.mfaRequired) {
        this.loginRequired.set(true);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      // The refresh credential was either rotated or rejected. Never leave a
      // second browser-readable copy after the one-time migration attempt.
      try { window.sessionStorage.removeItem('opensphere.supabase.session'); } catch { /* storage unavailable */ }
    }
  }

  async login(email: string, password: string, duration = this.sessionDurationPreference()): Promise<void> {
    this.mfaEnrollmentRequired.set(false);
    const selected = this.normalizeDuration(duration);
    const body = await this.api<{
      mfaRequired?: boolean;
      mfaEnrollmentRequired?: boolean;
      session?: BrowserSession;
    }>('/api/identity/session/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), password, duration: selected }),
    }, false);
    this.sessionDurationPreference.set(selected);
    this.saveDurationPreference(selected);
    this.currentSession.set(body.session || null);
    this.mfaRequired.set(Boolean(body.mfaRequired));
    this.mfaEnrollmentRequired.set(Boolean(body.mfaEnrollmentRequired));
    if (body.mfaRequired) {
      this.loginRequired.set(true);
      return;
    }
    await this.refreshAuthorization();
    this.loginRequired.set(false);
  }

  async finishMfaLogin(code: string): Promise<void> {
    await this.api('/api/identity/session/mfa', {
      method: 'POST',
      body: JSON.stringify({ code: String(code || '').trim() }),
    });
    this.mfaRequired.set(false);
    this.mfaEnrollmentRequired.set(false);
    await this.refreshAuthorization();
    this.loginRequired.set(false);
  }

  cancelMfaLogin(): void {
    void this.api('/api/identity/session', { method: 'DELETE' }).catch(() => undefined);
    this.mfaRequired.set(false);
    this.clearIdentity();
    this.loginRequired.set(true);
  }

  async beginTotpEnrollment(friendlyName = 'OpenSphere Console'): Promise<TotpEnrollment> {
    const enrollment = await this.api<{ factorId: string; qrCode?: string; secret: string; uri?: string }>(
      '/api/identity/session/totp/enrollment',
      { method: 'POST', body: JSON.stringify({ friendlyName }) },
    );
    if (!enrollment.factorId || !enrollment.secret) throw new Error('Supabase Auth가 TOTP 등록 정보를 반환하지 않았습니다.');
    const uri = enrollment.uri || '';
    return {
      factorId: enrollment.factorId,
      qrCode: await createTotpQrCode(enrollment.qrCode, uri),
      secret: enrollment.secret,
      uri,
    };
  }

  async verifyTotpEnrollment(factorId: string, code: string): Promise<void> {
    await this.api('/api/identity/session/totp/verification', {
      method: 'POST',
      body: JSON.stringify({ factorId, code: String(code || '').trim() }),
    });
    this.mfaEnrollmentRequired.set(false);
    await this.refreshAuthorization();
  }

  async loadBrowserSessions(): Promise<BrowserSession[]> {
    const result = await this.api<{ items?: BrowserSession[] }>('/api/identity/sessions', { cache: 'no-store' });
    const items = Array.isArray(result.items) ? result.items : [];
    this.browserSessions.set(items);
    this.currentSession.set(items.find((item) => item.current) || this.currentSession());
    return items;
  }

  async loadSessionEvents(): Promise<SessionEvent[]> {
    const result = await this.api<{ items?: SessionEvent[] }>('/api/identity/session/events?limit=50', { cache: 'no-store' });
    const items = Array.isArray(result.items) ? result.items : [];
    this.sessionEvents.set(items);
    return items;
  }

  async revokeBrowserSession(id: string): Promise<void> {
    await this.api(`/api/identity/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (this.currentSession()?.id === id) {
      this.clearIdentity();
      this.loginRequired.set(true);
      this.broadcastSessionEnded();
      return;
    }
    await this.loadBrowserSessions();
  }

  async revokeAllBrowserSessions(): Promise<void> {
    await this.api('/api/identity/sessions', { method: 'DELETE' });
    this.clearIdentity();
    this.loginRequired.set(true);
    this.broadcastSessionEnded();
  }

  async reAuthenticate(): Promise<void> {
    this.clearIdentity();
    this.loginRequired.set(true);
  }

  async shouldReauthenticateAfterUnauthorized(): Promise<boolean> {
    try {
      await this.refreshAuthorization();
      this.loginRequired.set(false);
      return false;
    } catch (error) {
      // A 401 from the identity authority is the only authoritative proof that
      // the opaque browser session ended. A downstream service 401 or a
      // temporary identity outage must not erase a still-valid login.
      if (this.statusOf(error) !== 401) return false;
      this.clearIdentity();
      this.loginRequired.set(true);
      return true;
    }
  }

  async logout(): Promise<void> {
    await this.api('/api/identity/session', { method: 'DELETE' }).catch(() => undefined);
    this.clearIdentity();
    this.loginRequired.set(true);
    this.broadcastSessionEnded();
  }

  requestStepUp(): void {
    this.stepUpError.set('');
    this.stepUpRequired.set(true);
  }

  cancelStepUp(): void {
    this.stepUpError.set('');
    this.stepUpRequired.set(false);
  }

  async completeStepUp(code: string): Promise<void> {
    this.stepUpBusy.set(true);
    this.stepUpError.set('');
    try {
      await this.api('/api/identity/session/step-up', {
        method: 'POST',
        body: JSON.stringify({ code: String(code || '').trim() }),
      });
      await this.refreshAuthorization();
      this.stepUpRequired.set(false);
    } catch (error) {
      this.stepUpError.set(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.stepUpBusy.set(false);
    }
  }

  async completePasswordRecovery(password: string, passwordConfirm: string): Promise<void> {
    if (this.passwordRecoveryState() !== 'ready' || !this.passwordRecoveryToken) {
      throw new Error('비밀번호 설정 링크가 없거나 만료되었습니다.');
    }
    if (password.length < 12) throw new Error('새 비밀번호는 12자 이상이어야 합니다.');
    if (password !== passwordConfirm) throw new Error('새 비밀번호와 확인 값이 일치하지 않습니다.');
    const token = this.passwordRecoveryToken;
    const response = await fetch('/auth/v1/user', {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ password }),
    });
    const body = await response.json().catch(() => ({})) as ApiError;
    if (!response.ok) throw new Error(this.errorText(body, response.status));
    this.passwordRecoveryToken = '';
    await fetch('/auth/v1/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
    this.passwordRecoveryMessage.set('비밀번호가 설정되었습니다. 새 비밀번호로 로그인하세요.');
    this.passwordRecoveryState.set('completed');
  }

  leavePasswordRecovery(): void {
    this.passwordRecoveryToken = '';
    this.passwordRecoveryMessage.set('');
    this.passwordRecoveryState.set('idle');
    this.clearIdentity();
    window.history.replaceState(null, document.title, '/');
    this.loginRequired.set(true);
  }

  async refreshInitialSetup(): Promise<boolean> {
    const response = await fetch('/api/identity/bootstrap/status', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`최초 관리자 상태 확인 실패: HTTP ${response.status}`);
    const body = await response.json() as { state?: string; username?: string; displayName?: string; email?: string };
    this.setupBusy.set(body.state === 'busy');
    this.setupRequired.set(body.state === 'required' || body.state === 'busy');
    if (body.state === 'required') {
      this.setupDefaults.set({
        username: body.username || 'opensphere-admin',
        displayName: body.displayName || 'OpenSphere Administrator',
        email: body.email || 'admin@opensphere.local',
      });
    }
    return this.setupRequired();
  }

  async completeInitialSetup(): Promise<void> {
    this.setupRequired.set(false);
    this.setupBusy.set(false);
    this.loginRequired.set(!this.hasValidToken());
  }

  private consumePasswordRecoveryRedirect(): boolean {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(window.location.search);
    const type = fragment.get('type') || query.get('type');
    const error = fragment.get('error_description') || query.get('error_description')
      || fragment.get('error') || query.get('error');
    if (type !== 'recovery' && !error) return false;

    this.clearIdentity();
    window.history.replaceState(null, document.title, '/auth/recovery');
    if (error) {
      this.passwordRecoveryState.set('error');
      this.passwordRecoveryMessage.set(decodeURIComponent(error.replace(/\+/g, ' ')));
      this.loginRequired.set(false);
      return true;
    }

    const token = fragment.get('access_token') || '';
    const exp = this.jwtExp(token);
    if (!token || !exp || exp <= Math.floor(Date.now() / 1000) + 5) {
      this.passwordRecoveryState.set('error');
      this.passwordRecoveryMessage.set('비밀번호 설정 링크가 없거나 만료되었습니다. 관리자에게 새 링크를 요청하세요.');
      this.loginRequired.set(false);
      return true;
    }
    this.passwordRecoveryToken = token;
    this.passwordRecoveryMessage.set('');
    this.passwordRecoveryState.set('ready');
    this.loginRequired.set(false);
    return true;
  }

  private async refreshAuthorization(): Promise<void> {
    const response = await fetch('/api/identity/session', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => ({})) as SessionProjection;
    if (!response.ok) throw Object.assign(new Error(body.error || '콘솔 권한을 확인하지 못했습니다.'), { status: response.status });
    const groups = Array.isArray(body.groups)
      ? body.groups.map((group) => String(group).trim()).filter(Boolean)
      : [];
    this.subject.set(String(body.subject || ''));
    this.user.set(String(body.username || body.email || body.subject || ''));
    this.email.set(String(body.email || ''));
    this.name.set(String(body.displayName || ''));
    this.groups.set(groups);
    this.roles.set(groups);
    this.assurance.set(body.assurance === 'aal2' ? 'aal2' : 'aal1');
    this.currentSession.set(body.session || null);
    this.authorityWarning.set(body.authorityDegraded ? 'Supabase authorization state unavailable; cached read-only session is active.' : '');
    this.tokenExp.set(this.epoch(body.session?.absoluteExpiresAt));
    this.idleExp.set(this.epoch(body.session?.idleExpiresAt));
  }

  private async api<T = Record<string, unknown>>(path: string, init: RequestInit = {}, csrf = true): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const method = String(init.method || 'GET').toUpperCase();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const value = this.cookieValue('__Host-opensphere_csrf');
      if (value) headers.set('X-OS-CSRF-Token', value);
    }
    const response = await fetch(path, { ...init, headers });
    const body = await response.json().catch(() => ({})) as T & ApiError;
    if (!response.ok) throw Object.assign(new Error(this.errorText(body, response.status)), { status: response.status });
    return body;
  }

  private cookieValue(name: string): string {
    const prefix = `${name}=`;
    const item = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
  }

  private clearIdentity(): void {
    this.user.set('');
    this.groups.set([]);
    this.roles.set([]);
    this.email.set('');
    this.name.set('');
    this.subject.set('');
    this.tokenExp.set(0);
    this.idleExp.set(0);
    this.assurance.set('aal1');
    this.currentSession.set(null);
    this.browserSessions.set([]);
    this.mfaRequired.set(false);
    this.mfaEnrollmentRequired.set(false);
    this.stepUpRequired.set(false);
    this.stepUpError.set('');
  }

  private broadcastSessionEnded(): void {
    this.sessionChannel?.postMessage({ type: 'session-ended', at: new Date().toISOString() });
  }

  private normalizeDuration(value: SessionDuration): SessionDuration {
    return ['browser', '8h', '24h', '7d'].includes(value) ? value : '8h';
  }

  private loadDurationPreference(): SessionDuration {
    try { return this.normalizeDuration((localStorage.getItem('opensphere.session.duration') || '8h') as SessionDuration); }
    catch { return '8h'; }
  }

  private saveDurationPreference(value: SessionDuration): void {
    try { localStorage.setItem('opensphere.session.duration', value); } catch { /* optional preference */ }
  }

  private errorText(body: ApiError, status: number): string {
    return body.error_description || body.msg || body.message || body.error || `HTTP ${status}`;
  }

  private statusOf(error: unknown): number {
    return Number((error as { status?: number })?.status || 0);
  }

  private epoch(value?: string): number {
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
  }

  private jwtClaim(token: string, claim: string): unknown {
    try {
      const encoded = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') || '';
      return JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')))[claim];
    } catch { return undefined; }
  }

  private jwtExp(token: string): number { return Number(this.jwtClaim(token, 'exp') || 0); }
}
