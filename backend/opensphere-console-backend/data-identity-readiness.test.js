'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateDataIdentityReadiness } = require('./data-identity-readiness');

test('Backend image carries the readiness contract used by server.js', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY opensphere-console-backend\/data-identity-readiness\.js \.\/data-identity-readiness\.js/);
});

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
