import { Injectable, signal } from '@angular/core';

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  user?: {
    id?: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
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
  readonly initError = signal('');
  readonly setupRequired = signal(false);
  readonly setupBusy = signal(false);
  readonly setupDefaults = signal({ username: 'opensphere-admin', displayName: 'OpenSphere Administrator', email: 'admin@opensphere.local' });
  readonly loginRequired = signal(false);

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
    const body = await response.json().catch(() => ({})) as SupabaseSession & { msg?: string; message?: string; error_description?: string };
    if (!response.ok) throw new Error(body.error_description || body.msg || body.message || '로그인에 실패했습니다.');
    if (!this.apply(body)) throw new Error('인증 서비스가 유효한 세션을 반환하지 않았습니다.');
    this.saveSession(body);
    await this.refreshAuthorization();
    this.loginRequired.set(false);
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
    this.loginRequired.set(true);
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
    try { window.sessionStorage.removeItem(this.sessionKey); } catch { /* storage unavailable */ }
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
}
