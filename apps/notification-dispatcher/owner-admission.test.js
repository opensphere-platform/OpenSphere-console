'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConsoleOwnerAdmission, requirePermission } = require('./owner-admission');
const { notificationRequestAllowed } = require('./owner-policy');

const subjectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
function token(overrides = {}) {
  const claims = { sub: subjectId, session_id: 'supabase-auth-session-0001', aal: 'aal2', ...overrides };
  return ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
}
function request(overrides = {}) {
  return {
    method: 'GET', url: '/api/notifications/summary',
    headers: {
      authorization: `Bearer ${token()}`,
      'x-os-owner-admission': 'notification-dispatcher-v1',
      ...overrides,
    },
  };
}
function verifier(calls) {
  return createConsoleOwnerAdmission({
    baseUrl: 'http://opensphere-console-api.test', marker: 'notification-dispatcher-v1',
    familyPrefix: '/api/notifications', allowRequest: notificationRequestAllowed,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh',
        observedAt: '2026-09-02T00:00:00.000Z', data: {
          state: 'Active', sessionId, subjectId, aal: 'aal2',
          permissions: ['console.notification.manage', 'console.role.admin'],
          permissionRevision: 7, revokeEpoch: 3,
        },
      }), { status: 200 });
    },
  });
}

test('owner admission revalidates signed credential coordinates against current session authority', async () => {
  const calls = [];
  const actor = await verifier(calls)(request({ 'x-os-correlation-id': 'owner-correlation-0001' }));
  assert.equal(actor.sub, subjectId);
  assert.equal(actor.browserSessionId, sessionId);
  assert.equal(actor.authSessionRef, 'supabase-auth-session-0001');
  assert.equal(actor.authzRevision, '7');
  assert.equal(actor.revokeEpoch, '3');
  assert.deepEqual(actor.groups, ['console-admins']);
  assert.equal(calls[0].url, 'http://opensphere-console-api.test/api/internal/owner-authority');
  assert.equal(calls[0].options.headers['x-os-owner-admission'], 'notification-dispatcher-v1');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'cookie'), false);
});

test('owner admission rejects browser proof leakage, family changes and missing mutation CSRF proof before introspection', async () => {
  const calls = [];
  const verify = verifier(calls);
  await assert.rejects(verify(request({ cookie: '__Host-opensphere-session=raw' })), (error) => error.code === 403);
  await assert.rejects(verify(request({ 'x-os-csrf-token': 'raw-browser-proof' })), (error) => error.code === 403);
  await assert.rejects(verify({ ...request(), url: '/api/external-channels/summary' }), (error) => error.code === 403);
  await assert.rejects(verify({ ...request(), url: '/api/notifications/not-a-route' }), (error) => error.code === 403);
  await assert.rejects(verify({ ...request(), method: 'POST', url: '/api/notifications/channels' }), (error) => error.code === 403);
  assert.equal(calls.length, 0);
});

test('owner mutation requires C_API CSRF proof and current permission/AAL', async () => {
  const calls = [];
  const actor = await verifier(calls)({ ...request({ 'x-os-owner-csrf-verified': 'true' }), method: 'POST', url: '/api/notifications/channels' });
  assert.equal(requirePermission(actor, 'console.notification.manage', { requireAal2: true }), actor);
  assert.throws(() => requirePermission({ ...actor, assurance: 'aal1' }, 'console.notification.manage', { requireAal2: true }), (error) => error.code === 403);
  assert.throws(() => requirePermission({ ...actor, permissions: [] }, 'console.notification.manage'), (error) => error.code === 403);
});

test('owner authority projection must match JWT subject/AAL and carry fresh revoke coordinates', async () => {
  const verify = createConsoleOwnerAdmission({
    baseUrl: 'http://opensphere-console-api.test', marker: 'notification-dispatcher-v1', familyPrefix: '/api/notifications', allowRequest: notificationRequestAllowed,
    async fetchImpl() {
      return new Response(JSON.stringify({ schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh',
        observedAt: '2026-09-02T00:00:00.000Z', data: {
        state: 'Active', sessionId, subjectId: '33333333-3333-4333-8333-333333333333', aal: 'aal1',
        permissions: [], permissionRevision: 7, revokeEpoch: 3,
      } }), { status: 200 });
    },
  });
  await assert.rejects(verify(request()), (error) => error.code === 503);
});
test('common Owner verifier preserves C_API dependency failures and bounds the authority envelope', async () => {
  const unavailable = createConsoleOwnerAdmission({
    baseUrl: 'http://opensphere-console-api.test', marker: 'notification-dispatcher-v1',
    familyPrefix: '/api/notifications', allowRequest: notificationRequestAllowed,
    async fetchImpl() { return new Response('{}', { status: 503 }); },
  });
  await assert.rejects(unavailable(request()), (error) => error.code === 503);

  const oversized = createConsoleOwnerAdmission({
    baseUrl: 'http://opensphere-console-api.test', marker: 'notification-dispatcher-v1',
    familyPrefix: '/api/notifications', allowRequest: notificationRequestAllowed,
    async fetchImpl() { return new Response(JSON.stringify({
      schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh', observedAt: '2026-09-02T00:00:00.000Z',
      data: { state: 'Active', sessionId, subjectId, aal: 'aal2',
        permissions: Array.from({ length: 257 }, (_, index) => `console.permission.${index}`),
        permissionRevision: 7, revokeEpoch: 3 },
    }), { status: 200 }); },
  });
  await assert.rejects(oversized(request()), (error) => error.code === 503);
});