import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsoleOwnerAdmission } from '../src/owner-admission.mjs';

const subjectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
function credential(aal = 'aal2') {
  const payload = Buffer.from(JSON.stringify({ sub: subjectId, session_id: 'supabase-auth-session-1', aal })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}
function request(overrides = {}) {
  return { method: 'GET', url: '/api/plugins/sample/plugins/ui-shell.manifest.json', headers: {
    authorization: `Bearer ${credential()}`,
    'x-os-owner-admission': 'extension-controller-v1',
    ...overrides,
  } };
}
function authority(calls, patch = {}) {
  return createConsoleOwnerAdmission({
    baseUrl: 'http://console-api.test',
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh',
        observedAt: new Date().toISOString(), correlationId: 'correlation-1', evidenceRefs: [],
        data: { state: 'Active', sessionId, subjectId, aal: 'aal2', permissions: ['console.role.viewer'],
          permissionRevision: '8', revokeEpoch: '3', ...patch },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
}

test('C_EXT independently revalidates owner credential coordinates and current revisions', async () => {
  const calls = [];
  const actor = await authority(calls)(request({ 'x-os-correlation-id': 'browser-correlation-1' }));
  assert.deepEqual({
    subjectId: actor.subjectId, browserSessionId: actor.browserSessionId,
    permissionRevision: actor.permissionRevision, revokeEpoch: actor.revokeEpoch, assurance: actor.assurance,
  }, { subjectId, browserSessionId: sessionId, permissionRevision: 8, revokeEpoch: 3, assurance: 'aal2' });
  assert.equal(calls[0].url, 'http://console-api.test/api/identity/me');
  assert.equal(calls[0].options.headers['x-os-owner-admission'], 'extension-controller-v1');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'cookie'), false);
});

test('C_EXT rejects raw browser proofs, cross-family replay and unverified mutation before authority call', async () => {
  const calls = [];
  const verify = authority(calls);
  await assert.rejects(verify(request({ cookie: '__Host-opensphere-session=raw' })), (error) => error.status === 403);
  await assert.rejects(verify(request({ 'x-os-csrf-token': 'raw-browser-proof' })), (error) => error.status === 403);
  await assert.rejects(verify({ ...request(), url: '/api/osaa/health' }), (error) => error.status === 403);
  await assert.rejects(verify({ ...request(), method: 'POST', url: '/api/plugins/sample/action' }), (error) => error.status === 403);
  assert.equal(calls.length, 0);
});

test('C_EXT requires subject/AAL match and fresh active envelope', async () => {
  await assert.rejects(authority([], { subjectId: '33333333-3333-4333-8333-333333333333' })(request()), (error) => error.status === 503);
  await assert.rejects(authority([], { aal: 'aal1' })(request()), (error) => error.status === 503);
});
test('C_EXT preserves C_API 5xx as dependency unavailable', async () => {
  const verify = createConsoleOwnerAdmission({
    baseUrl: 'http://console-api.test',
    async fetchImpl() { return new Response('{}', { status: 503 }); },
  });
  await assert.rejects(verify(request()), (error) => error.status === 503);
});
test('C_EXT rejects non-integer revisions and unbounded permission projections', async () => {
  const base = {
    schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh',
    observedAt: '2026-09-02T00:00:00.000Z', correlationId: 'c', evidenceRefs: [],
    data: { state: 'Active', sessionId, subjectId, aal: 'aal2', permissions: ['console.role.viewer'],
      permissionRevision: '8', revokeEpoch: '3' },
  };
  const invalid = [
    { ...base, observedAt: 'invalid' },
    { ...base, data: { ...base.data, permissionRevision: 8 } },
    { ...base, data: { ...base.data, revokeEpoch: -1 } },
    { ...base, data: { ...base.data, permissions: Array.from({ length: 257 }, (_, index) => `plugin.permission.${index}`) } },
    { ...base, data: { ...base.data, permissions: ['INVALID PERMISSION'] } },
  ];
  for (const envelope of invalid) {
    const verify = createConsoleOwnerAdmission({
      baseUrl: 'http://console-api.test',
      async fetchImpl() { return new Response(JSON.stringify(envelope), { status: 200 }); },
    });
    await assert.rejects(verify(request()), (error) => error.status === 503);
  }
});

test('C_EXT admits only the exact target management surface with exchanged proof', async () => {
  const calls = [];
  const verify = authority(calls);
  await verify({ ...request(), method: 'GET', url: '/api/admin/plugins/catalog' });
  await verify({
    ...request({ 'x-os-owner-csrf-verified': 'true' }),
    method: 'POST',
    url: '/api/admin/plugins/registrations/metrics/rollback',
  });
  assert.equal(calls.length, 2);

  const rejected = [
    ['POST', '/api/admin/plugins/registrations/metrics/install'],
    ['GET', '/api/admin/plugins/catalog/extra'],
    ['POST', '/api/admin/extensions/install'],
    ['DELETE', '/api/admin/plugins/registrations/metrics'],
  ];
  for (const [method, url] of rejected) {
    await assert.rejects(
      verify({ ...request({ 'x-os-owner-csrf-verified': 'true' }), method, url }),
      (error) => error.status === 403,
    );
  }
  assert.equal(calls.length, 2);
});