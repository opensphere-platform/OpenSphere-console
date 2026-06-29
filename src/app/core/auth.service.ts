import { Injectable, signal } from '@angular/core';
import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';

/**
 * 플랫폼 관리 평면 인증 — 콘솔 break-glass IdP **Kanidm**(OIDC public client, PKCE S256, ES256).
 * ADR-FND-003: 콘솔 로그인은 Foundation 내부 Keycloak에 의존하지 않는다(복구 자립). 워크포스/사용자
 * 신원은 Keycloak/Syncope 단일권위 유지 — 여기(콘솔)는 플랫폼 관리자 break-glass 전용.
 * 이전: keycloak-js(opensphere-admin). 전환: 범용 OIDC(oidc-client-ts) + Kanidm discovery.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly returnUrlKey = 'opensphere.auth.returnUrl';
  // Kanidm OIDC discovery authority(= 브라우저 발급 issuer). discovery: <authority>/.well-known/openid-configuration.
  // localhost는 secure context라 http 셸에서도 PKCE(crypto.subtle) 동작.
  private readonly authority = 'https://auth.console.opensphere.dev/oauth2/openid/opensphere-console';
  private mgr = new UserManager({
    authority: this.authority,
    client_id: 'opensphere-console',
    redirect_uri: window.location.origin + '/',
    post_logout_redirect_uri: window.location.origin + '/',
    response_type: 'code', // Authorization Code + PKCE(S256, 기본 ON)
    scope: 'openid profile email groups_name groups', // groups → Kanidm 네이티브 groups 클레임(그룹 SPN, 하이픈 보존). groups_name은 호환 유지.
    loadUserInfo: false, // groups/profile은 id_token에 포함(Kanidm), 추가 userinfo 불필요
    automaticSilentRenew: false, // Kanidm 무iframe-renew 권장 — 만료 시 재로그인
    // 감사 P1-2: 토큰 저장을 sessionStorage로(탭/브라우저 종료 시 소멸 → XSS 탈취 지속창 축소).
    // 같은 탭의 OIDC 리다이렉트 왕복·새로고침은 보존(stateStore는 기본 유지). httpOnly-cookie BFF 세션은 후속.
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });

  readonly user = signal<string>('');
  /** 토큰 claim의 그룹 — perspective 정책 게이트(OPA-ready)의 입력 */
  readonly groups = signal<string[]>([]);
  /** Kanidm은 realm_access.roles 없음 — 호환 위해 빈 배열(정책은 groups로 판단) */
  readonly roles = signal<string[]>([]);
  /** My Info용 프로필 클레임 */
  readonly email = signal<string>('');
  readonly name = signal<string>('');
  readonly subject = signal<string>('');
  /** 토큰 만료(epoch sec) */
  readonly tokenExp = signal<number>(0);

  /** 플러그인 백엔드에 넘기는 토큰(=id_token, groups 포함; Kanidm access_token엔 groups 없음) */
  private idToken = '';
  /** 콘솔 컴포넌트가 BFF(/bff/roles 등) 호출 시 쓰는 현재 id_token */
  token(): string {
    return this.idToken;
  }

  /** Kanidm 셀프서비스(비밀번호·passkey·TOTP 관리) UI */
  accountUrl(): string {
    return 'https://auth.console.opensphere.dev/ui';
  }

  /** 앱 부트스트랩 전 로그인 강제 (Authorization Code + PKCE S256) */
  async init(): Promise<void> {
    const qs = window.location.search;
    // ① 인가코드 리다이렉트 콜백 복귀
    if (/[?&](code|error)=/.test(qs) && /[?&]state=/.test(qs)) {
      try {
        const u = await this.mgr.signinRedirectCallback();
        window.history.replaceState({}, document.title, this.callbackReturnUrl(u));
        this.apply(u);
        return;
      } catch {
        // 콜백 실패(상태 불일치/만료 등) → 깨끗이 비우고 재로그인
        window.history.replaceState({}, document.title, window.location.origin + '/');
      }
    }
    // ② 기존 세션
    const existing = await this.mgr.getUser();
    if (existing && !existing.expired) {
      this.apply(existing);
      return;
    }
    // ③ 미인증 → 로그인 리다이렉트(여기서 페이지 이탈; 아래 Promise는 미해결로 유지)
    const returnUrl = this.currentReturnUrl();
    try {
      window.sessionStorage.setItem(this.returnUrlKey, returnUrl);
    } catch {
      /* ignore */
    }
    await this.mgr.signinRedirect({ state: { returnUrl } });
    await new Promise<void>(() => {});
  }

  private currentReturnUrl(): string {
    const path = `${window.location.pathname || '/'}${window.location.search || ''}${window.location.hash || ''}`;
    return this.safeReturnUrl(path);
  }

  private callbackReturnUrl(u: User): string {
    const state = u.state as { returnUrl?: unknown } | string | undefined;
    const fromState = typeof state === 'string' ? state : typeof state?.returnUrl === 'string' ? state.returnUrl : '';
    let fromStorage = '';
    try {
      fromStorage = window.sessionStorage.getItem(this.returnUrlKey) || '';
      window.sessionStorage.removeItem(this.returnUrlKey);
    } catch {
      /* ignore */
    }
    return window.location.origin + this.safeReturnUrl(fromState || fromStorage || '/');
  }

  private safeReturnUrl(value: string): string {
    if (!value || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return '/';
    return value.startsWith('/') ? value : `/${value}`;
  }

  private apply(u: User): void {
    this.idToken = u.id_token ?? '';
    const p = (u.profile ?? {}) as Record<string, unknown>;
    this.user.set(String(p['preferred_username'] ?? p['name'] ?? 'unknown'));
    // Kanidm groups: groups_name 스코프면 깔끔한 이름. 방어적으로 선행 '/'·'@domain' 제거 + uuid 형태 제외.
    const raw = Array.isArray(p['groups']) ? (p['groups'] as unknown[]) : [];
    const groups = raw
      .map((g) => String(g).replace(/^\//, '').replace(/@.*$/, ''))
      .filter((g) => g && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(g));
    this.groups.set(groups);
    this.roles.set([]);
    this.email.set(String(p['email'] ?? ''));
    this.name.set(String(p['name'] ?? [p['given_name'], p['family_name']].filter(Boolean).join(' ')));
    this.subject.set(String(p['sub'] ?? ''));
    this.tokenExp.set(Number(p['exp'] ?? 0));

    // DUPA: 흡수 플러그인(예: k8s-console, foundation-shell)이 사용자 신원을 백엔드로 전달해 사용자 단위
    // RBAC(impersonation)을 쓰도록 현재 사용자 토큰을 노출한다. **id_token**(ES256, aud/azp=opensphere-console,
    // groups 포함)이며, 신뢰 게이트(기능 컨테이너)가 Kanidm JWKS로 검증·사용자/그룹 추출에 사용한다.
    // ⚠️ 감사 P1-2(후속): 이 전역은 현재 모든 subShell의 토큰 브리지다. 완전 제거하려면 Shell 소유
    //   프록시(ctx.api.fetch에서 셸이 Authorization 주입 → plugin은 raw 토큰 미접근)로 subShell들을
    //   이식해야 한다(별도 repo). 그 전까지 back-compat 유지. localStorage→sessionStorage는 위에서 적용.
    (window as Window & { __OS_AUTH__?: unknown }).__OS_AUTH__ = {
      user: () => this.user(),
      token: () => this.idToken,
    };
  }

  async logout(): Promise<void> {
    // OIDC RP-initiated logout(end_session_endpoint + post_logout_redirect_uri).
    // Kanidm SSO 세션쿠키를 끊고 console.opensphere.dev/ 로 복귀 → 콘솔이 세션 없음을 감지해
    // 정상 OIDC 로그인 플로우를 재시작한다(Kanidm /ui/apps로 빠지는 문제 차단).
    // no-cors fetch로 /ui/logout을 직접 호출하면 opaque 응답이라 Set-Cookie 미적용 → 무력화됨.
    try {
      await this.mgr.removeUser();
    } catch {
      /* ignore */
    }
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      /* ignore */
    }
    // signoutRedirect: discovery의 end_session_endpoint + post_logout_redirect_uri 사용.
    // Kanidm 1.4.6이 end_session_endpoint를 미지원하면 폴백으로 /ui/logout으로 이동.
    try {
      await this.mgr.signoutRedirect({ post_logout_redirect_uri: window.location.origin + '/' });
    } catch {
      window.location.assign(new URL(this.authority).origin + '/ui/logout');
    }
  }
}
