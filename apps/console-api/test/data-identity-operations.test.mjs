import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createDataIdentityOperations, createSupabaseLiveProbes } from '../src/data-identity-operations.mjs';
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
      { component: 'dataApi', state: 'Unknown', authority: 'SupabasePostgREST', reasonCode: 'LiveProbeUnavailable' },
      { component: 'storage', state: 'Unknown', authority: 'SupabaseStorage', reasonCode: 'LiveProbeUnavailable' },
      { component: 'migration', state: 'Partial', authority: 'PostgreSQLCatalog', reasonCode: 'BaselineObjectsPresentManifestLedgerMissing' },
      { component: 'rls', state: 'Ready', authority: 'PostgreSQLCatalog', reasonCode: null },
      { component: 'backup', state: 'Unknown', authority: 'RecoveryOwner', reasonCode: 'EvidenceUnavailable' },
      { component: 'restore', state: 'Unknown', authority: 'RecoveryOwner', reasonCode: 'EvidenceUnavailable' },
    ],
  },
  authority: 'Supabase',
  observedAt: '2026-09-02T00:00:00.000Z',
  freshness: 'fresh',
  correlationId: 'supabase-status-test-0001',
  evidenceRefs: ['supabase-postgresql:connected'],
};

async function healthService(t) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, accept: request.headers.accept });
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'application/openapi+json' });
      return response.end(JSON.stringify({ openapi: '3.0.0', paths: { '/console': {} } }));
    }
    if (request.url === '/health' || request.url === '/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end('{}');
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: 'http://127.0.0.1:' + server.address().port, requests };
}

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

test('Supabase live probes run only after DB authorization and preserve unproven recovery states', async (t) => {
  const { origin, requests } = await healthService(t);
  let authorized = false;
  const liveProbes = createSupabaseLiveProbes({
    authUrl: origin,
    dataApiUrl: origin,
    storageUrl: origin,
    fetchImpl(url, options) {
      assert.equal(authorized, true);
      return fetch(url, options);
    },
    now: () => new Date('2026-09-02T01:00:00.000Z'),
  });
  const operations = createDataIdentityOperations({
    store: { async getSupabaseStatus() { authorized = true; return envelope; } },
    liveProbes,
    now: () => new Date('2026-09-02T01:00:01.000Z'),
  });
  const result = await operations.getSupabaseStatus({ session, correlationId: 'supabase-live-probe-0001' });
  assert.equal(result.data.state, 'Degraded');
  assert.deepEqual(
    result.data.components.filter((item) => ['auth', 'dataApi', 'storage'].includes(item.component)).map((item) => [item.component, item.state, item.reasonCode]),
    [['auth', 'Ready', null], ['dataApi', 'Ready', null], ['storage', 'Ready', null]],
  );
  assert.equal(result.data.components.find((item) => item.component === 'migration').state, 'Partial');
  assert.equal(result.data.components.find((item) => item.component === 'backup').state, 'Unknown');
  assert.deepEqual(result.evidenceRefs.slice(-3), [
    'supabase-auth:health:ready',
    'supabase-postgrest:openapi:ready',
    'supabase-storage:status:ready',
  ]);
  assert.deepEqual(requests.map((item) => item.url).sort(), ['/', '/health', '/status']);
  assert.ok(requests.every((item) => !/token|credential|secret/i.test(item.accept)));
});

test('Supabase live probes keep timeout unknown and explicit bad health contracts blocked', async () => {
  const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const liveProbes = createSupabaseLiveProbes({
    authUrl: 'http://auth.test', dataApiUrl: 'http://rest.test', storageUrl: 'http://storage.test',
    async fetchImpl(url) {
      if (url.startsWith('http://auth.test')) return new Response('', { status: 503 });
      if (url.startsWith('http://rest.test')) return new Response('{}', { status: 200 });
      throw timeoutError;
    },
    now: () => new Date('2026-09-02T01:00:00.000Z'),
  });
  const observed = await liveProbes.observe();
  assert.deepEqual(observed.map((item) => [item.component, item.state, item.reasonCode]), [
    ['auth', 'Blocked', 'HealthCheckFailed'],
    ['dataApi', 'Blocked', 'HealthContractInvalid'],
    ['storage', 'Unknown', 'DependencyTimeout'],
  ]);
});

test('Supabase live probes do not run when DB authorization fails', async () => {
  let probeCalls = 0;
  const operations = createDataIdentityOperations({
    store: { async getSupabaseStatus() { throw Object.assign(new Error('denied'), { code: 'PermissionDenied' }); } },
    liveProbes: { async observe() { probeCalls += 1; return []; } },
  });
  await assert.rejects(operations.getSupabaseStatus({ session, correlationId: 'supabase-live-probe-denied-0001' }), { code: 'PermissionDenied' });
  assert.equal(probeCalls, 0);
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
    headers: { 'x-os-correlation-id': 'supabase-status-http-0001' },
  });
  assert.equal(response.status, 200);
  const projection = await response.json();
  assert.equal(projection.authority, 'Supabase');
  assert.equal(projection.data.state, 'Degraded');
  assert.deepEqual(resolverCalls, [{ requireCsrf: false, correlationId: 'supabase-status-http-0001' }]);
});
