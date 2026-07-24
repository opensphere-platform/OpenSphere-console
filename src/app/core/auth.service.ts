import { Injectable, signal } from '@angular/core';
import { normalizeTotpQrCode } from './totp-qr';

interface SupabaseMfaFactor {
  id: string;
  status?: string;
  factor_type?: string;
  friendly_name?: string;
}

interface SupabaseUser {
  id?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  factors?: SupabaseMfaFactor[];
}

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  user?: SupabaseUser;
}

interface SupabaseMfaFactors {
  all?: SupabaseMfaFactor[];
  totp?: SupabaseMfaFactor[];
}

interface SupabaseMfaEnrollment extends SupabaseMfaFactor {
  totp?: {
    qr_code?: string;
    secret?: string;
    uri?: string;
  };
}

interface SupabaseAuthError {
  error?: string;
  error_code?: string;
  error_description?: string;
  msg?: string;
  message?: string;
}

export interface TotpEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
}

/**
 * Console identity authority is Supabase Auth.  Tokens are kept per browser
 * tab and are never exchanged through a parallel identity provider.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly sessionKey = 'opensphere.supabase.session';
  private accessToken = '';

  readonly user = signal('');
  readonly groups = signal<string[]>([]);
  readonly roles = signal<string[]>([]);
  readonly email = signal('');
  readonly name = signal('');
  readonly subject = signal('');
  readonly tokenExp = signal(0);
  readonly assurance = signal<'aal1' | 'aal2'>('aal1');
  readonly mfaRequired = signal(false);
  readonly initError = signal('');
  readonly setupRequired = signal(false);
  readonly setupBusy = signal(false);
  readonly setupDefaults = signal({ username: 'opensphere-admin', displayName: 'OpenSphere Administrator', email: 'admin@opensphere.local' });
  readonly loginRequired = signal(false);
  private pendingMfaSession: SupabaseSession | null = null;
  private pendingMfaFactorId = '';

  setInitError(error: unknown): void {
    this.initError.set(String(error instanceof Error ? error.message : error || '인증 초기화 실패'));
  }

  token(): string { return this.accessToken; }

  hasValidToken(clockSkewSeconds = 5): boolean {
    return Boolean(this.accessToken) && this.tokenExp() > Math.floor(Date.now() / 1000) + clockSkewSeconds;
  }

  isTokenExpired(): boolean { return !this.hasValidToken(); }

  accountUrl(): string { return '/me?tab=security'; }

  async init(): Promise<void> {
    if (await this.refreshInitialSetup()) return;
    const existing = this.loadSession();
    if (existing && this.apply(existing)) {
      await this.refreshAuthorization();
      this.loginRequired.set(false);
      return;
    }
    this.clearSession();
    this.loginRequired.set(true);
  }

  async login(email: string, password: string): Promise<void> {
    const response = await fetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const body = await response.json().catch(() => ({})) as SupabaseSession & SupabaseAuthError;
    if (!response.ok) throw new Error(body.error_description || body.msg || body.message || '로그인에 실패했습니다.');
    if (!body.access_token) throw new Error('인증 서비스가 유효한 세션을 반환하지 않았습니다.');

    if (this.jwtAssurance(body.access_token) !== 'aal2') {
      const factors = await this.listMfaFactors(body.access_token);
      const verifiedTotp = this.factorItems(factors)
        .find((factor) => factor.factor_type === 'totp' && factor.status === 'verified');
      if (verifiedTotp?.id) {
        this.pendingMfaSession = body;
        this.pendingMfaFactorId = verifiedTotp.id;
        this.mfaRequired.set(true);
        this.loginRequired.set(true);
        return;
      }
    }

    await this.activateSession(body);
  }

  async finishMfaLogin(code: string): Promise<void> {
    const pending = this.pendingMfaSession;
    const factorId = this.pendingMfaFactorId;
    if (!pending?.access_token || !factorId) throw new Error('MFA 로그인 세션이 없습니다. 다시 로그인하세요.');
    const session = await this.challengeAndVerify(factorId, code, pending.access_token);
    this.pendingMfaSession = null;
    this.pendingMfaFactorId = '';
    this.mfaRequired.set(false);
    await this.activateSession(session);
  }

  cancelMfaLogin(): void {
    this.pendingMfaSession = null;
    this.pendingMfaFactorId = '';
    this.mfaRequired.set(false);
    this.clearSession();
    this.loginRequired.set(true);
  }

  async beginTotpEnrollment(friendlyName = 'OpenSphere Console'): Promise<TotpEnrollment> {
    if (!this.accessToken) throw new Error('TOTP 등록을 시작하려면 먼저 로그인해야 합니다.');
    const factors = await this.listMfaFactors(this.accessToken);
    const verified = this.factorItems(factors)
      .find((factor) => factor.factor_type === 'totp' && factor.status === 'verified');
    if (verified) throw new Error('이미 검증된 TOTP 인증기가 등록되어 있습니다.');

    const enrollment = await this.authJson<SupabaseMfaEnrollment>('/auth/v1/factors', {
      method: 'POST',
      body: JSON.stringify({ factor_type: 'totp', friendly_name: friendlyName.slice(0, 64) }),
    }, this.accessToken);
    if (!enrollment.id || !enrollment.totp?.secret) throw new Error('Supabase Auth가 TOTP 등록 정보를 반환하지 않았습니다.');
    return {
      factorId: enrollment.id,
      qrCode: normalizeTotpQrCode(enrollment.totp.qr_code),
      secret: enrollment.totp.secret,
      uri: enrollment.totp.uri || '',
    };
  }

  async verifyTotpEnrollment(factorId: string, code: string): Promise<void> {
    if (!this.accessToken) throw new Error('TOTP 등록 세션이 만료되었습니다. 다시 로그인하세요.');
    const session = await this.challengeAndVerify(factorId, code, this.accessToken);
    await this.activateSession(session);
  }

  async reAuthenticate(): Promise<void> {
    this.clearSession();
    this.loginRequired.set(true);
  }

  async logout(): Promise<void> {
    const token = this.accessToken;
    this.clearSession();
    if (token) {
      await fetch('/auth/v1/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    }
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

  private apply(session: SupabaseSession): boolean {
    const exp = Number(session.expires_at || this.jwtExp(session.access_token) || 0);
    if (!session.access_token || exp <= Math.floor(Date.now() / 1000) + 5) return false;
    const metadata = session.user?.user_metadata ?? {};
    this.accessToken = session.access_token;
    this.subject.set(String(session.user?.id || this.jwtSubject(session.access_token) || ''));
    this.email.set(String(session.user?.email || this.jwtClaim(session.access_token, 'email') || ''));
    this.name.set(String(metadata['display_name'] || metadata['full_name'] || ''));
    this.user.set(String(metadata['preferred_username'] || this.email() || this.subject()));
    // Supabase access tokens authenticate the user. Console authorization is
    // evaluated server-side from console.operator_role and loaded below.
    this.groups.set([]);
    this.roles.set([]);
    this.tokenExp.set(exp);
    this.assurance.set(this.jwtAssurance(session.access_token));
    return true;
  }

  private loadSession(): SupabaseSession | null {
    try { return JSON.parse(window.sessionStorage.getItem(this.sessionKey) || 'null') as SupabaseSession | null; }
    catch { return null; }
  }

  private saveSession(session: SupabaseSession): void {
    try { window.sessionStorage.setItem(this.sessionKey, JSON.stringify(session)); } catch { /* storage unavailable */ }
  }

  private clearSession(): void {
    this.accessToken = '';
    this.user.set(''); this.groups.set([]); this.roles.set([]); this.email.set(''); this.name.set(''); this.subject.set(''); this.tokenExp.set(0);
    this.assurance.set('aal1');
    this.pendingMfaSession = null;
    this.pendingMfaFactorId = '';
    this.mfaRequired.set(false);
    try { window.sessionStorage.removeItem(this.sessionKey); } catch { /* storage unavailable */ }
  }

  private async activateSession(session: SupabaseSession): Promise<void> {
    if (!this.apply(session)) throw new Error('인증 서비스가 유효한 세션을 반환하지 않았습니다.');
    this.saveSession(session);
    await this.refreshAuthorization();
    this.loginRequired.set(false);
  }

  private async listMfaFactors(token: string): Promise<SupabaseMfaFactors> {
    // GoTrue exposes factor enrollment/challenge operations under /factors,
    // but the authenticated factor list is part of the /user response.
    const user = await this.authJson<SupabaseUser>('/auth/v1/user', { method: 'GET' }, token);
    const all = Array.isArray(user.factors) ? user.factors : [];
    return {
      all,
      totp: all.filter((factor) => factor.factor_type === 'totp'),
    };
  }

  private factorItems(factors: SupabaseMfaFactors): SupabaseMfaFactor[] {
    const values = [...(factors.all || []), ...(factors.totp || [])];
    return [...new Map(values.filter((factor) => factor?.id).map((factor) => [factor.id, factor])).values()];
  }

  private async challengeAndVerify(factorId: string, code: string, token: string): Promise<SupabaseSession> {
    if (!/^\d{6}$/.test(String(code || '').trim())) throw new Error('현재 6자리 인증 코드를 입력하세요.');
    const challenge = await this.authJson<{ id?: string }>(`/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`, {
      method: 'POST',
      body: '{}',
    }, token);
    if (!challenge.id) throw new Error('MFA challenge를 생성하지 못했습니다.');
    const verified = await this.authJson<SupabaseSession & { session?: SupabaseSession }>(`/auth/v1/factors/${encodeURIComponent(factorId)}/verify`, {
      method: 'POST',
      body: JSON.stringify({ challenge_id: challenge.id, code: String(code).trim() }),
    }, token);
    const session = verified.session || verified;
    if (!session.access_token || this.jwtAssurance(session.access_token) !== 'aal2') {
      throw new Error('Supabase Auth가 AAL2 세션을 반환하지 않았습니다.');
    }
    return session;
  }

  private async authJson<T>(path: string, init: RequestInit, token: string): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({})) as T & SupabaseAuthError;
    if (!response.ok) {
      throw new Error(body.error_description || body.msg || body.message || body.error_code || body.error || `Supabase Auth HTTP ${response.status}`);
    }
    return body;
  }

  /**
   * Console navigation must use the same evaluated role set as the backend.
   * In particular, the first bootstrap operator is an administrator even
   * though that role is not embedded in a generic Supabase access token.
   */
  private async refreshAuthorization(): Promise<void> {
    const response = await fetch('/api/identity/session', {
      cache: 'no-store',
      headers: { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' },
    });
    const body = await response.json().catch(() => ({})) as { groups?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error || '콘솔 권한을 확인하지 못했습니다.');
    const groups = Array.isArray(body.groups)
      ? body.groups.map((group) => String(group).trim()).filter(Boolean)
      : [];
    this.groups.set(groups);
    this.roles.set(groups);
  }

  private jwtClaim(token: string, claim: string): unknown {
    try {
      const encoded = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') || '';
      return JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')))[claim];
    } catch { return undefined; }
  }

  private jwtExp(token: string): number { return Number(this.jwtClaim(token, 'exp') || 0); }
  private jwtSubject(token: string): string { return String(this.jwtClaim(token, 'sub') || ''); }
  private jwtAssurance(token: string): 'aal1' | 'aal2' {
    return this.jwtClaim(token, 'aal') === 'aal2' ? 'aal2' : 'aal1';
  }
}
