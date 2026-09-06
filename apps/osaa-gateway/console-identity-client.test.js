'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConsoleIdentityVerifier, targetPathAllowed, createCurrentActorResolver, hasCurrentPermission } = require('./console-identity-client');

const SUBJECT = '11111111-1111-4111-8111-111111111111';
const BROWSER_SESSION = '22222222-2222-4222-8222-222222222222';
const AUTH_SESSION_REF = 'supabase-auth-session-reference';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (overrides = {}) => `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
  sub: SUBJECT, session_id: AUTH_SESSION_REF, aal: 'aal2', ...overrides,
})}.${Buffer.from('owner-signature').toString('base64url')}`;
const ownerBearer = `Bearer ${token()}`;

function ownerEnvelope(overrides = {}) {
  const dataOverrides = overrides.data || {};
  return {
    schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh',
    observedAt: '2026-09-02T00:00:00.000Z', correlationId: 'owner-correlation', evidenceRefs: [],
    ...overrides,
    data: {
      state: 'Active', sessionId: BROWSER_SESSION, subjectId: SUBJECT,
      permissions: ['console.role.admin', 'console.audit.read'], aal: 'aal2',
      permissionRevision: '7', revokeEpoch: '3', ...dataOverrides,
    },
  };
}

function ownerRequest({ path = '/api/osaa/health', method = 'GET', headers = {} } = {}) {
  return {
    url: path, method,
    headers: { authorization: ownerBearer, 'x-os-owner-admission': 'osaa-gateway-v1', ...headers },
  };
}

function verifierWith(responseFactory) {
  return createConsoleIdentityVerifier({
    baseUrl: 'http://opensphere-console-api.test', targetOwnerAdmission: true,
    fetchImpl: responseFactory,
  });
}

test('each delegated tool resolves current permissions, then refuses revocation without using the prior administrator snapshot', async () => {
  let status = 200;
  let envelope = ownerEnvelope();
  let calls = 0;
  const verify = verifierWith(async () => {
    calls++;
    return new Response(JSON.stringify(status === 200 ? envelope : { error: 'session revoked' }), { status });
  });
  const initial = await verify(ownerRequest());
  const resolve = createCurrentActorResolver(verify);
  assert.equal(hasCurrentPermission(initial, 'console.his.manage'), true);
  envelope = ownerEnvelope({ data: { permissions: ['console.role.viewer'], permissionRevision: '8' } });
  const current = await resolve(initial);
  assert.equal(current.authzRevision, '8');
  assert.equal(hasCurrentPermission(current, 'console.his.manage'), false);
  assert.equal(hasCurrentPermission(current, 'console.ceph.read'), true);
  assert.equal(hasCurrentPermission(current, 'console.extension.install'), false);
  assert.equal(hasCurrentPermission(initial, 'console.his.manage'), true, 'Historical evidence is not mutated');
  status = 401;
  await assert.rejects(resolve(initial), { code: 401 });
  status = 503;
  await assert.rejects(resolve(initial), { code: 503 });
  assert.equal(calls, 4, 'No subject-only authorization cache');
});

test('delegation cannot switch browser session or accept a fabricated actor without a credential', async () => {
  let envelope = ownerEnvelope();
  const verify = verifierWith(async () => new Response(JSON.stringify(envelope)));
  const initial = await verify(ownerRequest());
  const resolve = createCurrentActorResolver(verify);
  await assert.rejects(resolve({ ...initial, bearerToken: '' }), { code: 401 });
  envelope = ownerEnvelope({ data: { sessionId: '33333333-3333-4333-8333-333333333333' } });
  await assert.rejects(resolve(initial), { code: 401 });
});

