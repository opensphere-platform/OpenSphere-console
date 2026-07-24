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
const login = fs.readFileSync(path.join(root, 'src/app/pages/login.ts'), 'utf8');
const setup = fs.readFileSync(path.join(root, 'src/app/pages/initial-setup.ts'), 'utf8');
const myInfo = fs.readFileSync(path.join(root, 'src/app/pages/my-info.ts'), 'utf8');
const consoleAdmins = fs.readFileSync(path.join(root, 'src/app/pages/console-admins.ts'), 'utf8');
const recoveryPage = fs.readFileSync(path.join(root, 'src/app/pages/password-recovery.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app/app.ts'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/app/app.routes.ts'), 'utf8');
const supabaseManifest = fs.readFileSync(path.join(root, 'backend/supabase/bootstrap/supabase.yaml'), 'utf8');

test('administrator mutations require a real AAL2 session by default', () => {
  assert.match(backend, /SUPABASE_REQUIRE_AAL2 \|\| 'true'/);
  assert.match(backend, /SUPABASE_REQUIRE_AAL2 && isMutationRequest\(req\)/);
  assert.match(backend, /admin mutation requires MFA assurance aal2/);
  assert.match(deploy, /name: SUPABASE_REQUIRE_AAL2, value: "true"/);
  assert.match(deploy, /name: NOTIFICATION_REQUIRE_AAL2, value: "true"/);
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
  assert.match(authService, /challengeAndVerify/);
  assert.match(authService, /authJson<SupabaseUser>\('\/auth\/v1\/user', \{ method: 'GET' \}, token\)/);
  assert.doesNotMatch(authService, /authJson<SupabaseMfaFactors>\('\/auth\/v1\/factors', \{ method: 'GET' \}, token\)/);
  assert.match(authService, /jwtAssurance\(session\.access_token\) !== 'aal2'/);
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
  assert.match(authService, /factor\.factor_type === 'totp' && factor\.status === 'unverified'/);
  assert.match(authService, /method: 'DELETE'/);
  assert.match(authService, /factors are never touched/);
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

test('a stale browser JWT is discarded and routed to login instead of surfacing bad iss as an outage', () => {
  assert.match(authService, /class SupabaseSessionRejectedError extends Error/);
  assert.match(authService, /response\.status === 401/);
  assert.match(authService, /error instanceof SupabaseSessionRejectedError/);
  assert.match(authService, /this\.clearSession\(\);\s*this\.loginRequired\.set\(true\)/);
});

test('all deployed Supabase JWT consumers use the public Auth issuer', () => {
  assert.match(deploy, /SUPABASE_AUTH_ISSUER, value: "https:\/\/localhost:1114\/auth\/v1"/);
  assert.match(deploy, /CONSOLE_PUBLIC_URL, value: "https:\/\/localhost:1114"/);
  assert.doesNotMatch(deploy, /localhost:8090/);
  assert.doesNotMatch(notificationDeploy, /SUPABASE_AUTH_ISSUER, value: "https:\/\/localhost:8090\/auth\/v1"/);
  assert.equal((notificationDeploy.match(/SUPABASE_AUTH_ISSUER, value: "https:\/\/localhost:1114\/auth\/v1"/g) || []).length, 2);
});
