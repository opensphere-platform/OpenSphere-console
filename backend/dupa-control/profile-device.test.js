const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('My Profile is the single human credential control surface', () => {
  const profile = read('src/app/pages/my-info.ts');
  for (const tab of ['상세', '그룹·역할', '내 요청', '내 리소스', '자격 증명', '보안', '활동']) {
    assert.match(profile, new RegExp(tab));
  }
  assert.match(profile, /\/bff\/cli\/devices/);
  assert.match(profile, /\/bff\/cli\/enrollments/);
  assert.match(profile, /자동화 API 토큰/);
  assert.match(profile, /발급 사유/);
  assert.match(profile, /폐기 사유/);
  assert.match(profile, /개인 키는 이 서버가 아닌 운영체제 보안 저장소/);
  assert.match(profile, /장치 이름, ID 또는 지문/);
  assert.match(profile, /설명, 토큰 ID 또는 범위/);
  assert.match(profile, /token\.lastUsedAt/);
  assert.match(profile, /token\.status === 'active'/);
  assert.match(profile, /현재 Console 세션/);
  assert.match(profile, /내보내기 금지/);
  assert.match(profile, /사용 가능한 자격 제공자가 없습니다/);
  assert.match(profile, /credential-grid-scroll/);
  assert.match(profile, /clr-tabs > \.nav \{ overflow-x: auto/);
  assert.match(profile, /<clr-tab-content \*clrIfActive="tab\(\) === 'credentials'">/);
  assert.doesNotMatch(profile, /\[clrIfActive\]/);

  const shell = read('src/app/os/os-shell.ts');
  assert.match(shell, /window\.matchMedia\('\(max-width: 600px\)'\)\.matches/);
  assert.match(shell, /\.os-nav-col\.mobile-collapsed \{ width: 2\.5rem/);

  const adminCli = read('src/app/pages/admin-cli.ts');
  assert.match(adminCli, /지속되는 장치 신뢰로 로그인/);
  assert.match(adminCli, /queryParams.*credentials/);
  assert.doesNotMatch(adminCli, /os login --pat-stdin/);
});

test('CLI configuration never serializes bearer credentials', () => {
  const cli = read('backend/os-cli/cmd/os/main.go');
  assert.match(cli, /PAT\s+string\s+`json:"-"`/);
  assert.match(cli, /IDToken\s+string\s+`json:"-"`/);
  assert.match(cli, /DeviceID\s+string\s+`json:"deviceId,omitempty"`/);
  assert.match(cli, /credentialToken/);
  assert.match(cli, /\/bff\/cli\/challenge/);
  assert.match(cli, /\/bff\/cli\/session/);
});

test('auth deployment sends durable credentials to CBS and keeps one-time flows separate', () => {
  const deploy = read('backend/identity/opensphere-console-auth/deploy.yaml');
  const server = read('backend/identity/opensphere-console-auth/server.mjs');
  const controller = read('backend/dupa-control/controller.js');
  assert.match(deploy, /name: CREDENTIAL_STORE_URL/);
  assert.match(deploy, /name: opensphere-console-auth-cli-flows/);
  assert.match(deploy, /resourceNames:\s*\[[^\]]*opensphere-console-auth-cli-flows[^\]]*\]/s);
  assert.match(server, /\/api\/internal\/credential-state\/\$\{kind\}/);
  assert.match(server, /ConfigMap to CBS migration/);
  assert.match(server, /legacy \$\{kind\} cleanup HTTP/);
  assert.match(server, /credential values never reappear/);
  assert.match(deploy, /resourceNames:\s*\[[^\]]*opensphere-console-auth-pats[^\]]*opensphere-console-auth-cli-devices[^\]]*\][\s\S]*verbs:\s*\["get", "patch"\]/);
  assert.match(server, /reason_required/);
  assert.match(server, /mutationReason/);
  assert.doesNotMatch(server, /const patchDevice = \(id, valueOrNull\) => k8sApi/);
  assert.match(controller, /opensphere-console-auth.*system:serviceaccount:\$\{NS\}:opensphere-console-auth/s);
  assert.match(controller, /credential-state/);
  assert.match(controller, /\(pat\|device\|session\)/);
  assert.match(controller, /managed_credential|listManagedCredentials/);
  assert.match(controller, /getManagedCredential/);
  assert.match(server, /browser-session-revoke/);
  assert.match(server, /session_epoch/);
});

test('administrators can inspect per-user token metadata and revoke without token disclosure or proxy minting', () => {
  const server = read('backend/identity/opensphere-console-auth/server.mjs');
  const controller = read('backend/dupa-control/controller.js');
  const db = read('backend/dupa-control/db.js');
  const backbone = read('backend/backbone/bootstrap/backbone.yaml');
  const page = read('src/app/pages/console-admins.ts');

  assert.match(server, /p === '\/bff\/admin\/tokens' && req\.method === 'GET'.*requireAdmin/s);
  assert.match(server, /handleAdminPatRevoke\(req, res, a, match\[1\]\)/);
  assert.match(server, /api-token-admin-revoke/);
  assert.doesNotMatch(server, /p === '\/bff\/admin\/tokens' && req\.method === 'POST'/);
  assert.match(server, /lastUsedAt: item\.lastUsedAt \|\| null/);
  assert.doesNotMatch(server, /function patCredentialView[\s\S]{0,700}\btoken\s*:/);

  // DDL belongs to the sealed PostgreSQL bootstrap path, never the runtime
  // controller account that reads and changes credential state.
  assert.match(backbone, /last_used_at\s+timestamptz/);
  assert.match(backbone, /00-console-runtime-boundary\.sh/);
  assert.match(db, /async function touchManagedCredential/);
  assert.match(controller, /operation === 'touch'/);
  assert.match(page, /자동화 API 토큰/);
  assert.match(page, /관리자는 토큰 원문을 보거나 대리 발급할 수 없으며 강제 폐기만/);
  assert.match(page, /사용자 토큰 강제 폐기/);
  assert.match(page, /\/bff\/admin\/tokens\/\$\{encodeURIComponent\(token\.jti\)\}/);
});