test('HISS and Ceph use GUI canonical roles; old group names or AI permission labels cannot grant management', () => {
  for (const role of ['admin', 'operator', 'viewer']) {
    const actor = { permissions: [`console.role.${role}`] };
    for (const domain of ['his', 'ceph']) {
      assert.equal(hasCurrentPermission(actor, `console.${domain}.read`), true);
      assert.equal(hasCurrentPermission(actor, `console.${domain}.manage`), role === 'admin');
    }
  }
  for (const actor of [{ groups: ['console-admins'] }, { permissions: ['console.his.manage', 'console.ceph.manage'] }, {}]) {
    assert.equal(hasCurrentPermission(actor, 'console.his.manage'), false);
    assert.equal(hasCurrentPermission(actor, 'console.ceph.manage'), false);
  }
  assert.equal(hasCurrentPermission({ permissions: ['console.role.viewer'] }, 'osaa.unassigned.permission'), false);
  assert.equal(hasCurrentPermission({ permissions: ['osaa.chat.use'] }, 'osaa.chat.use'), true);
});

test('target Owner identity revalidates current authority and keeps auth and browser session coordinates distinct', async () => {
  const calls = [];
  const verify = verifierWith(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(ownerEnvelope()), { status: 200 });
  });
  const actor = await verify(ownerRequest({ headers: { 'x-os-correlation-id': 'x'.repeat(200) } }));
  assert.equal(actor.provider, 'console-target-session');
  assert.equal(actor.subject, SUBJECT);
  assert.equal(actor.browserSessionId, BROWSER_SESSION);
  assert.equal(actor.authSessionRef, AUTH_SESSION_REF);
  assert.deepEqual(actor.groups, ['console-admins']);
  assert.deepEqual(actor.permissions, ['console.audit.read', 'console.role.admin']);
  assert.equal(actor.credentialRevision, 7);
  assert.equal(actor.authzRevision, '7');
  assert.equal(actor.revokeEpoch, '3');
  assert.equal(calls[0].url, 'http://opensphere-console-api.test/api/identity/me');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers['x-os-owner-admission'], 'osaa-gateway-v1');
  assert.equal(calls[0].options.headers['x-os-correlation-id'].length, 128);
  assert.equal(Object.hasOwn(calls[0].options.headers, 'cookie'), false);
});

test('legacy identity path remains available until the atomic browser cutover', async () => {
  const verify = createConsoleIdentityVerifier({
    baseUrl: 'http://opensphere-console-backend.test',
    async fetchImpl(url, options) {
      assert.equal(url, 'http://opensphere-console-backend.test/api/identity/session');
      assert.equal(Object.hasOwn(options.headers, 'x-os-owner-admission'), false);
      return new Response(JSON.stringify({
        subject: 'legacy-user', groups: ['console-operators'], permissions: ['catalog:read'], assurance: 'aal1',
      }), { status: 200 });
    },
  });
  const actor = await verify({ headers: { authorization: 'Bearer ' + 'legacy-token-value'.padEnd(32, 'x') } });
  assert.equal(actor.provider, 'supabase');
  assert.equal(actor.username, 'legacy-user');
});

test('C_AI route allowlist covers exact browser methods and rejects same-family expansion', () => {
  const admitted = [
    ['GET', '/api/manual/sources'], ['GET', '/api/osaa/health'],
    ['PATCH', `/api/osaa/conversations/${BROWSER_SESSION}`],
    ['DELETE', '/api/osaa/admin/llm-keys/key-1'],
    ['POST', '/api/osaa/admin/llm-keys/key-1/test'],
    ['POST', `/api/osaa/operations/${BROWSER_SESSION}/approvals`],
    ['POST', `/api/osaa/remediations/${BROWSER_SESSION}/approvals/source`],
    ['POST', `/api/osaa/remediations/${BROWSER_SESSION}/browser-verifications`],
  ];
  for (const [method, path] of admitted) assert.equal(targetPathAllowed(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ['POST', '/api/osaa/health'], ['GET', '/api/osaa/admin/llm-keys/key-1/test'],
    ['POST', '/api/osaa/tools/k8s/events'], ['GET', '/api/osaa/not-a-route'],
    ['GET', '/api/manual/sources/extra'], ['GET', '/api/osaa/operations/------------------------------------'],
    ['GET', '/api/plugins/example'],
  ]) assert.equal(targetPathAllowed(method, path), false, `${method} ${path}`);
});

