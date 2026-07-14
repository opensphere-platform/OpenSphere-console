import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const files = ['_oidc-login.mjs', '_mint-token.mjs'];

test('local OIDC helpers require injected credentials and contain no fallback secret', () => {
  for (const file of files) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /OPENSPHERE_TEST_TOTP_SECRET/);
    assert.match(source, /OPENSPHERE_TEST_USERNAME/);
    assert.match(source, /OPENSPHERE_TEST_PASSWORD/);
    assert.doesNotMatch(source, /process\.argv\[2\]\s*\|\|/);
  }
});

test('deployment validates Kanidm with the installation CA, not the TLS leaf', () => {
  const deploy = fs.readFileSync(new URL('./deploy.yaml', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const dockerfile = fs.readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');

  assert.match(deploy, /KANIDM_CA_PATH, value: "\/etc\/kanidm-ca\/ca\.crt"/);
  assert.match(deploy, /name: kanidm-ca, mountPath: \/etc\/kanidm-ca, readOnly: true/);
  assert.match(deploy, /secretName: opensphere-console-auth-ca/);
  assert.doesNotMatch(deploy, /KANIDM_CA_PATH, value: "\/certs\/tls\.crt"/);
  assert.match(server, /KANIDM_CA_PATH \|\| '\/etc\/kanidm-ca\/ca\.crt'/);
  assert.match(dockerfile, /\/etc\/kanidm-ca\/ca\.crt/);
});
