'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const backend = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const deploy = fs.readFileSync(path.join(__dirname, 'deploy.yaml'), 'utf8');
const notificationDeploy = fs.readFileSync(path.join(root, 'backend/notification-dispatcher/deploy.yaml'), 'utf8');
const authService = fs.readFileSync(path.join(root, 'src/app/core/auth.service.ts'), 'utf8');
const httpService = fs.readFileSync(path.join(root, 'src/app/core/http.service.ts'), 'utf8');
const browserSession = fs.readFileSync(path.join(__dirname, 'browser-session.js'), 'utf8');
const login = fs.readFileSync(path.join(root, 'src/app/pages/login.ts'), 'utf8');
const nginx = fs.readFileSync(path.join(root, 'nginx/default.conf.template'), 'utf8');
const setup = fs.readFileSync(path.join(root, 'src/app/pages/initial-setup.ts'), 'utf8');
const myInfo = fs.readFileSync(path.join(root, 'src/app/pages/my-info.ts'), 'utf8');
const osShell = fs.readFileSync(path.join(root, 'src/app/os/os-shell.ts'), 'utf8');
const profileAvatar = fs.readFileSync(path.join(__dirname, 'profile-avatar.js'), 'utf8');
const consoleAdmins = fs.readFileSync(path.join(root, 'src/app/pages/console-admins.ts'), 'utf8');
const recoveryPage = fs.readFileSync(path.join(root, 'src/app/pages/password-recovery.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app/app.ts'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/app/app.routes.ts'), 'utf8');
const supabaseManifest = fs.readFileSync(path.join(root, 'backend/supabase/bootstrap/supabase.yaml'), 'utf8');

test('administrator mutations require a real AAL2 session by default', () => {
  assert.match(backend, /SUPABASE_REQUIRE_AAL2 \|\| 'true'/);
  assert.match(backend, /SUPABASE_REQUIRE_AAL2 && isMutationRequest\(req\)/);
  assert.match(backend, /requires MFA assurance aal2 verified within the last 5 minutes/);
  assert.match(backend, /requireRecentAal2/);
  assert.match(deploy, /name: SUPABASE_REQUIRE_AAL2, value: "true"/);
  assert.match(deploy, /name: NOTIFICATION_REQUIRE_AAL2, value: "true"/);
});

test('Extension install and update read the mounted development edge policy and all other mutations retain MFA', () => {
  assert.match(backend, /readInstallationPolicy\(INSTALLATION_CONFIG_FILE\)/);
  assert.match(backend, /moduleLifecycleNeedsRecentAal2\(routePolicy\.lifecycleAction\)/);
  assert.match(backend, /permission: 'extensions\.read', risk: 'R0', readOnly: true/);
  assert.match(backend, /!routePolicy\.readOnly && isMutationRequest\(req\)/);
  assert.match(backend, /install\|enable\|disable\|uninstall\|rollback/);
  assert.match(deploy, /mountPath: \/var\/run\/opensphere-installation/);
  assert.match(deploy, /name: opensphere-installation-lock/);
  assert.match(deploy, /optional: true/);
});

test('CLI sessions and PATs cannot manufacture Supabase AAL2 assurance', () => {
  const actorProjection = backend.slice(
    backend.indexOf('async function resolveConsoleActor'),
    backend.indexOf('async function verifyManagedCliToken'),
  );
  assert.match(actorProjection, /assurance: 'aal1'/);
  assert.doesNotMatch(actorProjection, /assurance: 'aal2'/);
});

test('browser login and bootstrap complete the Supabase TOTP challenge', () => {
  assert.match(authService, /finishMfaLogin/);
  assert.match(authService, /beginTotpEnrollment/);
  assert.match(authService, /\/api\/identity\/session\/mfa/);
  assert.match(authService, /\/api\/identity\/session\/totp\/enrollment/);
  assert.match(browserSession, /\/factors\/\$\{encodeURIComponent\(factorState\.verifiedTotp\.id\)\}\/challenge/);
  assert.match(browserSession, /claims\.assurance !== 'aal2'/);
  assert.doesNotMatch(authService, /\/auth\/v1\/factors/);
  assert.match(login, /auth\.mfaRequired\(\)/);
  assert.match(login, /auth\.finishMfaLogin/);
  assert.match(setup, /auth\.beginTotpEnrollment/);
  assert.match(setup, /auth\.verifyTotpEnrollment/);
});

test('administrator OTP reset is AAL2, cross-operator, audited, and revokes verified factors server-side', () => {
  assert.match(backend, /\/mfa\\\/reset/);
  assert.match(backend, /actor = await verifyActor\(req\)/);
  assert.match(backend, /actor\.sub === userId/);
  assert.match(backend, /본인 OTP는 다른 관리자가 연결 해제해야 합니다/);
  assert.match(backend, /\/admin\/users\/\$\{userId\}\/factors\/\$\{encodeURIComponent\(factor\.id\)\}/);
  assert.match(backend, /'iga-mfa-reset'/);
  assert.match(backend, /'mfa-reset'/);
  assert.match(consoleAdmins, /OTP 연결 해제/);
  assert.match(consoleAdmins, /\/mfa\/reset/);
});

test('users without a verified TOTP are routed to QR enrollment after login', () => {
  assert.match(authService, /mfaEnrollmentRequired/);
  assert.match(login, /\/me\?tab=security&enroll=totp/);
  assert.match(myInfo, /params\.get\('enroll'\) === 'totp'/);
  assert.match(myInfo, /queueMicrotask\(\(\) => void this\.beginTotpEnrollment\(\)\)/);
  assert.match(myInfo, /OpenSphere TOTP 등록 QR 코드/);
  assert.match(myInfo, /OTP 재등록이 필요합니다/);
  assert.match(browserSession, /factor_type === 'totp' && item\.status === 'unverified'/);
  assert.match(browserSession, /method: 'DELETE'/);
  assert.match(browserSession, /verified TOTP factor is already registered/);
});

test('password change is exposed as self-service or a cross-operator recovery link', () => {
  assert.match(myInfo, />비밀번호 변경<\/button>/);
  assert.match(myInfo, /\/api\/identity\/me\/password/);
  assert.match(consoleAdmins, /내 PW 변경/);
  assert.match(consoleAdmins, /초기 PW 설정\/재설정 링크/);
  assert.match(consoleAdmins, /\/onboarding/);
});

test('initial-password and recovery links open a public password form without an existing password', () => {
  assert.match(backend, /redirect_to: `\$\{CONSOLE_PUBLIC_URL\}\/auth\/recovery`/);
  assert.match(backend, /action\.pathname === '\/verify'/);
  assert.match(backend, /action\.pathname = '\/auth\/v1\/verify'/);
  assert.match(backend, /unexpected Supabase recovery action path/);
  assert.match(authService, /consumePasswordRecoveryRedirect/);
  assert.match(authService, /fragment\.get\('access_token'\)/);
  assert.match(authService, /method: 'PUT'/);
  assert.match(authService, /body: JSON\.stringify\(\{ password \}\)/);
  assert.doesNotMatch(recoveryPage, /current-password|현재 비밀번호/);
  assert.match(recoveryPage, /기존 비밀번호로 로그인할 필요가 없습니다/);
  assert.match(recoveryPage, /auth\.completePasswordRecovery/);
  assert.match(app, /auth\.passwordRecoveryState\(\) !== 'idle'/);
  assert.match(routes, /path: 'auth\/recovery'/);
  assert.match(consoleAdmins, /초기 PW 설정\/재설정 링크/);
  assert.match(supabaseManifest, /GOTRUE_PASSWORD_MIN_LENGTH, value: "12"/);
});

test('only an authoritative 401 discards a browser session while dependency outage keeps verified GET access', () => {
  assert.match(authService, /this\.statusOf\(error\) !== 401/);
  assert.match(authService, /this\.clearIdentity\(\);\s*this\.loginRequired\.set\(true\)/);
  assert.match(browserSession, /Supabase session refresh temporarily unavailable; browser session preserved/);
  assert.match(browserSession, /if \(\[400, 401\]\.includes\(errorStatus\(error\)\)\)/);
  assert.match(browserSession, /refresh credential was explicitly rejected/);
  assert.match(browserSession, /rowAfterPeerRefresh/);
  assert.match(browserSession, /tokenActuallyExpired/);
  assert.match(browserSession, /persistRefreshRejection/);
  assert.match(browserSession, /refresh_rejected/);
  assert.match(browserSession, /authorityDegraded: true/);
  assert.match(browserSession, /if \(!readOnly \|\| !cached/);
});

test('session lifetime defaults to 24 hours and idle extension requires real browser activity', () => {
  assert.match(browserSession, /const DEFAULT_DURATION = '24h'/);
  assert.match(authService, /const DEFAULT_SESSION_DURATION: SessionDuration = '24h'/);
  assert.match(authService, /\/api\/identity\/session\/touch/);
  assert.match(authService, /window\.addEventListener\('pointerdown'/);
  assert.match(authService, /window\.addEventListener\('keydown'/);
  assert.doesNotMatch(httpService, /touchSession/);
  assert.match(backend, /p === '\/api\/identity\/session\/touch'/);
  assert.match(browserSession, /const IDLE_TTL_MS = 12 \* 60 \* 60 \* 1000/);
  assert.match(myInfo, /실제 사용자 활동 기준 유휴 12시간 제한/);
});

test('login stays an authentication surface while account security owns future session persistence', () => {
  assert.doesNotMatch(login, /ClarityModule|clrForm|clr-input-container|clr-select-container/);
  assert.match(login, /border-radius:\.6rem;box-shadow:/);
  assert.doesNotMatch(login, /name="session-duration"|\[\(ngModel\)\]="duration"/);
  assert.match(login, /내 프로필의 보안 설정에 저장된 로그인 유지 정책/);
  assert.match(myInfo, /id="session-persistence"/);
  for (const option of ['browser', '1h', '4h', '8h', '12h', '24h', '3d', '7d', '14d', '30d']) {
    assert.match(myInfo, new RegExp(`<option value="${option}">`));
  }
  assert.match(authService, /SESSION_DURATIONS[\s\S]*'browser', '1h', '4h', '8h', '12h', '24h', '3d', '7d', '14d', '30d'/);
  assert.match(myInfo, /다음 로그인부터 모든 브라우저에 같은 정책/);
  assert.match(authService, /\/api\/identity\/session\/preference/);
  assert.doesNotMatch(authService, /opensphere\.session\.duration|localStorage\.setItem\(SESSION_DURATION/);
  assert.match(backend, /p === '\/api\/identity\/session\/preference' && req\.method === 'PUT'/);
  assert.match(browserSession, /sessionPersistenceFromUser\(session\.user\)/);
});

test('profile settings own a private upload and exact linked-account avatar projection', () => {
  assert.match(backend, /p === '\/api\/identity\/profile\/avatar' && req\.method === 'GET'/);
  assert.match(backend, /p === '\/api\/identity\/profile\/avatar\/upload' && req\.method === 'POST'/);
  assert.match(backend, /p === '\/api\/identity\/profile\/avatar\/content' && req\.method === 'GET'/);
  assert.match(profileAvatar, /const AVATAR_BUCKET = 'console-uploads'/);
  assert.match(profileAvatar, /parsed\.protocol !== 'https:' \|\| parsed\.username \|\| parsed\.password/);
  assert.match(profileAvatar, /avatar selection is not a currently linked account/);
  assert.match(profileAvatar, /const AVATAR_MAX_BYTES = 160 \* 1024/);
  assert.match(authService, /loadProfileAvatar/);
  assert.match(authService, /selectLinkedAvatar/);
  assert.match(authService, /uploadProfileAvatar/);
  assert.match(myInfo, /프로필 사진을 제공하는 연결 계정/);
  assert.match(myInfo, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(myInfo, /squareAvatarBase64/);
  assert.match(osShell, /auth\.avatarUrl\(\)/);
  assert.match(osShell, /referrerpolicy="no-referrer"/);
});

test('browser admin requests resolve the HttpOnly session at the Console enforcement point', () => {
  assert.match(backend, /async function proxyAdminControlRequest/);
  assert.match(backend, /browserSessions\.authenticate\(req\)/);
  assert.match(backend, /const routePolicy = adminControlRoutePolicy\(url\.pathname, method\)/);
  assert.match(backend, /routePolicy\.requireAal2 === true/);
  assert.match(backend, /routePolicy\.readOnly/);
  assert.match(backend, /verifyConsoleAdmin\(req, \{ requireAal2 \}\)/);
  assert.match(backend, /assertConsoleAdminActor\(session\.actor, \{ requireAal2 \}\)/);
  assert.match(backend, /authorization = `Bearer \$\{session\.accessToken\}`/);
  assert.match(backend, /p\.startsWith\('\/api\/admin\/'\) && p !== '\/api\/admin\/events'/);
  assert.match(nginx, /location = \/api\/admin\/events \{[\s\S]*?\$dupa_controller_upstream/);
  assert.match(nginx, /location \/api\/admin\/ \{[\s\S]*?\$console_backend_upstream/);
  assert.match(httpService, /shouldReauthenticateAfterUnauthorized/);
  assert.doesNotMatch(httpService, /void this\.auth\.reAuthenticate\(\)/);
});

test('owner-service bearer delegation preserves recent MFA only through the exact browser-session ledger row', () => {
  assert.match(backend, /actorForForwardedAccessToken\(match\[1\], actor\)/);
  assert.match(browserSession, /supabase_session_id=eq\.\$\{encodeURIComponent\(authSessionId\)\}/);
  assert.match(browserSession, /safeEqualHash\(sha256\(storedToken\), token\)/);
  assert.match(browserSession, /lastReauthenticatedAt: row\.last_reauthenticated_at \|\| null/);
  assert.doesNotMatch(browserSession, /lastReauthenticatedAt:\s*new Date\([^\n]*iat/);
});

test('all deployed Supabase JWT consumers use the public Auth issuer', () => {
  assert.match(deploy, /SUPABASE_AUTH_ISSUER, value: "https:\/\/localhost:1114\/auth\/v1"/);
  assert.match(deploy, /CONSOLE_PUBLIC_URL, value: "https:\/\/localhost:1114"/);
  assert.doesNotMatch(deploy, /localhost:8090/);
  assert.doesNotMatch(notificationDeploy, /SUPABASE_AUTH_ISSUER, value: "https:\/\/localhost:8090\/auth\/v1"/);
  assert.equal((notificationDeploy.match(/SUPABASE_AUTH_ISSUER, value: "https:\/\/localhost:1114\/auth\/v1"/g) || []).length, 2);
});