test('target Owner rejects raw browser credentials, marker drift, unknown route and missing CSRF proof locally', async () => {
  let calls = 0;
  const verify = verifierWith(async () => { calls += 1; return new Response('{}'); });
  await assert.rejects(verify(ownerRequest({ headers: { cookie: 'raw=browser' } })), { code: 403 });
  await assert.rejects(verify(ownerRequest({ headers: { 'x-os-csrf-token': 'raw-csrf' } })), { code: 403 });
  await assert.rejects(verify(ownerRequest({ headers: { 'x-os-owner-admission': 'wrong-v1' } })), { code: 403 });
  await assert.rejects(verify(ownerRequest({ path: '/api/osaa/tools/k8s/events', method: 'POST', headers: { 'x-os-owner-csrf-verified': 'true' } })), { code: 403 });
  await assert.rejects(verify(ownerRequest({ path: '/api/osaa/chat', method: 'POST' })), { code: 403 });
  assert.equal(calls, 0);
});

test('target Owner admits unsafe request only with C_API CSRF exchange proof', async () => {
  const verify = verifierWith(async () => new Response(JSON.stringify(ownerEnvelope({ data: {
    permissions: ['osaa.chat.use'], permissionRevision: '1', revokeEpoch: '0',
  } })), { status: 200 }));
  const actor = await verify(ownerRequest({
    path: '/api/osaa/chat', method: 'POST', headers: { 'x-os-owner-csrf-verified': 'true' },
  }));
  assert.equal(actor.browserSessionId, BROWSER_SESSION);
});

test('target Owner rejects malformed JWT and JWT/projection coordinate mismatch', async () => {
  const verify = verifierWith(async () => new Response(JSON.stringify(ownerEnvelope()), { status: 200 }));
  await assert.rejects(verify(ownerRequest({ headers: { authorization: 'Bearer a.b.c' } })), { code: 401 });
  await assert.rejects(verify(ownerRequest({ headers: { authorization: `Bearer ${token({ sub: 'not-a-uuid' })}` } })), { code: 401 });
  await assert.rejects(verify(ownerRequest({ headers: { authorization: `Bearer ${token({ sub: '33333333-3333-4333-8333-333333333333' })}` } })), { code: 503 });
  await assert.rejects(verify(ownerRequest({ headers: { authorization: `Bearer ${token({ aal: 'aal1' })}` } })), { code: 503 });
});

test('target Owner requires the exact bounded current authority envelope', async () => {
  const invalid = [
    ownerEnvelope({ schemaVersion: '2.0' }),
    ownerEnvelope({ observedAt: 'invalid' }),
    ownerEnvelope({ data: { sessionId: 'not-a-uuid' } }),
    ownerEnvelope({ data: { permissionRevision: 7 } }),
    ownerEnvelope({ data: { permissionRevision: '07' } }),
    ownerEnvelope({ data: { revokeEpoch: -1 } }),
    ownerEnvelope({ data: { revokeEpoch: '-1' } }),
    ownerEnvelope({ data: { permissions: Array.from({ length: 257 }, (_, i) => `osaa.permission.${i}`) } }),
    ownerEnvelope({ data: { permissions: ['INVALID PERMISSION'] } }),
  ];
  for (const envelope of invalid) {
    const verify = verifierWith(async () => new Response(JSON.stringify(envelope), { status: 200 }));
    await assert.rejects(verify(ownerRequest()), { code: 503 });
  }
});

test('target Owner preserves authority denial and maps authority failure to service unavailable', async () => {
  for (const [upstream, expected] of [[401, 401], [403, 403], [429, 401], [500, 503], [502, 503]]) {
    const verify = verifierWith(async () => new Response(JSON.stringify({ error: 'rejected' }), { status: upstream }));
    await assert.rejects(verify(ownerRequest()), { code: expected });
  }
});
