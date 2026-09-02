'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConsoleOwnerAdmission, requirePermission } = require('./owner-admission');
const { externalChannelRequestAllowed } = require('./owner-policy');

const subjectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const claims = Buffer.from(JSON.stringify({ sub: subjectId, session_id: 'supabase-session-1', aal: 'aal2' })).toString('base64url');
const authorization = `Bearer eyJhbGciOiJIUzI1NiJ9.${claims}.signature`;
function request(overrides = {}) {
  return { method: 'GET', url: '/api/external-channels/summary', headers: {
    authorization, 'x-os-owner-admission': 'external-channel-executor-v1', ...overrides,
  } };
}
function verifier(calls) {
  return createConsoleOwnerAdmission({
    baseUrl: 'http://opensphere-console-api.test', marker: 'external-channel-executor-v1',
    familyPrefix: '/api/external-channels', allowRequest: externalChannelRequestAllowed,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response(JSON.stringify({ schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh',
        observedAt: '2026-09-02T00:00:00.000Z', data: {
        state: 'Active', sessionId, subjectId, permissions: ['console.backup.restore', 'console.role.admin'],
        permissionRevision: '9', revokeEpoch: '4', aal: 'aal2',
      } }), { status: 200 });
    },
  });
}

test('C_BAK accepts only a fresh current recovery authority projection', async () => {
  const calls = [];
  const actor = await verifier(calls)(request());
  assert.equal(actor.browserSessionId, sessionId);
  assert.equal(actor.revokeEpoch, '4');
  assert.equal(requirePermission(actor, 'console.backup.restore'), actor);
  assert.equal(calls[0].options.headers['x-os-owner-admission'], 'external-channel-executor-v1');
});

test('C_BAK rejects cookie leakage, cross-family replay and mutation without C_API CSRF proof', async () => {
  const calls = [];
  const verify = verifier(calls);
  await assert.rejects(verify(request({ cookie: 'raw=session' })), (error) => error.code === 403);
  await assert.rejects(verify({ ...request(), url: '/api/notifications/summary' }), (error) => error.code === 403);
  await assert.rejects(verify({ ...request(), url: '/api/external-channels/not-a-route' }), (error) => error.code === 403);
  await assert.rejects(verify({ ...request(), method: 'POST', url: '/api/external-channels/backup-targets' }), (error) => error.code === 403);
  assert.equal(calls.length, 0);
});

test('C_BAK mutation retains AAL2 recovery permission after CSRF exchange', async () => {
  const actor = await verifier([])({
    ...request({ 'x-os-owner-csrf-verified': 'true' }), method: 'POST', url: '/api/external-channels/backup-targets',
  });
  assert.equal(requirePermission(actor, 'console.backup.restore', { requireAal2: true }), actor);
});