import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createAuditOperations } from '../src/audit-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createPostgresOperationStore } from '../src/postgres-operation-store.mjs';

const current = new Date('2026-09-01T00:00:00.000Z');
const session = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  subjectId: '11111111-1111-4111-8111-111111111111',
  expiresAt: '2026-09-01T01:00:00.000Z',
  revokedAt: null,
  authorityFresh: true,
  permissions: ['console.audit.read'],
  permissionRevision: '7',
  revokeEpoch: '2',
  aal: 'aal2',
};

function envelope(correlationId) {
  return {
    schemaVersion: '1.0',
    data: { items: [], nextCursor: null },
    authority: 'SupabaseAuditLedger',
    observedAt: current.toISOString(),
    freshness: 'fresh',
    correlationId,
    evidenceRefs: [],
  };
}

test('audit read binds current authority and a bounded decimal cursor', async () => {
  const calls = [];
  const auditOperations = createAuditOperations({
    store: {
      async listAuditEvents(input) {
        calls.push(input);
        return envelope(input.correlationId);
      },
    },
    clock: () => current,
  });
  const result = await auditOperations.list({
    session,
    cursor: '42',
    limit: '25',
    correlationId: 'audit-read-correlation-0001',
  });
  assert.equal(result.authority, 'SupabaseAuditLedger');
  assert.deepEqual(calls[0], {
    sessionId: session.sessionId,
    actorRef: session.subjectId,
    expectedPermissionRevision: 7,
    expectedRevokeEpoch: 2,
    cursor: '42',
    limit: 25,
    correlationId: 'audit-read-correlation-0001',
  });
});

test('audit read rejects missing permission and malformed pagination before storage', async () => {
  const calls = [];
  const auditOperations = createAuditOperations({
    store: { async listAuditEvents(input) { calls.push(input); return envelope(input.correlationId); } },
    clock: () => current,
  });
  await assert.rejects(auditOperations.list({
    session: { ...session, permissions: [] }, correlationId: 'audit-denied-correlation-0001',
  }), { code: 'PermissionDenied' });
  await assert.rejects(auditOperations.list({
    session, cursor: '0 OR 1=1', correlationId: 'audit-cursor-correlation-0001',
  }), { code: 'ValidationFailed' });
  await assert.rejects(auditOperations.list({
    session, limit: 201, correlationId: 'audit-limit-correlation-0001',
  }), { code: 'ValidationFailed' });
  assert.equal(calls.length, 0);
});

test('PostgreSQL audit projection binds all authority and pagination coordinates', async () => {
  const calls = [];
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ read_envelope: envelope(values[6]) }] };
    },
  });
  await store.listAuditEvents({
    sessionId: session.sessionId,
    actorRef: session.subjectId,
    expectedPermissionRevision: 7,
    expectedRevokeEpoch: 2,
    cursor: '42',
    limit: 25,
    correlationId: 'audit-store-correlation-0001',
  });
  assert.match(calls[0].sql, /console_audit\.list_events/);
  assert.deepEqual(calls[0].values, [
    session.sessionId, session.subjectId, 7, 2, '42', 25, 'audit-store-correlation-0001',
  ]);
});

test('HTTP audit route is read-only and preserves bounded pagination', async (t) => {
  const calls = [];
  const resolverCalls = [];
  const auditOperations = createAuditOperations({
    store: {
      async listAuditEvents(input) {
        calls.push(input);
        return envelope(input.correlationId);
      },
    },
    clock: () => current,
  });
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) {
      resolverCalls.push(options);
      return session;
    },
    operationService: {},
    registryOperations: {},
    auditOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(
    'http://127.0.0.1:' + address.port + '/api/identity/audit?cursor=42&limit=25',
    { headers: { 'x-os-correlation-id': 'http-audit-correlation-0001' } },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.authority, 'SupabaseAuditLedger');
  assert.equal(resolverCalls[0].requireCsrf, false);
  assert.equal(calls[0].cursor, '42');
  assert.equal(calls[0].limit, 25);
});
