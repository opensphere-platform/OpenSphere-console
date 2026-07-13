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
  assert.match(profile, /개인 키는 이 서버가 아닌 운영체제 보안 저장소/);

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

test('auth deployment persists public devices and one-time flows separately', () => {
  const deploy = read('backend/identity/opensphere-console-auth/deploy.yaml');
  assert.match(deploy, /name: opensphere-console-auth-cli-devices/);
  assert.match(deploy, /name: opensphere-console-auth-cli-flows/);
  assert.match(deploy, /resourceNames:\s*\[[^\]]*opensphere-console-auth-cli-devices[^\]]*\]/s);
  assert.match(deploy, /resourceNames:\s*\[[^\]]*opensphere-console-auth-cli-flows[^\]]*\]/s);
});
