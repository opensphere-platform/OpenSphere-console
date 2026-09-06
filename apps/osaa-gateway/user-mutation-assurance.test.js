'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertUserMutationAssurance } = require('./c-ai-owner-api');

const profile = { channel: 'edge', environment: 'development', clusterId: 'local', consoleOrigin: 'https://localhost:1114' };
test('current local edge runtime preserves real AAL1; normal runtime still requires AAL2', () => {
  const actor = Object.freeze({ assurance: 'aal1' });
  for (const consoleOrigin of ['https://localhost:1114', 'https://127.0.0.1:1114', 'https://[::1]:1114']) {
    assertUserMutationAssurance(actor, 'owner action', { ...profile, consoleOrigin });
  }
  assert.equal(actor.assurance, 'aal1');
  // User-approved policy: only trusted HTTPS loopback and edge select the exception.
  assertUserMutationAssurance(actor, 'owner action', { ...profile, environment: 'production', clusterId: 'remote' });
  for (const changes of [{ channel: 'stable' }, { channel: 'candidate' }, { consoleOrigin: 'https://console.example' }]) {
    assert.throws(() => assertUserMutationAssurance(actor, 'owner action', { ...profile, ...changes }), { code: 403 });
    assertUserMutationAssurance({ assurance: 'aal2' }, 'owner action', { ...profile, ...changes });
  }
});
test('invalid or ambiguous local runtime origins cannot disable MFA, and missing assurance is never AAL1', () => {
  for (const consoleOrigin of ['http://localhost:1114', 'https://localhost.example', 'https://localhost:1114/path',
    'https://localhost:1114/?edge=true', 'https://localhost:1114/#local', 'https://user@localhost:1114', 'invalid']) {
    assert.throws(() => assertUserMutationAssurance({ assurance: 'aal1' }, 'owner action', { ...profile, consoleOrigin }), { code: 403 });
  }
  for (const assurance of [null, undefined, '', 'AAL1', 'aal3']) {
    assert.throws(() => assertUserMutationAssurance({ assurance }, 'owner action', profile), { code: 403 });
  }
});