test('every management surface uses live identity introspection after signature verification', () => {
  const auth = read('backend/identity/opensphere-console-auth/server.mjs');
  const backend = read('backend/opensphere-console-backend/server.js');
  const backendDeploy = read('backend/opensphere-console-backend/deploy.yaml');
  const dupa = read('backend/dupa-control/controller.js');

  assert.match(auth, /async function lookupConsoleIdentity\(username\)/);
  assert.match(auth, /active: !Number\.isFinite\(accountExpiresAt\) \|\| accountExpiresAt > Date\.now\(\)/);
  assert.match(auth, /if \(!identity\.active \|\| !identity\.groups\.some/);
  assert.match(auth, /if \(!pl\) return patJson\(res, 200, \{ active: false \}\);/);
  assert.match(backend, /function introspectConsoleToken\(jwt\)/);
  assert.match(backend, /assertLiveTokenState\(claims, state\)/);
  assert.match(backend, /const groups = \(state\.groups \|\| \[\]\)/);
  assert.match(backendDeploy, /TOKEN_INTROSPECTION_URL/);
  assert.match(dupa, /function introspectManagedToken\(jwt\)/);
  assert.match(dupa, /managedState = await introspectManagedToken\(m\[1\]\)/);
  assert.doesNotMatch(dupa, /if \(claims\.typ === undefined\) return;/);
});

test('ordinary IGA onboarding cannot mint a reset secret for an administrator', () => {
  const identity = read('backend/opensphere-console-backend/server.js');
  assert.match(identity, /const ONBOARDING_TTL_SECONDS = 3600/);
  assert.match(identity, /if \(roles\.includes\(KANIDM_ADMIN_GROUP\)\)/);
  assert.match(identity, /if \(await isConsoleAdministrator\(uname\)\)/);
  assert.match(identity, /administrator target requires a separate recovery approval/);
});

test('release manifests receive one Setup-managed Console origin', () => {
  const authDeploy = read('backend/identity/opensphere-console-auth/deploy.yaml');
  const shellDeploy = read('deploy/opensphere-console.yaml');
  const backendDeploy = read('backend/opensphere-console-backend/deploy.yaml');
  const dupaDeploy = read('backend/dupa-control/opensphere-console-dupa-controller.yaml');
  const auth = read('backend/identity/opensphere-console-auth/server.mjs');
  const browser = read('src/app/core/auth.service.ts');

  for (const manifest of [authDeploy, shellDeploy, backendDeploy, dupaDeploy]) {
    assert.match(manifest, /__OPENSPHERE_CONSOLE_URL__/);
  }
  assert.match(authDeploy, /OIDC_ISSUER/);
  assert.match(authDeploy, /OIDC_REDIRECT_URIS/);
  assert.match(auth, /process\.env\.OIDC_ISSUER \|\| 'https:\/\/localhost:8090\/oauth2/);
  assert.match(browser, /private readonly authority = `\$\{window\.location\.origin\}\/oauth2\/openid\/opensphere-console`/);
  assert.doesNotMatch(browser, /auth\.console\.opensphere\.dev/);
});

test('runAsNonRoot Node workloads use numeric image and pod identities', () => {
  for (const [dockerfilePath, deploymentPath] of [
    ['backend/identity/opensphere-console-auth/Dockerfile', 'backend/identity/opensphere-console-auth/deploy.yaml'],
    ['backend/dupa-control/Dockerfile', 'backend/dupa-control/opensphere-console-dupa-controller.yaml'],
  ]) {
    const dockerfile = read(dockerfilePath);
    const deployment = read(deploymentPath);
    assert.match(dockerfile, /^USER 1000:1000$/m);
    assert.doesNotMatch(dockerfile, /^USER node$/m);
    assert.match(deployment, /runAsNonRoot: true\s+runAsUser: 1000\s+runAsGroup: 1000/);
  }
});

test('auth image contains every local runtime module imported by server', () => {
  const server = read('backend/identity/opensphere-console-auth/server.mjs');
  const dockerfile = read('backend/identity/opensphere-console-auth/Dockerfile');
  const imports = [...server.matchAll(/from\s+['"]\.\/(.+?\.mjs)['"]/g)].map((match) => match[1]);

  assert.ok(imports.length > 0, 'server must declare local runtime modules');
  for (const moduleName of imports) {
    assert.match(
      dockerfile,
      new RegExp(`COPY(?:\\s+--\\S+)*\\s+${moduleName.replaceAll('.', '[.]')}\\s+`),
      `${moduleName} must be copied into the auth runtime image`,
    );
  }
});
