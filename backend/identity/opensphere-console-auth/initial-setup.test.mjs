import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { initialSetupData, initialSetupView, validateInitialSetup } from './initial-setup.mjs';

test('initial setup is required only for an explicit or stale setup state', () => {
  assert.equal(initialSetupView({ data: { state: 'required' } }).required, true);
  assert.equal(initialSetupView({ data: { state: 'complete' } }).required, false);
  assert.equal(initialSetupView({ data: { state: 'configuring', claimedAt: '2026-07-15T00:00:00Z' } }, Date.parse('2026-07-15T00:11:00Z')).required, true);
  assert.equal(initialSetupView({ data: { state: 'configuring', claimedAt: '2026-07-15T00:00:00Z' } }, Date.parse('2026-07-15T00:05:00Z')).busy, true);
});

test('initial setup validates the administrator profile and password confirmation', () => {
  const valid = validateInitialSetup({
    username: 'opensphere-admin', displayName: 'OpenSphere Administrator',
    email: 'admin@opensphere.local', password: 'Long-enough-password-27!', passwordConfirm: 'Long-enough-password-27!'
  });
  assert.equal(valid.ok, true);
  assert.equal(validateInitialSetup({ ...valid.value, passwordConfirm: 'different' }).error, 'password_mismatch');
  assert.equal(validateInitialSetup({ ...valid.value, username: 'idm_admin', passwordConfirm: valid.value.password }).error, 'invalid_username');
});

test('completion clears the transient claim without losing administrator metadata', () => {
  const data = initialSetupData({ data: { username: 'opensphere-admin', claimHash: 'x', claimedAt: 'now' } }, 'complete', {
    displayName: 'Administrator', email: 'admin@opensphere.local', claimHash: null, claimedAt: null
  });
  assert.equal(data.state, 'complete');
  assert.equal(data.claimHash, undefined);
  assert.equal(data.username, 'opensphere-admin');
});

test('first-access setup is same-origin, resourceVersion-claimed and keeps credential sessions in a Secret', () => {
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const deploy = fs.readFileSync(new URL('./deploy.yaml', import.meta.url), 'utf8');
  assert.match(server, /req\.headers\.origin === ORIGIN/);
  assert.match(server, /resourceVersion:\s*configMap\.metadata\?\.resourceVersion/);
  assert.match(server, /patchFlow\('initialsetup'/);
  assert.match(server, /p === '\/bff\/setup\/status'/);
  assert.match(server, /p === '\/bff\/setup\/begin'/);
  assert.match(server, /p === '\/bff\/setup\/totp'/);
  assert.doesNotMatch(server, /attrs:\s*\{[^}]*entry_managed_by:\s*\['idm_admin'\]/);
  assert.match(server, /initial-admin-setup', 'console-access', 'error'/);
  assert.match(deploy, /resourceNames:\s*\["opensphere-console-auth-policy",\s*"opensphere-initial-admin"\]/);
});
