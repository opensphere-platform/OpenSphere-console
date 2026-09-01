import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createIdentityOperations } from '../src/identity-operations.mjs';
import { createPostgresOperationStore } from '../src/postgres-operation-store.mjs';

const current = new Date('2026-09-01T00:00:00.000Z');
const session = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  subjectId: '11111111-1111-4111-8111-111111111111',
  expiresAt: '2026-09-01T01:00:00.000Z',
  revokedAt: null,
  authorityFresh: true,
  permissions: ['console.registry.manage', 'console.audit.read'],
  permissionRevision: '7',
  revokeEpoch: '2',
  aal: 'aal2',
};

function fixture() {
  const revoked = [];
  const identityOperations = createIdentityOperations({
    store: { async revokeSession(input) { revoked.push(input); return { revokedAt: current.toISOString() }; } },
    clock: () => current,
  });
  return { identityOperations, revoked };
}

test('session and actor projections expose current authority without opaque handles', () => {
  const { identityOperations } = fixture();
  const sessionEnvelope = identityOperations.getSession({ session, correlationId: 'identity-session-read-0001' });
  const actorEnvelope = identityOperations.getMe({ session, correlationId: 'identity-actor-read-0001' });
  assert.equal(sessionEnvelope.authority, 'SupabaseAuth');
  assert.equal(sessionEnvelope.data.state, 'Active');
  assert.equal(actorEnvelope.data.subjectId, session.subjectId);
  assert.deepEqual(actorEnvelope.data.permissions, ['console.audit.read', 'console.registry.manage']);
  for (const projection of [sessionEnvelope, actorEnvelope]) {
    assert.doesNotMatch(JSON.stringify(projection.data), /sessionId|token|cookie|csrf/i);
  }
});

test('session revoke binds the current authority revision and no credential', async () => {
  const { identityOperations, revoked } = fixture();
  await identityOperations.revokeSession({ session, correlationId: 'identity-session-revoke-0001' });
  assert.deepEqual(revoked[0], {
    sessionId: session.sessionId,
    actorRef: session.subjectId,
    expectedPermissionRevision: 7,
    expectedRevokeEpoch: 2,
    correlationId: 'identity-session-revoke-0001',
  });
});

test('identity projections reject stale, revoked and expired sessions', async () => {
  const { identityOperations, revoked } = fixture();
  for (const candidate of [
    { ...session, authorityFresh: false },
    { ...session, revokedAt: current.toISOString() },
    { ...session, expiresAt: current.toISOString() },
    { ...session, expiresAt: 'not-a-timestamp' },
  ]) {
    assert.throws(() => identityOperations.getMe({ session: candidate, correlationId: 'identity-denied-0001' }), {
      code: 'AuthenticationRequired',
    });
    await assert.rejects(identityOperations.revokeSession({
      session: candidate, correlationId: 'identity-revoke-denied-0001',
    }), { code: 'AuthenticationRequired' });
  }
  assert.equal(revoked.length, 0);
});

test('PostgreSQL session revoke binds session, actor and current revisions', async () => {
  const calls = [];
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ revocation_record: { revokedAt: current.toISOString() } }] };
    },
  });
  await store.revokeSession({
    sessionId: session.sessionId,
    actorRef: session.subjectId,
    expectedPermissionRevision: 7,
    expectedRevokeEpoch: 2,
    correlationId: 'identity-store-revoke-0001',
  });
  assert.match(calls[0].sql, /console_identity\.revoke_browser_session/);
  assert.deepEqual(calls[0].values, [session.sessionId, session.subjectId, 7, 2, 'identity-store-revoke-0001']);
});

test('HTTP identity routes separate read CSRF policy from revoke mutation', async (t) => {
  const { identityOperations, revoked } = fixture();
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) {
      resolverCalls.push(options);
      return session;
    },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const sessionResponse = await fetch(origin + '/api/identity/session', {
    headers: { 'x-correlation-id': 'http-identity-session-read-0001' },
  });
  const meResponse = await fetch(origin + '/api/identity/me', {
    headers: { 'x-correlation-id': 'http-identity-actor-read-0001' },
  });
  const revokeResponse = await fetch(origin + '/api/identity/session', {
    method: 'DELETE', headers: { 'x-correlation-id': 'http-identity-session-revoke-0001' },
  });
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).data.state, 'Active');
  assert.equal(meResponse.status, 200);
  assert.equal((await meResponse.json()).data.subjectId, session.subjectId);
  assert.equal(revokeResponse.status, 204);
  const expiredCookies = revokeResponse.headers.getSetCookie();
  assert.equal(expiredCookies.length, 2);
  assert.match(expiredCookies[0], /^__Host-opensphere-session=;/);
  assert.match(expiredCookies[1], /^__Host-opensphere_csrf=;/);
  assert.ok(expiredCookies.every((cookie) => cookie.includes('Max-Age=0')));
  assert.deepEqual(resolverCalls, [{ requireCsrf: false }, { requireCsrf: false }, { requireCsrf: true }]);
  assert.equal(revoked.length, 1);
});
