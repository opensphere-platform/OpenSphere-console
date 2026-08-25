'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registryFetch,
  registryResponseError,
  verifyGhcrCandidateCredentials,
} = require('./registry-http');

const response = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[String(name).toLowerCase()] || null },
  json: async () => body,
});

test('Registry HTTP failures retain actionable status and Retry-After evidence', () => {
  assert.equal(registryResponseError(response(401), 'request').reason, 'RegistryUnauthorized');
  assert.equal(registryResponseError(response(404), 'request').reason, 'ArtifactNotFound');
  const limited = registryResponseError(response(429, {}, { 'retry-after': '17' }), 'request');
  assert.equal(limited.reason, 'RegistryRateLimited');
  assert.equal(limited.retryAfter, '17');
  assert.equal(registryResponseError(response(503), 'request').reason, 'RegistryUnavailable');
});

test('Registry timeouts are not collapsed into a generic 500', async () => {
  await assert.rejects(
    registryFetch('https://ghcr.io/test', {}, async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }),
    (error) => error.code === 504 && error.reason === 'RegistryTimeout',
  );
});

test('candidate credentials must read the canonical OpenSphere artifact before activation', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options?.headers?.Authorization || '' });
    if (url.startsWith('https://ghcr.io/token?')) return response(200, { token: 'short-lived-registry-token' });
    return response(200, {}, { 'docker-content-digest': `sha256:${'a'.repeat(64)}` });
  };
  const verified = await verifyGhcrCandidateCredentials('operator', 'candidate-secret', fetchImpl);
  assert.equal(verified.registry, 'ghcr.io');
  assert.match(calls[0].authorization, /^Basic /);
  assert.equal(calls[1].authorization, 'Bearer short-lived-registry-token');
  assert.equal(JSON.stringify(verified).includes('candidate-secret'), false);
});

test('rejected candidate credentials never produce a verified result', async () => {
  await assert.rejects(
    verifyGhcrCandidateCredentials('operator', 'bad-secret', async () => response(401)),
    (error) => error.reason === 'RegistryUnauthorized',
  );
});
