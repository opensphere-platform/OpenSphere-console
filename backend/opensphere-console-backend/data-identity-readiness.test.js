'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDataIdentityReadiness } = require('./data-identity-readiness');

test('data and identity readiness requires Auth, PostgREST data authority, and Storage together', async () => {
  const result = await evaluateDataIdentityReadiness({
    readDataAuthority: async () => [],
    fetchImpl: async (url) => ({ status: url.endsWith('/status') ? 503 : 200 }),
    authUrl: 'http://auth',
    storageUrl: 'http://storage',
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.components.map(({ key, ready }) => ({ key, ready })), [
    { key: 'auth', ready: true },
    { key: 'data', ready: true },
    { key: 'storage', ready: false },
  ]);
});

test('data and identity readiness is true only when all three authorities are usable', async () => {
  const result = await evaluateDataIdentityReadiness({
    readDataAuthority: async () => [{ user_id: '00000000-0000-0000-0000-000000000000' }],
    fetchImpl: async () => ({ status: 200 }),
    authUrl: 'http://auth/',
    storageUrl: 'http://storage/',
  });

  assert.equal(result.ready, true);
  assert.equal(result.components.every((component) => component.ready), true);
});
