import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createDataIdentityOperations } from '../src/data-identity-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createPostgresOperationStore } from '../src/postgres-operation-store.mjs';

const session = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  subjectId: '11111111-1111-4111-8111-111111111111',
  permissionRevision: '7',
  revokeEpoch: '2',
};

const envelope = {
  schemaVersion: '1.0',
  data: {
    state: 'Degraded',
    required: true,
    components: [
      { component: 'database', state: 'Ready', authority: 'SupabasePostgreSQL', reasonCode: null },
      { component: 'auth', state: 'Unknown', authority: 'SupabaseAuth', reasonCode: 'LiveProbeUnavailable' },
    ],
  },
  authority: 'Supabase',
  observedAt: '2026-09-02T00:00:00.000Z',
  freshness: 'fresh',
  correlationId: 'supabase-status-test-0001',
  evidenceRefs: ['supabase-postgresql:connected'],
};

test('Supabase status binds current session revisions to its projection store', async () => {
  const calls = [];
  const operations = createDataIdentityOperations({
    store: { async getSupabaseStatus(input) { calls.push(input); return envelope; } },
  });
  assert.equal(await operations.getSupabaseStatus({ session, correlationId: 'supabase-status-test-0001' }), envelope);
  assert.deepEqual(calls[0], {
    sessionId: session.sessionId,
    actorRef: session.subjectId,
    expectedPermissionRevision: 7,
    expectedRevokeEpoch: 2,
    correlationId: 'supabase-status-test-0001',
  });
});

test('Supabase status rejects malformed session authority before storage', async () => {
  const operations = createDataIdentityOperations({
    store: { async getSupabaseStatus() { throw new Error('must not be called'); } },
  });
  await assert.rejects(operations.getSupabaseStatus({
    session: { ...session, revokeEpoch: 'not-a-revision' },
    correlationId: 'supabase-status-denied-0001',
  }), { code: 'AuthenticationRequired' });
});

test('PostgreSQL Supabase status binds all authority coordinates', async () => {
  const calls = [];
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ read_envelope: envelope }] };
    },
  });
  assert.equal(await store.getSupabaseStatus({
    sessionId: session.sessionId,
    actorRef: session.subjectId,
    expectedPermissionRevision: 7,
    expectedRevokeEpoch: 2,
    correlationId: 'supabase-status-store-0001',
  }), envelope);
  assert.match(calls[0].sql, /console_identity\.get_supabase_status/);
  assert.deepEqual(calls[0].values, [session.sessionId, session.subjectId, 7, 2, 'supabase-status-store-0001']);
});

test('HTTP Supabase status is a session-revalidated read', async (t) => {
  const resolverCalls = [];
  const dataIdentityOperations = createDataIdentityOperations({
    store: { async getSupabaseStatus() { return envelope; } },
  });
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) { resolverCalls.push(options); return session; },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {}, dataIdentityOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/identity/supabase/status', {
    headers: { 'x-correlation-id': 'supabase-status-http-0001' },
  });
  assert.equal(response.status, 200);
  const projection = await response.json();
  assert.equal(projection.authority, 'Supabase');
  assert.equal(projection.data.state, 'Degraded');
  assert.deepEqual(resolverCalls, [{ requireCsrf: false }]);
});
