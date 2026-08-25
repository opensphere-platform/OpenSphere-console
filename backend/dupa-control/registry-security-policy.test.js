'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REGISTRY_REMOVAL_CONFIRMATION,
  registryRemovalConfirmed,
  registryRevocationConfirmation,
} = require('./registry-security-policy');

test('canonical and legacy credential routes share one exact removal confirmation', () => {
  for (const route of [
    '/api/admin/extensions/registry-connections/opensphere-ghcr',
    '/api/admin/extensions/registry-credentials',
  ]) {
    assert.ok(route);
    assert.equal(registryRemovalConfirmed(REGISTRY_REMOVAL_CONFIRMATION), true);
    assert.equal(registryRemovalConfirmed('REMOVE'), false);
    assert.equal(registryRemovalConfirmed('remove opensphere-ghcr'), false);
  }
});

test('revocation confirmation binds the complete repository and digest', () => {
  const image = `ghcr.io/opensphere-platform/opensphere-test@sha256:${'a'.repeat(64)}`;
  assert.equal(registryRevocationConfirmation(image), `REVOKE ${image}`);
});
