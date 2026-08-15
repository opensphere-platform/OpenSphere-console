'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOsShellAdmissionIssuer, verifyOsShellAdmission } = require('./os-shell-admission');

const secret = Buffer.alloc(32, 7).toString('base64url');
const now = () => Date.parse('2026-08-15T00:00:00Z');
const request = (overrides = {}) => ({ headers: {
  'x-os-internal-authn-subrequest': 'os-shell-v1',
  'x-os-original-method': 'POST', 'x-os-original-uri': '/api/os-shell/sessions',
  'x-os-original-origin': 'https://console.example.test', cookie: 'opaque=server-only',
  ...overrides,
} });
const session = { actor: {
  sub: '10000000-0000-4000-8000-000000000001', browserSessionId: '20000000-0000-4000-8000-000000000001',
  credentialRevision: 3, groups: ['console-operators'], permissions: ['session:attach'], assurance: 'aal2',
}, row: { idle_expires_at: '2026-08-15T00:10:00.000Z', absolute_expires_at: '2026-08-15T00:30:00.000Z' } };

test('issues a <=15 second assertion bound to method, path, origin and CSRF result', async () => {
  const authorize = createOsShellAdmissionIssuer({ secret, now, ttlSeconds: 12 });
  const result = await authorize(request(), async () => session);
  const claims = verifyOsShellAdmission(result.assertion, {
    secret, now, method: 'POST', path: '/api/os-shell/sessions', origin: 'https://console.example.test',
  });
  assert.equal(claims.sub, session.actor.sub);
  assert.equal(claims.exp - claims.iat, 12);
  assert.equal(claims.csrfVerified, true);
  assert.equal(result.assertion.includes('opaque'), false);
});

test('fails closed for degraded authority, missing permission and bearer input', async () => {
  const authorize = createOsShellAdmissionIssuer({ secret, now });
  await assert.rejects(() => authorize(request(), async () => ({ ...session, authorityDegraded: true })), (e) => e.code === 503);
  await assert.rejects(() => authorize(request(), async () => ({ actor: { ...session.actor, permissions: [] } })), (e) => e.code === 403);
  await assert.rejects(() => authorize(request({ authorization: 'Bearer forbidden' }), async () => session), (e) => e.code === 403);
});

test('rejects replay against a changed request projection or tampered signature', async () => {
  const authorize = createOsShellAdmissionIssuer({ secret, now });
  const { assertion } = await authorize(request(), async () => session);
  assert.throws(() => verifyOsShellAdmission(assertion, {
    secret, now, method: 'DELETE', path: '/api/os-shell/sessions', origin: 'https://console.example.test',
  }), (e) => e.code === 403);
  assert.throws(() => verifyOsShellAdmission(`${assertion.slice(0, -1)}x`, {
    secret, now, method: 'POST', path: '/api/os-shell/sessions', origin: 'https://console.example.test',
  }), (e) => e.code === 401);
});
