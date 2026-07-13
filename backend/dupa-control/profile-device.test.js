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
  assert.match(profile, /<clr-tab-content \*clrIfActive="tab\(\) === 'credentials'">/);
  assert.doesNotMatch(profile, /\[clrIfActive\]/);

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
  assert.match(server, /reason_required/);
  assert.match(server, /mutationReason/);
  assert.doesNotMatch(server, /const patchDevice = \(id, valueOrNull\) => k8sApi/);
  assert.match(controller, /opensphere-console-auth.*system:serviceaccount:\$\{NS\}:opensphere-console-auth/s);
  assert.match(controller, /credential-state/);
  assert.match(controller, /managed_credential|listManagedCredentials/);
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
