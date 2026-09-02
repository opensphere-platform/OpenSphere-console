'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { admitted, createOsShellConsoleOwnerAdmission } = require('./console-owner-admission');

const now = Date.parse('2026-09-02T00:00:00.000Z');
const subjectId = '11111111-1111-4111-8111-111111111111';
const browserSessionId = '22222222-2222-4222-8222-222222222222';
const revision = `sha256:${'a'.repeat(64)}`;
function token(overrides = {}) {
  const claims = { sub: subjectId, session_id: 'supabase-auth-session-1', aal: 'aal2', exp: Math.floor(now / 1000) + 900, ...overrides };
  return ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
}
function request(headers = {}, patch = {}) {
  return { method: 'GET', url: '/api/os-shell/readiness', headers: {
    authorization: `Bearer ${token()}`, 'x-os-owner-admission': 'os-shell-control-v1', ...headers,
  }, ...patch };
}
function verifier({ permissions = ['session:attach'], projection = {}, calls = [] } = {}) {
  return { calls, verify: createOsShellConsoleOwnerAdmission({
    baseUrl: 'http://console-api.test', publicOrigin: 'https://console.example.test', now: () => now,
    async resolvePermissionRevision(id) { calls.push({ revision: id }); return revision; },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh', observedAt: new Date(now).toISOString(),
        data: { state: 'Active', sessionId: browserSessionId, subjectId, permissions,
          permissionRevision: '7', revokeEpoch: '4', aal: 'aal2', ...projection },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }) };
}

test('C_SCTL binds current Console subject/session/revoke coordinates to current Shell DB revision', async () => {
  const subject = verifier();
  const actor = await subject.verify(request({ 'x-os-correlation-id': 'shell-correlation-1' }));
  assert.equal(actor.sub, subjectId);
  assert.equal(actor.browserSessionId, browserSessionId);
  assert.equal(actor.authSessionRef, 'supabase-auth-session-1');
  assert.equal(actor.permissionRevision, revision);
  assert.equal(actor.authorityPermissionRevision, 7);
  assert.equal(actor.revokeEpoch, 4);
  assert.equal(actor.origin, 'https://console.example.test');
  assert.equal(subject.calls[0].url, 'http://console-api.test/api/identity/me');
  assert.equal(subject.calls[0].options.headers['x-os-owner-admission'], 'os-shell-control-v1');
  assert.deepEqual(subject.calls[1], { revision: subjectId });
});

test('C_SCTL rejects browser proof leakage, family replay and mutation without C_API CSRF proof', async () => {
  const subject = verifier();
  await assert.rejects(subject.verify(request({ cookie: 'raw=session' })), (error) => error.status === 403);
  await assert.rejects(subject.verify(request({ 'x-os-csrf-token': 'raw-browser-proof' })), (error) => error.status === 403);
  await assert.rejects(subject.verify(request({}, { url: '/api/plugins/sample' })), (error) => error.status === 403);
  await assert.rejects(subject.verify(request({}, { method: 'POST', url: '/api/os-shell/sessions' })), (error) => error.status === 403);
  assert.equal(subject.calls.length, 0);
});

test('C_SCTL mutation accepts only CSRF-exchanged bearer with session:attach', async () => {
  const subject = verifier();
  const actor = await subject.verify(request({ 'x-os-owner-csrf-verified': 'true' }, { method: 'POST', url: '/api/os-shell/sessions' }));
  assert.equal(actor.csrfRequired, true);
  assert.equal(actor.csrfVerified, true);
  await assert.rejects(verifier({ permissions: [] }).verify(request()), (error) => error.status === 403);
});

test('C_SCTL fails closed on JWT/authority subject or AAL drift', async () => {
  await assert.rejects(verifier({ projection: { subjectId: '33333333-3333-4333-8333-333333333333' } }).verify(request()), (error) => error.status === 503);
  await assert.rejects(verifier({ projection: { aal: 'aal1' } }).verify(request()), (error) => error.status === 503);
});
test('C_SCTL preserves C_API 5xx as dependency unavailable', async () => {
  const verify = createOsShellConsoleOwnerAdmission({
    baseUrl: 'http://console-api.test', publicOrigin: 'https://console.example.test', now: () => now,
    async resolvePermissionRevision() { return revision; },
    async fetchImpl() { return new Response('{}', { status: 503 }); },
  });
  await assert.rejects(verify(request()), (error) => error.status === 503);
});
test('C_SCTL route allowlist closes each browser and WebSocket method pair', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  for (const [method, path] of [
    ['GET', '/api/os-shell/readiness'], ['GET', '/api/os-shell/sessions'], ['POST', '/api/os-shell/sessions'],
    ['GET', `/api/os-shell/sessions/${id}`], ['DELETE', `/api/os-shell/sessions/${id}`],
    ['POST', `/api/os-shell/sessions/${id}/attach-ticket`], ['GET', `/api/os-shell/sessions/${id}/attach`],
  ]) assert.equal(admitted(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ['POST', '/api/os-shell/readiness'], ['DELETE', '/api/os-shell/sessions'],
    ['GET', `/api/os-shell/sessions/${id}/attach-ticket`], ['POST', `/api/os-shell/sessions/${id}/attach`],
    ['GET', '/api/os-shell/runtime/private'],
  ]) assert.equal(admitted(method, path), false, `${method} ${path}`);
});

test('C_SCTL rejects non-canonical revisions and unbounded permissions', async () => {
  for (const projection of [
    { permissionRevision: 7 }, { revokeEpoch: '-1' }, { permissionRevision: '01' },
    { permissions: Array.from({ length: 257 }, (_, index) => `session.permission.${index}`) },
    { permissions: ['INVALID PERMISSION'] },
  ]) {
    await assert.rejects(verifier({ projection }).verify(request()), (error) => error.status === 503);
  }
});
