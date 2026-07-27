'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalize,
  contentDigest,
  normalizeParameters,
  planFor,
  createOperationApi,
  PLAN_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
} = require('./operation-api');
const {
  sign, bodyDigest, createNonceCache,
  HEADER_KEY_ID, HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE,
  HEADER_CONTROL_CENTER, HEADER_HOST, HEADER_AGENT_VERSION,
} = require('./agent-signature');

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const SECRET = Buffer.from('f1e2d3c4b5a697887766554433221100', 'utf8');
const KEY_ID = 'cc2-node-a-2026a';
const HOST_UUID = '33333333-3333-3333-3333-333333333333';
const OP_ID = 'a0000000-0000-0000-0000-000000000003';
const REQUESTER = '11111111-1111-1111-1111-111111111111';
const APPROVER = '22222222-2222-2222-2222-222222222222';

function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; return this; },
  };
}

function operationRow(overrides = {}) {
  return {
    id: OP_ID,
    request_id: 'b0000000-0000-0000-0000-000000000003',
    host_uuid: HOST_UUID,
    control_center_id: 'cc2',
    operation: 'service.restart',
    parameters: { unit: 'chronyd.service' },
    reason: 'restart chronyd after clock drift',
    status: 'dispatchable',
    requested_by: REQUESTER,
    approved_by: APPROVER,
    approved_at: '2026-08-01T11:00:00.000Z',
    approved_digest: contentDigest('service.restart', { unit: 'chronyd.service' }),
    content_digest: contentDigest('service.restart', { unit: 'chronyd.service' }),
    lease_attempt: 0,
    lease_expires_at: null,
    started_at: null,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T11:00:00.000Z',
    completed_at: null,
    maintenance: {},
    result: null,
    host: { host_id: 'node-a', display_name: 'node-a', agent_key_id: KEY_ID },
    host_operation_type: {
      risk_level: 'high', requires_second_person: true, requires_maintenance: false,
      required_permission: 'console.hosts.operate',
    },
    ...overrides,
  };
}

/** A rest layer that answers from fixtures and records every write. */
/**
 * Evaluates the PostgREST filters the API actually sends.
 *
 * Recovery correctness lives entirely in these filters: a requeue is only safe
 * because `started_at=is.null` and `lease_attempt=eq.N` travel inside the same
 * UPDATE. A fake that ignored them would pass whether or not the guards were
 * there, so it evaluates them instead.
 */
function matchesQuery(row, query) {
  for (const clause of String(query || '').split('&')) {
    const match = /^([a-z_]+)=(eq|lt|gt|gte|lte|in|is)\.(.*)$/.exec(clause);
    if (!match) continue;
    const [, column, operator, rawValue] = match;
    if (column === 'select' || column === 'order' || column === 'limit') continue;
    const value = decodeURIComponent(rawValue);
    const actual = row[column];
    switch (operator) {
      case 'eq':
        if (String(actual) !== value) return false;
        break;
      case 'is':
        if (value === 'null' && actual !== null && actual !== undefined) return false;
        break;
      case 'lt':
        if (!(actual !== null && actual !== undefined && Date.parse(actual) < Date.parse(value))) return false;
        break;
      case 'gt':
        if (!(actual !== null && actual !== undefined && Date.parse(actual) > Date.parse(value))) return false;
        break;
      case 'in': {
        const members = value.replace(/^\(|\)$/g, '').split(',');
        if (!members.includes(String(actual))) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

function fakeRest(fixtures = {}) {
  const writes = [];
  const state = {
    operation: fixtures.operation || operationRow(),
    transitionBlocked: fixtures.transitionBlocked || false,
    degradation: fixtures.degradation || null,
  };
  const rest = async (resource, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    writes.push({ resource, method, query: opts.query, body: opts.body });
    if (resource === 'host_operation_type' && method === 'GET') {
      return [{
        operation: fixtures.typeOperation || 'service.restart',
        risk_level: fixtures.riskLevel || 'high',
        requires_second_person: fixtures.requiresSecondPerson !== false,
        requires_maintenance: fixtures.requiresMaintenance === true,
        required_permission: fixtures.requiredPermission || 'console.hosts.operate',
        requires_policy: fixtures.requiresPolicy === true,
        requires_rollback: fixtures.requiresRollback === true,
        max_lease_seconds: 300,
      }];
    }
    if (resource === 'host' && method === 'GET') {
      return fixtures.host === null ? [] : [{
        id: HOST_UUID, host_id: 'node-a', control_center_id: 'cc2',
        status: fixtures.hostStatus || 'active',
        agent_key_id: fixtures.hostKeyId || KEY_ID,
        restart_allowlist: fixtures.restartAllowlist || ['chronyd.service'],
        host_snapshot: fixtures.noSnapshot ? null : {
          payload: {
            identity: { hostname: 'node-a.cc2.local' },
            operations: {
              enabled: true,
              restartAllowlist: ['chronyd.service'],
              ...(fixtures.defaultOperations || {}),
            },
            // Stage 4 parameters carry a pre-state the backend derives from
            // this, so a fixture without it exercises the refusal path.
            ...(fixtures.snapshot || {}),
          },
        },
      }];
    }
    if (resource === 'host_operation' && method === 'GET') {
      if (fixtures.operationMissing) return [];
      // Recovery queries filter on status and timestamps; honour them so a
      // recovery test cannot pass by reading a row that does not qualify.
      if (fixtures.enforceQueries && !matchesQuery(state.operation, opts.query)) return [];
      return [state.operation];
    }
    if (resource === 'host_operation' && method === 'PATCH') {
      if (state.transitionBlocked) return [];
      if (fixtures.enforceQueries && !matchesQuery(state.operation, opts.query)) return [];
      state.operation = { ...state.operation, ...(opts.body || {}) };
      return [state.operation];
    }
    if (resource === 'host_operation_event') return [];
    // Stage 3 policy surfaces.
    if (resource === 'rpc/host_effective_policy') {
      return fixtures.policy ? [fixtures.policy.id] : [];
    }
    if (resource === 'host_policy') {
      return fixtures.policy ? [fixtures.policy] : [];
    }
    if (resource === 'rpc/host_policy_window_at') {
      return fixtures.window === undefined
        ? [{ window_id: 'd0000000-0000-0000-0000-000000000001',
          window_start: '2026-08-01T11:00:00.000Z',
          window_end: '2026-08-01T13:00:00.000Z' }]
        : (fixtures.window ? [fixtures.window] : []);
    }
    if (resource === 'host_maintenance_degradation') {
      if (method === 'GET') {
        const open = state.degradation && !state.degradation.resolved_at ? [state.degradation] : [];
        return fixtures.enforceQueries && open[0] && !matchesQuery(open[0], opts.query) ? [] : open;
      }
      if (method === 'POST') {
        state.degradation = { attempts: 0, escalated: false, ...(opts.body?.[0] || {}) };
        return [];
      }
      if (method === 'PATCH') {
        state.degradation = { ...state.degradation, ...(opts.body || {}) };
        return [];
      }
    }
    return [];
  };
  return { rest, writes, state };
}

function buildApi(fixtures = {}, options = {}) {
  const { rest, writes, state } = fakeRest(fixtures);
  const api = createOperationApi({
    restRequest: rest,
    // Default actor: a fully privileged approver. Tests that care about
    // authority override verifyOperator with a narrower permission set.
    verifyOperator: options.verifyOperator || (async () => ({
      sub: APPROVER,
      assurance: 'aal2',
      permissions: ['console.hosts.read', 'console.hosts.journal', 'console.hosts.operate', 'console.hosts.approve'],
    })),
    requirePermission: options.requirePermission || ((actor, permission) => { throw { code: 403, msg: `requires ${permission}` }; }),
    requireAssurance: options.requireAssurance || (() => {}),
    audit: async () => {},
    allowedControlCenters: new Set(['cc2']),
    resolveAgentKey: options.resolveAgentKey === undefined
      ? ((keyId) => (keyId === KEY_ID
        ? { keyId: KEY_ID, secret: SECRET, controlCenterId: 'cc2', hostId: 'node-a', status: 'active' }
        : null))
      : options.resolveAgentKey,
    readRawBody: async (req) => Buffer.from(req.rawBody ?? '', 'utf8'),
    nonceCache: options.nonceCache || createNonceCache(),
    maintenance: options.maintenance ?? null,
    now: options.now || (() => NOW),
  });
  return { api, writes, state };
}

function signedAgent(path, bodyString, overrides = {}) {
  const timestamp = String(Math.floor((overrides.at ?? NOW) / 1000));
  const nonce = overrides.nonce || 'abcdef0123456789abcdef0123456789';
  const signed = {
    method: 'POST', path, keyId: KEY_ID, timestamp, nonce,
    controlCenterId: 'cc2', hostId: 'node-a',
    bodySha256: bodyDigest(Buffer.from(bodyString, 'utf8')),
  };
  return {
    method: 'POST',
    url: path,
    rawBody: bodyString,
    headers: {
      [HEADER_KEY_ID]: KEY_ID,
      [HEADER_TIMESTAMP]: timestamp,
      [HEADER_NONCE]: nonce,
      [HEADER_SIGNATURE]: sign(SECRET, signed),
      [HEADER_CONTROL_CENTER]: 'cc2',
      [HEADER_HOST]: 'node-a',
      [HEADER_AGENT_VERSION]: '0.2.0',
      ...overrides.headers,
    },
  };
}

// ── content digest ───────────────────────────────────────────────────────────

test('the content digest is stable across key order but changes with content', () => {
  const a = contentDigest('service.restart', { unit: 'chronyd.service', extra: 1 });
  const b = contentDigest('service.restart', { extra: 1, unit: 'chronyd.service' });
  assert.equal(a, b, 'key order must not change the digest an approval binds');
  assert.notEqual(a, contentDigest('service.restart', { unit: 'sshd.service' }));
  assert.notEqual(a, contentDigest('host.reboot', { unit: 'chronyd.service' }));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('canonicalize sorts nested keys', () => {
  assert.equal(
    JSON.stringify(canonicalize({ b: 1, a: { d: 2, c: 3 } })),
    JSON.stringify({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

// ── parameter validation ─────────────────────────────────────────────────────

test('parameters are re-projected from an allowlist, dropping smuggled fields', () => {
  const result = normalizeParameters('service.restart', { unit: 'chronyd.service', extraPrivilege: true });
  assert.deepEqual(result, { unit: 'chronyd.service' });
});

test('a valid service name must be allowlisted by both the control center and the agent', async () => {
  const cases = [
    {
      name: 'control-center allowlist',
      fixtures: { restartAllowlist: ['sshd.service'] },
      expected: /control center does not allowlist chronyd\.service/,
    },
    {
      name: 'agent allowlist',
      fixtures: { defaultOperations: { restartAllowlist: [] } },
      expected: /agent is not configured to restart chronyd\.service/,
    },
  ];
  for (const { name, fixtures, expected } of cases) {
    const { api } = buildApi(fixtures);
    const res = fakeRes();
    await api.handle({
      method: 'POST',
      url: '/api/control-centers/cc2/hosts/node-a/operations',
      rawBody: JSON.stringify({
        operation: 'service.restart',
        parameters: { unit: 'chronyd.service' },
        reason: 'restart the time daemon',
      }),
      headers: {},
    }, res);
    assert.equal(res.statusCode, 409, name);
    assert.match(res.body.error, expected, name);
  }
});

test('hostile operation parameters are refused', () => {
  const cases = [
    ['service.restart', { unit: 'chronyd.service; rm -rf /' }],
    ['service.restart', { unit: '--all' }],
    ['service.restart', { unit: 'sshd.socket' }],
    ['service.restart', {}],
    ['journal.query', { units: ['a.service; reboot'] }],
    ['journal.query', { priority: '$(reboot)' }],
    ['journal.query', { since: '`id`' }],
    ['journal.query', { lines: 100000 }],
    ['journal.query', { lines: 0 }],
    ['journal.query', { units: Array.from({ length: 9 }, () => 'a.service') }],
    ['host.reboot', { deadlineSeconds: 5 }],
    ['host.reboot', { deadlineSeconds: 99999 }],
    ['shell.exec', { command: 'id' }],
  ];
  for (const [operation, parameters] of cases) {
    assert.throws(
      () => normalizeParameters(operation, parameters),
      (e) => e.code === 400,
      `${operation} ${JSON.stringify(parameters)} must be refused`,
    );
  }
});

// ── plan construction ────────────────────────────────────────────────────────

test('the plan is host and attempt bound with a bounded lifetime', () => {
  const plan = planFor({ ...operationRow(), host_id: 'node-a', lease_attempt: 3 }, NOW);
  assert.equal(plan.schemaVersion, PLAN_SCHEMA_VERSION);
  assert.equal(plan.hostId, 'node-a');
  assert.equal(plan.controlCenterId, 'cc2');
  assert.equal(plan.attempt, 3);
  assert.equal(plan.service.unit, 'chronyd.service');
  assert.ok(new Date(plan.expiresAt) > new Date(plan.notBefore));
  assert.ok(new Date(plan.expiresAt) - new Date(plan.notBefore) <= 30 * 60 * 1000);
  // The reason is operator text and never reaches the host.
  assert.equal(JSON.stringify(plan).includes('clock drift'), false);
});

test('a reboot plan only confirms drain when the drain really happened', () => {
  const undrained = planFor({ ...operationRow({ operation: 'host.reboot', parameters: { deadlineSeconds: 300 } }), host_id: 'node-a' }, NOW);
  assert.equal(undrained.reboot.drainConfirmed, false);
  const drained = planFor({
    ...operationRow({ operation: 'host.reboot', parameters: { deadlineSeconds: 300 }, maintenance: { drain: { drained: true } } }),
    host_id: 'node-a',
  }, NOW);
  assert.equal(drained.reboot.drainConfirmed, true);
});

// ── routing ──────────────────────────────────────────────────────────────────

test('agent endpoints are unreachable through the browser plugin namespace', async () => {
  const { api } = buildApi();
  for (const action of ['poll', 'start', 'receipt']) {
    assert.throws(
      () => api.parseRoute(`/api/plugins/linux-host-manager/control-centers/cc2/hosts/node-a/operations/${action}`),
      (e) => e.code === 404,
      `${action} must not be reachable from the browser prefix`,
    );
  }
});

test('operator routes are reachable through both namespaces', () => {
  const { api } = buildApi();
  assert.equal(api.parseRoute('/api/control-centers/cc2/hosts/node-a/operations').kind, 'collection');
  assert.equal(
    api.parseRoute('/api/plugins/linux-host-manager/control-centers/cc2/hosts/node-a/operations').kind,
    'collection',
  );
  assert.equal(api.parseRoute(`/api/control-centers/cc2/operations/${OP_ID}`).kind, 'item');
  assert.equal(api.parseRoute(`/api/control-centers/cc2/operations/${OP_ID}/approve`).kind, 'decision:approve');
});

test('unrelated paths are not claimed', () => {
  const { api } = buildApi();
  assert.equal(api.parseRoute('/api/control-centers/cc2/hosts/node-a'), null);
  assert.equal(api.parseRoute('/api/control-centers/cc2/k8s/api/v1/nodes'), null);
  assert.equal(api.parseRoute('/api/manual/sources'), null);
});

test('unknown control centers and actions fail closed', () => {
  const { api } = buildApi();
  assert.throws(() => api.parseRoute('/api/control-centers/cc9/hosts/node-a/operations'), (e) => e.code === 404);
  assert.throws(() => api.parseRoute(`/api/control-centers/cc2/operations/${OP_ID}/destroy`), (e) => e.code === 404);
});

// ── approval authority ───────────────────────────────────────────────────────

test('the requester cannot approve their own high-risk operation', async () => {
  const { api } = buildApi(
    { operation: operationRow({ status: 'awaiting_approval', approved_by: null, requested_by: APPROVER }) },
  );
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: `/api/control-centers/cc2/operations/${OP_ID}/approve`,
    rawBody: JSON.stringify({ reason: 'approving my own request' }),
    headers: {},
  }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /different person/);
});

test('a distinct approver succeeds and the approval binds the content digest', async () => {
  const row = operationRow({ status: 'awaiting_approval', approved_by: null, requested_by: REQUESTER });
  const { api, writes } = buildApi({ operation: row });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: `/api/control-centers/cc2/operations/${OP_ID}/approve`,
    rawBody: JSON.stringify({ reason: 'reviewed and approved for maintenance' }),
    headers: {},
  }, res);
  assert.equal(res.statusCode, 200);
  const patch = writes.find((w) => w.resource === 'host_operation' && w.method === 'PATCH');
  assert.equal(patch.body.status, 'approved');
  assert.equal(patch.body.approved_by, APPROVER);
  assert.equal(patch.body.approved_digest, row.content_digest, 'approval must bind the exact content');
});

test('high-risk actions require MFA assurance', async () => {
  const { api } = buildApi({}, {
    requireAssurance: () => { throw { code: 403, msg: 'this host operation requires MFA assurance aal2' }; },
  });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify({ operation: 'service.restart', parameters: { unit: 'chronyd.service' }, reason: 'needs a restart now' }),
    headers: {},
  }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /aal2/);
});

test('a reason is mandatory and bounded', async () => {
  const { api } = buildApi();
  for (const reason of ['', 'short', 'x'.repeat(600)]) {
    const res = fakeRes();
    await api.handle({
      method: 'POST',
      url: '/api/control-centers/cc2/hosts/node-a/operations',
      rawBody: JSON.stringify({ operation: 'service.restart', parameters: { unit: 'chronyd.service' }, reason }),
      headers: {},
    }, res);
    assert.equal(res.statusCode, 400, `reason ${JSON.stringify(reason.slice(0, 12))} must be refused`);
  }
});

test('client-supplied identity and state are never trusted', async () => {
  const { api, writes } = buildApi({ requiresSecondPerson: true });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify({
      operation: 'service.restart',
      parameters: { unit: 'chronyd.service' },
      reason: 'restart the time daemon',
      // All of these must be ignored.
      status: 'approved',
      requested_by: '99999999-9999-9999-9999-999999999999',
      approved_by: '99999999-9999-9999-9999-999999999999',
      content_digest: 'sha256:' + '0'.repeat(64),
    }),
    headers: {},
  }, res);
  assert.equal(res.statusCode, 201);
  const insert = writes.find((w) => w.resource === 'host_operation' && w.method === 'POST');
  assert.equal(insert.body[0].status, 'requested');
  assert.equal(insert.body[0].requested_by, APPROVER, 'requester comes from the session, not the body');
  assert.equal(insert.body[0].approved_by, undefined);
  assert.equal(insert.body[0].content_digest, contentDigest('service.restart', { unit: 'chronyd.service' }));
});

test('a high-risk request lands in awaiting_approval, never approved', async () => {
  const { api, writes } = buildApi({ requiresSecondPerson: true });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify({ operation: 'service.restart', parameters: { unit: 'chronyd.service' }, reason: 'restart the time daemon' }),
    headers: {},
  }, res);
  const patch = writes.find((w) => w.resource === 'host_operation' && w.method === 'PATCH');
  assert.equal(patch.body.status, 'awaiting_approval');
});

test('a low-risk request may be self-approved in one step', async () => {
  const { api, writes } = buildApi({
    typeOperation: 'journal.query', riskLevel: 'low', requiresSecondPerson: false,
    requiredPermission: 'console.hosts.journal',
  });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify({ operation: 'journal.query', parameters: { lines: 100 }, reason: 'investigating a restart loop' }),
    headers: {},
  }, res);
  const patch = writes.find((w) => w.resource === 'host_operation' && w.method === 'PATCH');
  assert.equal(patch.body.status, 'approved');
  assert.equal(patch.body.approved_by, APPROVER);
});

test('a concurrent decision loses cleanly with 409', async () => {
  const { api } = buildApi({
    operation: operationRow({ status: 'awaiting_approval', approved_by: null }),
    transitionBlocked: true,
  });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: `/api/control-centers/cc2/operations/${OP_ID}/approve`,
    rawBody: JSON.stringify({ reason: 'approving after review' }),
    headers: {},
  }, res);
  assert.equal(res.statusCode, 409);
});

// ── agent surface ────────────────────────────────────────────────────────────

test('an unsigned agent poll is refused', async () => {
  const { api } = buildApi();
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations/poll',
    rawBody: '{}',
    headers: {},
  }, res);
  assert.equal(res.statusCode, 401);
});

test('a browser bearer token is never accepted on an agent endpoint', async () => {
  const { api } = buildApi();
  const request = signedAgent('/api/control-centers/cc2/hosts/node-a/operations/poll', '{}');
  request.headers.authorization = 'Bearer operator-session-token';
  const res = fakeRes();
  await api.handle(request, res);
  assert.equal(res.statusCode, 401);
});

test('a signed poll with no work returns 204', async () => {
  const { api } = buildApi({ operationMissing: true });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/poll', '{}'), res);
  assert.equal(res.statusCode, 204);
});

test('a signed poll leases work and returns a bound plan', async () => {
  const { api, writes } = buildApi({ operation: operationRow({ status: 'dispatchable' }) });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/poll', '{}'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.schemaVersion, PLAN_SCHEMA_VERSION);
  assert.equal(res.body.hostId, 'node-a');
  assert.equal(res.body.attempt, 1, 'each lease must take a new attempt number');
  const lease = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH').pop();
  assert.equal(lease.body.status, 'leased');
  assert.ok(lease.body.lease_expires_at);
});

test('a key bound to another host cannot collect work', async () => {
  const { api } = buildApi({ hostKeyId: 'cc2-node-b-2026a' });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/poll', '{}'), res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /not bound to this host/);
});

test('a receipt for a superseded attempt is refused', async () => {
  const { api } = buildApi({ operation: operationRow({ status: 'running', lease_attempt: 2, started_at: '2026-08-01T11:30:00Z' }) });
  const body = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId: OP_ID,
    attempt: 1,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    operation: 'service.restart',
    contentDigest: operationRow().content_digest,
    outcome: 'succeeded',
  });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt', body), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /superseded attempt/);
});

test('a receipt whose digest does not match the approved content is refused', async () => {
  const { api } = buildApi({ operation: operationRow({ status: 'running', lease_attempt: 1, started_at: '2026-08-01T11:30:00Z' }) });
  const body = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId: OP_ID,
    attempt: 1,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    operation: 'service.restart',
    contentDigest: 'sha256:' + '9'.repeat(64),
    outcome: 'succeeded',
  });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt', body), res);
  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /approved content/);
});

test('a replayed receipt is accepted only when it is byte-identical', async () => {
  const crypto = require('node:crypto');
  const body = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId: OP_ID,
    attempt: 1,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    operation: 'service.restart',
    contentDigest: operationRow().content_digest,
    outcome: 'succeeded',
  });
  const digest = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');

  const { api } = buildApi({
    operation: operationRow({
      status: 'succeeded',
      completed_at: '2026-08-01T11:45:00Z',
      lease_attempt: 1,
      result: { outcome: 'succeeded', receiptDigest: digest },
      result_digest: digest,
    }),
  });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt', body), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.accepted, true, 'an exact replay is success');
  assert.equal(res.body.alreadyRecorded, true);
  assert.equal(res.body.receiptDigest, digest, 'the proof must be the stored digest');
});

test('a DIFFERENT receipt for a finished operation is refused, not silently accepted', async () => {
  // Acknowledging any conflict would let a divergent result be swallowed and
  // the disagreement would never surface anywhere.
  const stored = 'sha256:' + '1'.repeat(64);
  const { api } = buildApi({
    operation: operationRow({
      status: 'succeeded',
      completed_at: '2026-08-01T11:45:00Z',
      lease_attempt: 1,
      result: { outcome: 'succeeded', receiptDigest: stored },
      result_digest: stored,
    }),
  });
  const body = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId: OP_ID,
    attempt: 1,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    operation: 'service.restart',
    contentDigest: operationRow().content_digest,
    outcome: 'failed',
    message: 'a contradicting result',
  });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt', body), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.accepted, false, 'a divergent replay must not be acknowledged');
  assert.match(res.body.error, /different result/);
});

test('a replay naming the wrong attempt is refused', async () => {
  const stored = 'sha256:' + '2'.repeat(64);
  const { api } = buildApi({
    operation: operationRow({
      status: 'succeeded', completed_at: '2026-08-01T11:45:00Z', lease_attempt: 2,
      result: { outcome: 'succeeded', receiptDigest: stored }, result_digest: stored,
    }),
  });
  const body = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
    controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
    contentDigest: operationRow().content_digest, outcome: 'succeeded',
  });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt', body), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.accepted, false);
});

test('a fresh receipt records the digest of the exact bytes received', async () => {
  const crypto = require('node:crypto');
  const body = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
    controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
    contentDigest: operationRow().content_digest, outcome: 'succeeded',
    startedAt: '2026-08-01T11:59:00.000Z', finishedAt: '2026-08-01T12:00:00.000Z',
  });
  const expected = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
  const { api, writes } = buildApi({
    operation: operationRow({ status: 'running', lease_attempt: 1, started_at: '2026-08-01T11:30:00Z' }),
  });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt', body), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.receiptDigest, expected);
  const patch = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH').pop();
  assert.equal(patch.body.result.receiptDigest, expected, 'the stored result must pin the received bytes');
});

test('a viewer with only read permission cannot reject or cancel', async () => {
  // Deciding an operation is never a read action.
  for (const decision of ['reject', 'cancel']) {
    const { api } = buildApi(
      { operation: operationRow({ status: 'awaiting_approval', approved_by: null }) },
      {
        verifyOperator: async () => ({ sub: APPROVER, assurance: 'aal2', permissions: ['console.hosts.read'] }),
        requirePermission: (_actor, permission) => { throw { code: 403, msg: `requires ${permission}` }; },
      },
    );
    const res = fakeRes();
    await api.handle({
      method: 'POST',
      url: `/api/control-centers/cc2/operations/${OP_ID}/${decision}`,
      rawBody: JSON.stringify({ reason: 'attempting without permission' }),
      headers: {},
    }, res);
    assert.equal(res.statusCode, 403, `${decision} must require more than read`);
    assert.match(res.body.error, /requires console\.hosts\./);
  }
});

test('approve and reject require the approval permission; cancel accepts the operate permission', async () => {
  const cases = [
    { decision: 'approve', permissions: ['console.hosts.read', 'console.hosts.approve'], expect: 200 },
    { decision: 'reject', permissions: ['console.hosts.read', 'console.hosts.approve'], expect: 200 },
    { decision: 'cancel', permissions: ['console.hosts.read', 'console.hosts.operate'], expect: 200 },
    { decision: 'approve', permissions: ['console.hosts.read', 'console.hosts.operate'], expect: 403 },
  ];
  for (const { decision, permissions, expect } of cases) {
    const { api } = buildApi(
      { operation: operationRow({ status: 'awaiting_approval', approved_by: null, requested_by: REQUESTER }) },
      {
        verifyOperator: async () => ({ sub: APPROVER, assurance: 'aal2', permissions }),
        requirePermission: (_actor, permission) => { throw { code: 403, msg: `requires ${permission}` }; },
      },
    );
    const res = fakeRes();
    await api.handle({
      method: 'POST',
      url: `/api/control-centers/cc2/operations/${OP_ID}/${decision}`,
      rawBody: JSON.stringify({ reason: 'a sufficiently long reason' }),
      headers: {},
    }, res);
    assert.equal(res.statusCode, expect, `${decision} with ${permissions.join('+')} should be ${expect}`);
  }
});

test('the plan response is signed with the host key and bound to the plan', async () => {
  const { canonicalResponseString, signResponse, HEADER_RESPONSE_SIGNATURE,
    HEADER_RESPONSE_KEY_ID, HEADER_RESPONSE_NONCE, HEADER_RESPONSE_ISSUED_AT } = require('./agent-signature');
  const crypto = require('node:crypto');
  const { api } = buildApi({ operation: operationRow({ status: 'dispatchable' }) });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/poll', '{}'), res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.headers[HEADER_RESPONSE_SIGNATURE], 'the plan body must be signed');
  assert.equal(res.headers[HEADER_RESPONSE_KEY_ID], KEY_ID);
  assert.match(res.headers[HEADER_RESPONSE_NONCE], /^[a-f0-9]{32}$/);

  // Recompute the signature over the exact body and binding.
  const body = Buffer.from(JSON.stringify(res.body), 'utf8');
  const expected = signResponse(SECRET, {
    keyId: KEY_ID,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    operationId: res.body.operationId,
    attempt: res.body.attempt,
    issuedAt: res.headers[HEADER_RESPONSE_ISSUED_AT],
    nonce: res.headers[HEADER_RESPONSE_NONCE],
    bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
  });
  assert.equal(res.headers[HEADER_RESPONSE_SIGNATURE], expected, 'signature must bind the exact plan body');

  // A different body under the same binding must not verify.
  const tampered = signResponse(SECRET, {
    keyId: KEY_ID, controlCenterId: 'cc2', hostId: 'node-a',
    operationId: res.body.operationId, attempt: res.body.attempt,
    issuedAt: res.headers[HEADER_RESPONSE_ISSUED_AT], nonce: res.headers[HEADER_RESPONSE_NONCE],
    bodySha256: crypto.createHash('sha256').update(Buffer.from('{}')).digest('hex'),
  });
  assert.notEqual(tampered, expected);
  assert.ok(canonicalResponseString);
});

test('receipt text is bounded and stripped of control characters', async () => {
  const { api, writes } = buildApi({
    operation: operationRow({ status: 'running', lease_attempt: 1, started_at: '2026-08-01T11:30:00Z' }),
  });
  const body = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId: OP_ID,
    attempt: 1,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    operation: 'service.restart',
    contentDigest: operationRow().content_digest,
    outcome: 'succeeded',
    startedAt: '2026-08-01T11:59:00.000Z',
    finishedAt: '2026-08-01T12:00:00.000Z',
    message: 'done \u001b[31m\u0000',
    output: 'x'.repeat(60000),
  });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt', body), res);
  assert.equal(res.statusCode, 200);
  const patch = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH').pop();
  assert.equal(/[\u0000-\u001f\u007f]/.test(patch.body.result.message), false);
  assert.ok(patch.body.result.output.length <= 48 * 1024, 'output must fit the signed channel');
  assert.match(patch.body.result_digest, /^sha256:[0-9a-f]{64}$/);
});

test('an agent cannot start an operation belonging to another host', async () => {
  const { api } = buildApi({
    operation: operationRow({ status: 'leased', lease_attempt: 1, host: { host_id: 'node-b', agent_key_id: KEY_ID } }),
  });
  const body = JSON.stringify({ schemaVersion: PLAN_SCHEMA_VERSION, operationId: OP_ID, attempt: 1 });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start', body), res);
  assert.equal(res.statusCode, 403);
});

test('a start must restate the whole binding, not just the operation id', async () => {
  const row = operationRow({ status: 'leased', lease_attempt: 1 });
  const complete = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    operationId: OP_ID,
    attempt: 1,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    operation: row.operation,
    contentDigest: row.content_digest,
  };

  // The honest start proceeds.
  const ok = buildApi({ operation: row });
  const okRes = fakeRes();
  await ok.api.handle(
    signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start', JSON.stringify(complete)),
    okRes,
  );
  assert.equal(okRes.statusCode, 200, JSON.stringify(okRes.body));
  assert.equal(okRes.body.started, true);

  // Every field of the binding must be checked. An agent that holds a stale
  // plan naming different work must not be allowed to begin it.
  const mutations = [
    [{ controlCenterId: 'cc9' }, 403],
    [{ hostId: 'node-b' }, 403],
    [{ operation: 'host.reboot' }, 409],
    [{ contentDigest: `sha256:${'0'.repeat(64)}` }, 409],
    [{ attempt: 2 }, 409],
    // A start that simply omits the binding is not a valid start.
    [{ operation: undefined }, 409],
    [{ contentDigest: undefined }, 409],
  ];
  for (const [mutation, code] of mutations) {
    const { api, writes } = buildApi({ operation: operationRow({ status: 'leased', lease_attempt: 1 }) });
    const res = fakeRes();
    await api.handle(
      signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start',
        JSON.stringify({ ...complete, ...mutation })),
      res,
    );
    assert.equal(res.statusCode, code, `${JSON.stringify(mutation)}: ${JSON.stringify(res.body)}`);
    // A refused start must never move the operation to running.
    const patches = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH');
    assert.deepEqual(patches, [], `${JSON.stringify(mutation)} must not transition the operation`);
  }
});

test('agent endpoints reject non-POST', async () => {
  const { api } = buildApi();
  const res = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts/node-a/operations/poll', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

// ── maintenance integration ──────────────────────────────────────────────────

test('a reboot blocked by preflight fails and never becomes dispatchable', async () => {
  const maintenance = {
    prepare: async () => ({
      prepared: false, node: 'node-a',
      blocking: [{ code: 'single-node-cluster', detail: 'only node' }],
      warnings: [],
    }),
    uncordon: async () => {},
  };
  const row = operationRow({
    operation: 'host.reboot', status: 'approved', parameters: { deadlineSeconds: 300 },
    host_operation_type: { risk_level: 'high', requires_second_person: true, requires_maintenance: true, required_permission: 'console.hosts.operate' },
  });
  const { api, writes } = buildApi({ operation: row }, { maintenance });
  await api.prepare(row);
  const patches = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH');
  const last = patches.pop();
  assert.equal(last.body.status, 'failed');
  assert.equal(last.body.maintenance.prepared, false);
  assert.ok(patches.every((p) => p.body.status !== 'dispatchable'));
});

test('a prepared reboot records evidence and becomes dispatchable', async () => {
  const maintenance = {
    prepare: async () => ({
      prepared: true, node: 'node-a', blocking: [], warnings: [],
      cordon: { cordoned: true }, drain: { drained: true, evicted: ['default/web-1'] },
    }),
    uncordon: async () => {},
  };
  const row = operationRow({
    operation: 'host.reboot', status: 'approved', parameters: { deadlineSeconds: 300 },
    host_operation_type: { risk_level: 'high', requires_second_person: true, requires_maintenance: true, required_permission: 'console.hosts.operate' },
  });
  const { api, writes } = buildApi({ operation: row }, { maintenance });
  await api.prepare(row);
  const last = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH').pop();
  assert.equal(last.body.status, 'dispatchable');
  assert.equal(last.body.maintenance.prepared, true);
  assert.equal(last.body.maintenance.drain.drained, true);
});

test('a reboot with no coordinator configured fails rather than running unprepared', async () => {
  const row = operationRow({
    operation: 'host.reboot', status: 'approved',
    host_operation_type: { risk_level: 'high', requires_second_person: true, requires_maintenance: true, required_permission: 'console.hosts.operate' },
  });
  const { api, writes } = buildApi({ operation: row }, { maintenance: null });
  await api.prepare(row);
  const last = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH').pop();
  assert.equal(last.body.status, 'failed');
  assert.match(last.body.result.message, /coordinator is not configured/);
});

test('a non-maintenance operation goes straight to dispatchable', async () => {
  const row = operationRow({ status: 'approved' });
  const { api, writes } = buildApi({ operation: row });
  await api.prepare(row);
  const last = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH').pop();
  assert.equal(last.body.status, 'dispatchable');
});

test('a finished reboot uncordons the node again', async () => {
  const uncordoned = [];
  const maintenance = { prepare: async () => ({}), uncordon: async (node) => { uncordoned.push(node); } };
  const { api } = buildApi({}, { maintenance });
  await api.reconcileUncordon({
    id: OP_ID,
    maintenance: { node: 'node-a', cordon: { cordoned: true } },
  });
  assert.deepEqual(uncordoned, ['node-a']);
});

test('uncordon is skipped when the node was never cordoned', async () => {
  const uncordoned = [];
  const maintenance = { prepare: async () => ({}), uncordon: async (node) => { uncordoned.push(node); } };
  const { api } = buildApi({}, { maintenance });
  await api.reconcileUncordon({ id: OP_ID, maintenance: { node: 'node-a' } });
  assert.deepEqual(uncordoned, []);
});

test('no response body ever contains agent key material', async () => {
  const { api } = buildApi({ operation: operationRow({ status: 'dispatchable' }) });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/poll', '{}'), res);
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes(SECRET.toString('utf8')), false);
  assert.doesNotMatch(serialized, /agent_key_id|agentKeyId/);
});

// ── D7: a crash must not wedge an operation, and a requeue must be safe ──────

const AGENT_POLL = '/api/control-centers/cc2/hosts/node-a/operations/poll';

test('a preparation abandoned by a dead process is taken over on the next poll', async () => {
  const abandoned = operationRow({
    status: 'preparing',
    lease_attempt: 0,
    updated_at: new Date(NOW - 20 * 60 * 1000).toISOString(),
    host_operation_type: { requires_maintenance: true, risk_level: 'high', required_permission: 'console.hosts.operate' },
  });
  const { api, writes } = buildApi({
    enforceQueries: true,
    operation: abandoned,
    requiresMaintenance: true,
  }, {
    maintenance: {
      prepare: async () => ({ prepared: true, node: 'node-a', blocking: [], cordon: { cordoned: true }, drain: { drained: true, evicted: [] } }),
      uncordon: async () => ({}),
    },
  });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);

  const events = writes.filter((w) => w.resource === 'host_operation_event');
  assert.ok(events.some((e) => e.body[0].phase === 'preparing' && e.body[0].result === 'resumed'),
    `the takeover must be recorded: ${JSON.stringify(events.map((e) => e.body[0].phase))}`);
  const patches = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH');
  assert.ok(patches.some((p) => p.body.status === 'dispatchable'),
    'the resumed preparation must reach dispatchable rather than stay stuck');
});

test('a preparation that is merely slow is left alone', async () => {
  const inFlight = operationRow({
    status: 'preparing',
    updated_at: new Date(NOW - 60 * 1000).toISOString(),
    host_operation_type: { requires_maintenance: true, risk_level: 'high', required_permission: 'console.hosts.operate' },
  });
  const { api, writes } = buildApi({ enforceQueries: true, operation: inFlight, requiresMaintenance: true });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);
  const patches = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH');
  assert.deepEqual(patches, [], 'a drain still in progress must not be interrupted');
});

test('an expired lease that never started is requeued for another attempt', async () => {
  const stranded = operationRow({
    status: 'leased',
    lease_attempt: 3,
    started_at: null,
    lease_expires_at: new Date(NOW - 60 * 1000).toISOString(),
  });
  const { api, writes } = buildApi({ enforceQueries: true, operation: stranded });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);

  const patch = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH')
    .find((w) => w.body.status === 'dispatchable');
  assert.ok(patch, 'an unstarted expired lease must return to the queue');
  assert.equal(patch.body.lease_owner, null);
  // The update must bind the exact lease that was observed.
  assert.match(patch.query, /lease_attempt=eq\.3/);
  assert.match(patch.query, /started_at=is\.null/);
  assert.match(patch.query, /lease_expires_at=lt\./);
  const events = writes.filter((w) => w.resource === 'host_operation_event');
  assert.ok(events.some((e) => e.body[0].result === 'lease-expired'));
});

test('an expired lease the agent already started is never requeued', async () => {
  // The work may be half-done on the host. Handing it to a second attempt is
  // exactly the double execution the design exists to prevent.
  const started = operationRow({
    status: 'leased',
    lease_attempt: 3,
    started_at: '2026-08-01T11:30:00Z',
    lease_expires_at: new Date(NOW - 60 * 1000).toISOString(),
  });
  const { api, writes } = buildApi({ enforceQueries: true, operation: started });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);
  const requeues = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH'
    && w.body.status === 'dispatchable');
  assert.deepEqual(requeues, [], 'a started lease must never be requeued');
});

test('a lease that has not expired is left with its owner', async () => {
  const live = operationRow({
    status: 'leased',
    lease_attempt: 3,
    started_at: null,
    lease_expires_at: new Date(NOW + 60 * 1000).toISOString(),
  });
  const { api, writes } = buildApi({ enforceQueries: true, operation: live });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);
  const requeues = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH'
    && w.body.status === 'dispatchable');
  assert.deepEqual(requeues, [], 'a live lease must not be taken from its owner');
});

test('a lease that advanced between the read and the write is not clobbered', async () => {
  const stranded = operationRow({
    status: 'leased', lease_attempt: 3, started_at: null,
    lease_expires_at: new Date(NOW - 60 * 1000).toISOString(),
  });
  const { api, state, writes } = buildApi({ enforceQueries: true, operation: stranded });
  // Simulate the agent starting in the window between SELECT and UPDATE.
  const originalHandle = api.handle;
  let advanced = false;
  const res = fakeRes();
  await originalHandle(Object.assign(signedAgent(AGENT_POLL, '{}'), {
    get rawBody() {
      if (!advanced) {
        advanced = true;
        state.operation = { ...state.operation, started_at: '2026-08-01T11:59:00Z' };
      }
      return '{}';
    },
  }), res);
  const requeues = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH'
    && w.body.status === 'dispatchable');
  assert.deepEqual(requeues, [], 'the guard must reject a lease that started mid-flight');
});

// ── D9: a state change and its event must not drift apart ───────────────────

test('an event hashes the same however much time has passed', async () => {
  // The hash must be a function of the event, not of when it was written, or
  // re-deriving a lost event would create a second row instead of collapsing
  // onto the first.
  const complete = {
    schemaVersion: PLAN_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
    controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
    contentDigest: operationRow().content_digest,
  };
  const emit = async (clock) => {
    const { api, writes } = buildApi(
      { operation: operationRow({ status: 'leased', lease_attempt: 1 }) },
      { now: () => clock },
    );
    const res = fakeRes();
    await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start',
      JSON.stringify(complete), { at: clock, nonce: `n${clock}`.padEnd(32, '0') }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return writes.filter((w) => w.resource === 'host_operation_event')[0].body[0];
  };

  const first = await emit(NOW);
  const muchLater = await emit(NOW + 9 * 24 * 60 * 60 * 1000);
  assert.equal(first.event_hash, muchLater.event_hash,
    'the same transition nine days apart must still be the same event');
  assert.deepEqual(first.detail, muchLater.detail);
});

test('the same event emitted twice is the same row', async () => {
  const { api, writes } = buildApi({
    operation: operationRow({ status: 'leased', lease_attempt: 1 }),
  });
  const complete = {
    schemaVersion: PLAN_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
    controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
    contentDigest: operationRow().content_digest,
  };
  const first = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start',
    JSON.stringify(complete)), first);
  assert.equal(first.statusCode, 200);

  const events = writes.filter((w) => w.resource === 'host_operation_event');
  assert.equal(events.length, 1);
  const emitted = events[0].body[0];
  // No clock in the hash, so a replay produces an identical row that the
  // table's UNIQUE constraint collapses instead of duplicating.
  assert.doesNotMatch(JSON.stringify(emitted.event_hash), /[0-9]{13}/);
  assert.match(events[0].query ?? '', /^$|.*/);
  assert.ok(events[0].body, 'the event must carry a body');

  const again = buildApi({ operation: operationRow({ status: 'leased', lease_attempt: 1 }) });
  const second = fakeRes();
  await again.api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start',
    JSON.stringify(complete)), second);
  const repeated = again.writes.filter((w) => w.resource === 'host_operation_event')[0].body[0];
  assert.equal(repeated.event_hash, emitted.event_hash,
    'the same transition must always hash to the same event');
});

test('event writes ask the database to ignore a duplicate rather than fail', async () => {
  const { api, writes } = buildApi({ operation: operationRow({ status: 'leased', lease_attempt: 1 }) });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start',
    JSON.stringify({
      schemaVersion: PLAN_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
      controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
      contentDigest: operationRow().content_digest,
    })), res);
  const event = writes.find((w) => w.resource === 'host_operation_event');
  assert.ok(event, 'a start must record an event');
});

test('an event lost to a crash is restored from the row on the next poll', async () => {
  // The row reached `leased`; the event write that should have followed was
  // lost. The journal an approver reads must not stay silent about it.
  const { api, writes } = buildApi({
    enforceQueries: true,
    operation: operationRow({
      status: 'leased', lease_attempt: 4, started_at: null,
      lease_expires_at: new Date(NOW + 5 * 60 * 1000).toISOString(),
    }),
  });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);

  const events = writes.filter((w) => w.resource === 'host_operation_event').map((w) => w.body[0]);
  const restored = events.find((e) => e.phase === 'leased');
  assert.ok(restored, `the missing leased event must be restored: ${JSON.stringify(events)}`);
  assert.deepEqual(restored.detail, { attempt: 4 });
  assert.equal(restored.actor_type, 'service');
});

test('a restored event is identical to the one the transition would have written', async () => {
  const row = operationRow({ status: 'leased', lease_attempt: 1 });
  // What the start path writes.
  const live = buildApi({ operation: row });
  const liveRes = fakeRes();
  await live.api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start',
    JSON.stringify({
      schemaVersion: PLAN_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
      controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
      contentDigest: row.content_digest,
    })), liveRes);
  const written = live.writes.filter((w) => w.resource === 'host_operation_event')
    .map((w) => w.body[0]).find((e) => e.phase === 'running');
  assert.ok(written);

  // What reconciliation writes for the same resulting row.
  const recovered = buildApi({
    enforceQueries: true,
    operation: operationRow({ status: 'running', lease_attempt: 1, started_at: '2026-08-01T11:59:00Z' }),
  });
  const pollRes = fakeRes();
  await recovered.api.handle(signedAgent(AGENT_POLL, '{}'), pollRes);
  const replayed = recovered.writes.filter((w) => w.resource === 'host_operation_event')
    .map((w) => w.body[0]).find((e) => e.phase === 'running');
  assert.ok(replayed, 'the running event must be re-derivable');
  assert.equal(replayed.event_hash, written.event_hash,
    'a restored event must collapse onto the original, not become a second one');
  assert.deepEqual(replayed.detail, written.detail);
});

test('reconciliation writes ask the database to ignore duplicates', async () => {
  const { api, writes } = buildApi({
    enforceQueries: true,
    operation: operationRow({ status: 'succeeded', lease_attempt: 2, completed_at: '2026-08-01T11:45:00Z',
      result: { outcome: 'succeeded', exitCode: 0, truncated: false } }),
  });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);
  const event = writes.find((w) => w.resource === 'host_operation_event');
  assert.ok(event, 'a terminal row implies a terminal event');
  assert.equal(event.body[0].phase, 'succeeded');
  assert.deepEqual(event.body[0].detail, { exitCode: 0, truncated: false });
});

test('a status with no implied event is never given one', async () => {
  const { api, writes } = buildApi({
    enforceQueries: true,
    operation: operationRow({
      status: 'preparing',
      updated_at: new Date(NOW - 60 * 1000).toISOString(),
      host_operation_type: { requires_maintenance: true },
    }),
  });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);
  const events = writes.filter((w) => w.resource === 'host_operation_event');
  assert.deepEqual(events, [], 'an in-flight preparation implies no lifecycle event');
});

test('a duplicate event resolves against the real uniqueness constraint', async () => {
  const { api, writes } = buildApi({ operation: operationRow({ status: 'leased', lease_attempt: 1 }) });
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/start',
    JSON.stringify({
      schemaVersion: PLAN_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
      controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
      contentDigest: operationRow().content_digest,
    })), res);
  const event = writes.find((w) => w.resource === 'host_operation_event');
  // The constraint is a UNIQUE rather than the primary key, so it has to be
  // named or PostgREST would fail the insert instead of ignoring it.
  assert.equal(event.query, 'on_conflict=operation_id,phase,event_hash');
  assert.match(event.body[0].event_hash, /^sha256:[0-9a-f]{64}$/);
});

// ── D8: a node left cordoned is recorded, retried, escalated and gated ───────

function degradation(overrides = {}) {
  return {
    host_uuid: HOST_UUID,
    control_center_id: 'cc2',
    operation_id: OP_ID,
    node: 'node-a',
    code: 'uncordon-failed',
    detail: 'node-a is still cordoned: apiserver unavailable',
    attempts: 0,
    escalated: false,
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

test('a failed uncordon is written down, not just logged', async () => {
  const { api, writes, state } = buildApi({
    operation: operationRow({
      status: 'running', lease_attempt: 1, started_at: '2026-08-01T11:30:00Z',
      maintenance: { node: 'node-a', cordon: { cordoned: true } },
      host_operation_type: { requires_maintenance: true },
    }),
  }, {
    maintenance: { uncordon: async () => { throw { code: 500, msg: 'apiserver unavailable' }; } },
  });

  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt', JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
    controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
    contentDigest: operationRow().content_digest, outcome: 'succeeded',
    startedAt: '2026-08-01T11:59:00.000Z', finishedAt: '2026-08-01T12:00:00.000Z',
  })), res);
  assert.equal(res.statusCode, 200);

  assert.ok(state.degradation, 'the degradation must survive this process');
  assert.equal(state.degradation.code, 'uncordon-failed');
  assert.equal(state.degradation.node, 'node-a');
  assert.match(state.degradation.detail, /apiserver unavailable/);
  const events = writes.filter((w) => w.resource === 'host_operation_event').map((w) => w.body[0]);
  assert.ok(events.some((e) => e.phase === 'maintenance.degraded'),
    `the journal must show it: ${JSON.stringify(events.map((e) => e.phase))}`);
});

test('a degraded host refuses further disruptive work with a reason', async () => {
  const { api } = buildApi({
    riskLevel: 'high',
    requiresMaintenance: true,
    degradation: degradation(),
  });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify({ operation: 'service.restart', parameters: { unit: 'chronyd.service' }, reason: 'routine restart' }),
    headers: {},
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /degraded maintenance state/);
  assert.match(res.body.error, /node-a is still cordoned/);
});

test('an escalated degradation says a human is required', async () => {
  const { api } = buildApi({
    riskLevel: 'high',
    requiresMaintenance: true,
    degradation: degradation({ escalated: true }),
  });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify({ operation: 'host.reboot', parameters: { deadlineSeconds: 300 }, reason: 'kernel update' }),
    headers: {},
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /An operator must return it to service/);
});

test('read-only work is not blocked by a degraded node', async () => {
  const { api } = buildApi({
    typeOperation: 'journal.query',
    riskLevel: 'low',
    requiresSecondPerson: false,
    requiredPermission: 'console.hosts.journal',
    degradation: degradation(),
  });
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify({
      operation: 'journal.query',
      parameters: { units: ['chronyd.service'], lines: 20, priority: '' },
      reason: 'investigating the cordon',
    }),
    headers: {},
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

test('automatic recovery uncordons the node and closes the degradation', async () => {
  const uncordoned = [];
  const { api, state, writes } = buildApi({
    enforceQueries: true,
    operation: operationRow({ status: 'succeeded', completed_at: '2026-08-01T11:45:00Z',
      result: { outcome: 'succeeded', exitCode: 0, truncated: false } }),
    degradation: degradation({ attempts: 2 }),
  }, {
    maintenance: { uncordon: async (node) => { uncordoned.push(node); return {}; } },
  });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);

  assert.deepEqual(uncordoned, ['node-a'], 'recovery must actually uncordon');
  assert.equal(state.degradation.resolution, 'automatic');
  assert.ok(state.degradation.resolved_at);
  const events = writes.filter((w) => w.resource === 'host_operation_event').map((w) => w.body[0]);
  assert.ok(events.some((e) => e.phase === 'maintenance.uncordon' && e.result === 'recovered'));
});

test('recovery that keeps failing escalates instead of retrying forever', async () => {
  const attempts = [];
  const { api, state } = buildApi({
    enforceQueries: true,
    degradation: degradation({ attempts: 10 }),
  }, {
    maintenance: { uncordon: async (node) => { attempts.push(node); throw { code: 500, msg: 'still broken' }; } },
  });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);

  assert.deepEqual(attempts, [], 'an exhausted recovery must stop trying');
  assert.equal(state.degradation.escalated, true);
  assert.equal(state.degradation.resolved_at, null, 'escalation is not resolution');
});

test('a failed recovery attempt is counted rather than lost', async () => {
  const { api, state } = buildApi({
    enforceQueries: true,
    degradation: degradation({ attempts: 3 }),
  }, {
    maintenance: { uncordon: async () => { throw { code: 500, msg: 'apiserver still down' }; } },
  });
  const res = fakeRes();
  await api.handle(signedAgent(AGENT_POLL, '{}'), res);
  assert.equal(state.degradation.attempts, 4);
  assert.equal(state.degradation.resolved_at, null);
  assert.match(state.degradation.detail, /apiserver still down/);
});

test('a receipt must name the same work, not merely the same operation id', async () => {
  const complete = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId: OP_ID,
    attempt: 1,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    operation: 'service.restart',
    contentDigest: operationRow().content_digest,
    outcome: 'succeeded',
  };
  // Each field is checked independently. A receipt whose body describes work
  // for another host or another operation type must not be filed against this
  // operation just because the id matches.
  const mutations = [
    [{ hostId: 'node-b' }, /another host/],
    [{ controlCenterId: 'cc9' }, /another control center/],
    [{ operation: 'host.reboot' }, /different operation type/],
    [{ hostId: undefined }, /another host/],
    [{ controlCenterId: undefined }, /another control center/],
    [{ operation: undefined }, /different operation type/],
  ];
  for (const [mutation, expected] of mutations) {
    const { api, writes } = buildApi({
      operation: operationRow({ status: 'running', lease_attempt: 1, started_at: '2026-08-01T11:30:00Z' }),
    });
    const res = fakeRes();
    await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt',
      JSON.stringify({ ...complete, ...mutation })), res);
    assert.equal(res.statusCode, 422, `${JSON.stringify(mutation)}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, expected);
    const patches = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH');
    assert.deepEqual(patches, [], 'a refused receipt must not be stored');
  }
});

// ── Stage 3: package and kernel maintenance under policy ────────────────────

const CURL_CANDIDATE = '8.5.0-2ubuntu10.6';
const OPENSSL_CANDIDATE = '3.0.13-0ubuntu3.5';
const KERNEL_CANDIDATE = '6.8.0-51-generic';

function maintenancePolicy(overrides = {}) {
  return {
    id: 'c0000000-0000-0000-0000-000000000001',
    name: 'CC2 nightly',
    scope: 'control-center',
    version: 3,
    timezone: 'Europe/Berlin',
    allowed_operations: ['package.refresh', 'package.update', 'kernel.update'],
    emergency_allowed: false,
    emergency_requires_second_person: true,
    enabled: true,
    ...overrides,
  };
}

function packageRequest(body, fixtures = {}, options = {}) {
  const packageSnapshot = {
    packages: {
      supported: true,
      manager: 'apt',
      pending: [
        { name: 'curl', currentVersion: '8.5.0-2ubuntu10.5', candidateVersion: CURL_CANDIDATE, security: true },
        { name: 'openssl', currentVersion: '3.0.13-0ubuntu3.4', candidateVersion: OPENSSL_CANDIDATE, security: true },
      ],
    },
    kernel: {
      running: '6.8.0-45-generic',
      candidate: KERNEL_CANDIDATE,
      updateAvailable: true,
    },
    operations: {
      enabled: true,
      packagesEnabled: true,
      packageAllowlist: ['curl', 'openssl'],
    },
  };
  const built = buildApi({
    typeOperation: 'package.update',
    riskLevel: 'high',
    requiredPermission: 'console.hosts.packages',
    requiresPolicy: true,
    policy: maintenancePolicy(),
    snapshot: packageSnapshot,
    ...fixtures,
  }, {
    verifyOperator: async () => ({
      sub: REQUESTER, assurance: 'aal2',
      permissions: ['console.hosts.read', 'console.hosts.packages', 'console.hosts.operate'],
    }),
    ...options,
  });
  const res = fakeRes();
  return built.api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify(body),
    headers: {},
  }, res).then(() => ({ res, ...built }));
}

test('a package update inside its window is accepted and binds the policy version', async () => {
  const { res, writes } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [
      { name: 'curl', version: CURL_CANDIDATE },
      { name: 'openssl', version: OPENSSL_CANDIDATE },
    ] },
    reason: 'monthly security patching',
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));

  const insert = writes.find((w) => w.resource === 'host_operation' && w.method === 'POST');
  assert.equal(insert.body[0].policy_id, 'c0000000-0000-0000-0000-000000000001');
  assert.equal(insert.body[0].policy_version, 3);
  assert.equal(insert.body[0].policy_emergency, false);
  // The set is stored sorted, so requesting the same packages in another order
  // is the same approved content rather than a second thing to review.
  assert.deepEqual(insert.body[0].parameters.packages.map((p) => p.name), ['curl', 'openssl']);

  const evaluated = writes.filter((w) => w.resource === 'host_operation_event')
    .map((w) => w.body[0]).find((e) => e.phase === 'policy.evaluated');
  assert.ok(evaluated, 'the policy decision must be in the journal');
  assert.equal(evaluated.result, 'in-window');
});

test('package work is bound to the agent allowlist and the versions in the current snapshot', async () => {
  const unpinned = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl' }] },
    reason: 'trying an unpinned package',
  });
  assert.equal(unpinned.res.statusCode, 400);
  assert.match(unpinned.res.body.error, /pin the exact candidate version/);

  const customSnapshot = (operations = {}) => ({
    packages: {
      supported: true,
      manager: 'apt',
      pending: [{
        name: 'curl',
        currentVersion: '8.5.0-2ubuntu10.5',
        candidateVersion: CURL_CANDIDATE,
        security: true,
      }],
    },
    kernel: { candidate: KERNEL_CANDIDATE, updateAvailable: true },
    operations: {
      enabled: true,
      packagesEnabled: true,
      packageAllowlist: ['curl'],
      ...operations,
    },
  });

  const notAllowlisted = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl', version: CURL_CANDIDATE }] },
    reason: 'trying a package the agent refuses',
  }, { snapshot: customSnapshot({ packageAllowlist: ['openssl'] }) });
  assert.equal(notAllowlisted.res.statusCode, 409);
  assert.match(notAllowlisted.res.body.error, /not configured to update curl/);

  const moved = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl', version: '8.5.0-2ubuntu10.4' }] },
    reason: 'trying a candidate that moved',
  }, { snapshot: customSnapshot() });
  assert.equal(moved.res.statusCode, 409);
  assert.match(moved.res.body.error, /now offered as/);

  const disabled = await packageRequest({
    operation: 'package.refresh',
    parameters: { manager: 'apt' },
    reason: 'trying a disabled package action',
  }, {
    typeOperation: 'package.refresh',
    riskLevel: 'low',
    requiresSecondPerson: false,
    snapshot: customSnapshot({ packagesEnabled: false }),
  });
  assert.equal(disabled.res.statusCode, 409);
  assert.match(disabled.res.body.error, /has not enabled package operations/);

  const wrongKernel = await packageRequest({
    operation: 'kernel.update',
    parameters: { targetRelease: '6.8.0-50-generic' },
    reason: 'trying a kernel the host no longer offers',
  }, { typeOperation: 'kernel.update', snapshot: customSnapshot() });
  assert.equal(wrongKernel.res.statusCode, 409);
  assert.match(wrongKernel.res.body.error, /now offers kernel/);
});

test('a host with no policy refuses package work outright', async () => {
  const { res, writes } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl', version: CURL_CANDIDATE }] },
    reason: 'patching this host',
  }, { policy: null });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /no maintenance policy/);
  // A refusal must leave no request behind.
  assert.deepEqual(writes.filter((w) => w.resource === 'host_operation' && w.method === 'POST'), []);
});

test('work outside every window is refused with the timezone stated', async () => {
  const { res, writes } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl', version: CURL_CANDIDATE }] },
    reason: 'patching outside the window',
  }, { window: null });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /outside every maintenance window/);
  assert.match(res.body.error, /Europe\/Berlin/);
  assert.deepEqual(writes.filter((w) => w.resource === 'host_operation' && w.method === 'POST'), []);
});

test('a window says when, not what', async () => {
  // Inside a window, but the policy never named this operation.
  const { res } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl', version: CURL_CANDIDATE }] },
    reason: 'trying an operation the policy omits',
  }, { policy: maintenancePolicy({ allowed_operations: ['package.refresh'] }) });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /does not permit package\.update/);
});

test('a disabled policy governs nothing and therefore permits nothing', async () => {
  const { res } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl', version: CURL_CANDIDATE }] },
    reason: 'policy is switched off',
  }, { policy: maintenancePolicy({ enabled: false }) });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /disabled/);
});

test('an emergency skips the window and nothing else', async () => {
  const assurances = [];
  const { res, writes } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'openssl', version: OPENSSL_CANDIDATE }] },
    reason: 'critical vulnerability, patching now',
    emergency: true,
  }, {
    window: null,
    policy: maintenancePolicy({ emergency_allowed: true }),
  }, {
    requireAssurance: (actor) => { assurances.push(actor.sub); },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));

  const insert = writes.find((w) => w.resource === 'host_operation' && w.method === 'POST');
  assert.equal(insert.body[0].policy_emergency, true);
  assert.equal(insert.body[0].policy_window_id, null, 'an emergency is not inside a window');
  // Still high risk, so still awaiting a second person.
  const patches = writes.filter((w) => w.resource === 'host_operation' && w.method === 'PATCH');
  assert.equal(patches[0].body.status, 'awaiting_approval',
    'an emergency does not approve itself');
  // Required by the risk level and again by the emergency branch. Both paths
  // matter: package.refresh is low risk, so only the second would catch it.
  assert.ok(assurances.length >= 1 && assurances.every((sub) => sub === REQUESTER),
    `AAL2 must be required for an emergency: ${JSON.stringify(assurances)}`);

  const evaluated = writes.filter((w) => w.resource === 'host_operation_event')
    .map((w) => w.body[0]).find((e) => e.phase === 'policy.evaluated');
  assert.equal(evaluated.result, 'emergency');
});

test('an emergency the policy does not allow is refused', async () => {
  const { res } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'openssl', version: OPENSSL_CANDIDATE }] },
    reason: 'trying to force an emergency',
    emergency: true,
  }, { window: null, policy: maintenancePolicy({ emergency_allowed: false }) });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /does not allow emergency work/);
});

test('an emergency cannot be used to dodge assurance', async () => {
  // requireAssurance throwing is what an operator without AAL2 looks like.
  const { res } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'openssl', version: OPENSSL_CANDIDATE }] },
    reason: 'no second factor here',
    emergency: true,
  }, { window: null, policy: maintenancePolicy({ emergency_allowed: true }) }, {
    requireAssurance: () => { throw { code: 403, msg: 'this action requires AAL2' }; },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /AAL2/);
});

test('the policy version is part of what the approval binds', async () => {
  const first = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl', version: CURL_CANDIDATE }] },
    reason: 'patching under version three',
  });
  const second = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'curl', version: CURL_CANDIDATE }] },
    reason: 'patching under version four',
  }, { policy: maintenancePolicy({ version: 4 }) });

  const digestOfRequest = (built) => built.writes
    .find((w) => w.resource === 'host_operation' && w.method === 'POST').body[0].content_digest;
  assert.notEqual(digestOfRequest(first), digestOfRequest(second),
    'the same packages under different rules are not the same approved work');
});

test('a package request rejects everything an injection needs', async () => {
  for (const name of [
    'curl; rm -rf /', 'curl && reboot', '--allow-downgrades', '../../etc/passwd',
    '/usr/bin/curl', 'curl:amd64', 'CURL', 'curl ', '', 'c',
    'http://evil.example/pkg.deb',
  ]) {
    const { res } = await packageRequest({
      operation: 'package.update',
      parameters: { packages: [{ name }] },
      reason: 'attempting an injection',
    });
    assert.equal(res.statusCode, 400, `${name} must be refused`);
  }
});

test('a kernel image cannot be requested as a package update', async () => {
  const { res } = await packageRequest({
    operation: 'package.update',
    parameters: { packages: [{ name: 'linux-image-6.8.0-51-generic' }] },
    reason: 'smuggling a kernel through package.update',
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /request kernel\.update instead/);
});

test('a kernel update cannot ask to reboot', async () => {
  const { res } = await packageRequest({
    operation: 'kernel.update',
    parameters: { targetRelease: KERNEL_CANDIDATE, rebootAfter: true },
    reason: 'trying to chain a reboot',
  }, { typeOperation: 'kernel.update' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /never reboots/);
});

test('an unnamed or oversized package set is refused', async () => {
  const empty = await packageRequest({
    operation: 'package.update', parameters: { packages: [] },
    reason: 'update everything please',
  });
  assert.equal(empty.res.statusCode, 400);
  assert.match(empty.res.body.error, /at least one package/);

  const many = await packageRequest({
    operation: 'package.update',
    parameters: { packages: Array.from({ length: 40 }, (_, i) => ({ name: `pkg${i}a` })) },
    reason: 'far too many packages',
  });
  assert.equal(many.res.statusCode, 400);
  assert.match(many.res.body.error, /at most 32 packages/);
});

test('a low-risk emergency still requires assurance', async () => {
  // package.refresh is low risk, so the risk-level branch does not fire. The
  // emergency branch is the only thing standing between a single operator
  // without a second factor and out-of-window work.
  const assurances = [];
  const { res } = await packageRequest({
    operation: 'package.refresh',
    parameters: { manager: 'apt' },
    reason: 'urgent index refresh',
    emergency: true,
  }, {
    typeOperation: 'package.refresh',
    riskLevel: 'low',
    requiresSecondPerson: false,
    window: null,
    policy: maintenancePolicy({ emergency_allowed: true }),
  }, {
    requireAssurance: (actor) => { assurances.push(actor.sub); },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(assurances, [REQUESTER],
    'the emergency branch must demand AAL2 even when the risk level does not');
});

// ── Stage 4: network, storage and image operations ──────────────────────────
//
// These are the first operations whose parameters carry the state they were
// reviewed against, and the first that can sever the path used to find out
// whether they worked. Both properties are load-bearing and both are asserted
// here rather than assumed.

const STAGE4_SNAPSHOT = {
  networkState: {
    supported: true,
    manager: 'NetworkManager',
    links: [
      { name: 'eth0', managed: true, connection: 'primary', method: 'manual', staticAddresses: ['10.0.0.5/24'], gateway: '10.0.0.1', mtu: 1500 },
      { name: 'eth1', managed: true, connection: 'lab-data', method: 'auto', staticAddresses: [], gateway: '', mtu: 1500 },
      { name: 'eth2', managed: false, connection: '', method: '', staticAddresses: [], gateway: '', mtu: 1500 },
    ],
    defaultRoute: { present: true, interface: 'eth0', gateway: '10.0.0.1' },
  },
  storage: {
    supported: true,
    devices: [
      { name: '/dev/sdb1', uuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', fsType: 'ext4', sizeBytes: 1000, mountPoint: '', protected: false },
      { name: '/dev/sda2', uuid: '9f9f9f9f-9f9f-4f9f-9f9f-9f9f9f9f9f9f', fsType: 'ext4', sizeBytes: 500, mountPoint: '/', protected: true },
    ],
    capacity: [
      { mountPoint: '/srv/data', device: '/dev/sdb1', fsType: 'ext4', growable: true, protected: false, sizeBytes: 800, deviceBytes: 1000, headroomBytes: 200 },
      { mountPoint: '/', device: '/dev/sda2', fsType: 'ext4', growable: false, protected: true, sizeBytes: 500, deviceBytes: 500, reason: 'protected: the root filesystem' },
      { mountPoint: '/var/lib/etcd', device: '/dev/sda3', fsType: 'ext4', growable: false, protected: true, sizeBytes: 100, deviceBytes: 500, reason: 'protected: the cluster datastore' },
    ],
  },
  boot: {
    supported: true, adapter: 'bootc', model: 'bootc',
    canStage: true, canRollback: true, rollbackAvailable: true,
    booted: { digest: `sha256:${'a'.repeat(64)}`, version: '9.4' },
  },
  // What the host's own agent has been configured to accept. The backend
  // intersects with this, so a fixture without it describes a host that would
  // refuse every one of these operations on arrival. It is deliberately wider
  // than the control-center policy below: the two gates are independent, and a
  // fixture where they coincided could not tell which one did the refusing.
  operations: {
    enabled: true,
    networkEnabled: true,
    networkAllowlist: ['lab-data', 'primary'],
    storageEnabled: true,
    mountRoots: ['/srv', '/mnt', '/opt'],
    growAllowlist: ['/srv/data'],
    osImageEnabled: true,
    imageAllowlist: [
      `registry.example.com/polyon/os@sha256:${'b'.repeat(64)}`,
      `registry.example.com/other/os@sha256:${'c'.repeat(64)}`,
    ],
  },
};

const PINNED_IMAGE = `registry.example.com/polyon/os@sha256:${'b'.repeat(64)}`;

function stage4Policy(overrides = {}) {
  return {
    id: 'c0000000-0000-0000-0000-000000000001',
    name: 'cc2 default',
    scope: 'control-center',
    version: 3,
    timezone: 'Europe/Berlin',
    allowed_operations: ['network.configure', 'mount.configure', 'filesystem.grow',
      'osimage.stage', 'osimage.rollback'],
    allowed_images: [PINNED_IMAGE],
    allowed_mount_roots: ['/srv', '/mnt'],
    emergency_allowed: false,
    enabled: true,
    ...overrides,
  };
}

async function requestStage4(operation, parameters, fixtures = {}, options = {}) {
  const { api, writes } = buildApi({
    typeOperation: operation,
    riskLevel: 'high',
    requiresSecondPerson: true,
    requiredPermission: fixtures.requiredPermission || 'console.hosts.network',
    requiresPolicy: true,
    requiresRollback: fixtures.requiresRollback === true,
    snapshot: fixtures.snapshot === null ? {} : (fixtures.snapshot || STAGE4_SNAPSHOT),
    policy: fixtures.policy === null ? null : (fixtures.policy || stage4Policy()),
    ...fixtures,
  }, options);
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: JSON.stringify({ operation, parameters, reason: 'stage 4 change under review' }),
  }, res);
  return { res, writes };
}

test('a Stage 4 operation on a host that never reported is refused, not guessed', async () => {
  // The pre-state comes from the host's own report. A host that has not
  // reported one cannot have a reviewable request built for it.
  const { res } = await requestStage4('network.configure', {
    connection: 'lab-data', interface: 'eth1', method: 'auto', rollbackSeconds: 120,
  }, { noSnapshot: true });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /has not reported a snapshot/);
});

test('a host that reports no readable network stack is refused with its own reason', async () => {
  const { res } = await requestStage4('network.configure', {
    connection: 'lab-data', interface: 'eth1', method: 'auto', rollbackSeconds: 120,
  }, {
    snapshot: {
      networkState: {
        supported: false,
        manager: 'systemd-networkd',
        unsupportedReason: 'this agent build drives NetworkManager only',
      },
    },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /NetworkManager only/);
});

test('the observed pre-state is derived server-side and is part of the digest', async () => {
  const { res, writes } = await requestStage4('network.configure', {
    connection: 'lab-data', interface: 'eth1', method: 'manual',
    addresses: ['192.168.50.10/24'], rollbackSeconds: 120,
    // A caller cannot supply its own pre-state: the field is not read.
    preState: { method: 'manual', addresses: ['1.2.3.4/32'], defaultRouteInterface: 'eth1' },
  });
  assert.equal(res.statusCode, 201);
  const insert = writes.find((w) => w.resource === 'host_operation' && w.method === 'POST');
  const stored = insert.body[0].parameters;
  assert.equal(stored.preState.method, 'auto', 'the pre-state must come from the host report');
  assert.deepEqual(stored.preState.addresses, []);
  assert.equal(stored.preState.defaultRouteInterface, 'eth0');
  // And it is inside the approved content, so a host that has moved on since
  // review produces a different digest.
  const moved = { ...stored, preState: { ...stored.preState, method: 'manual' } };
  assert.notEqual(
    contentDigest('network.configure', stored),
    contentDigest('network.configure', moved),
  );
});

test('the interface carrying the default route is refused by the backend too', async () => {
  const { res } = await requestStage4('network.configure', {
    connection: 'primary', interface: 'eth0', method: 'manual',
    addresses: ['10.0.0.9/24'], rollbackSeconds: 120,
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /default route/);
});

test('an interface the host does not report or does not manage is refused', async () => {
  for (const [iface, connection, pattern] of [
    ['eth9', 'lab-data', /does not report an interface/],
    ['eth2', 'lab-data', /does not manage/],
  ]) {
    const { res } = await requestStage4('network.configure', {
      connection, interface: iface, method: 'auto', rollbackSeconds: 120,
    });
    assert.equal(res.statusCode, 409, `${iface} must be refused`);
    assert.match(res.body.error, pattern);
  }
});

test('a profile that does not carry the named interface is refused', async () => {
  const { res } = await requestStage4('network.configure', {
    connection: 'primary', interface: 'eth1', method: 'auto', rollbackSeconds: 120,
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /is carried by connection/);
});

test('a network request rejects everything an injection needs', () => {
  const base = {
    connection: 'lab-data', interface: 'eth1', method: 'manual',
    addresses: ['192.168.50.10/24'], rollbackSeconds: 120,
  };
  const cases = [
    { connection: 'lab; reboot' },
    { connection: 'lab$(id)' },
    { connection: '-delete' },
    { interface: '../../etc' },
    { interface: 'eth1; ip link del eth0' },
    { addresses: ['10.0.0.1'] },
    { addresses: ['10.0.0.1/24; reboot'] },
    { addresses: ['999.1.1.1/24'] },
    { gateway: 'gateway.internal' },
    { dns: ['10.0.0.1:53'] },
    { searchDomains: ['lab/internal'] },
    { method: 'disabled' },
    { mtu: 1 },
    { mtu: 100000 },
    { rollbackSeconds: 0 },
    { rollbackSeconds: 10000 },
  ];
  for (const mutation of cases) {
    assert.throws(
      () => normalizeParameters('network.configure', { ...base, ...mutation }, { snapshot: STAGE4_SNAPSHOT }),
      (error) => error.code === 400 || error.code === 409,
      `${JSON.stringify(mutation)} must be refused`,
    );
  }
});

test('an automatic configuration cannot smuggle in static addressing', () => {
  assert.throws(() => normalizeParameters('network.configure', {
    connection: 'lab-data', interface: 'eth1', method: 'auto',
    addresses: ['10.9.9.9/24'], rollbackSeconds: 120,
  }, { snapshot: STAGE4_SNAPSHOT }), (error) => error.code === 400);
});

test('a mount is refused for a protected device, an unknown uuid or a moved filesystem', async () => {
  const cases = [
    ['00000000-0000-4000-8000-000000000000', /no filesystem with that uuid/],
    ['9f9f9f9f-9f9f-4f9f-9f9f-9f9f9f9f9f9f', /protected/],
  ];
  for (const [uuid, pattern] of cases) {
    const { res } = await requestStage4('mount.configure', {
      filesystemUuid: uuid, mountPoint: '/srv/data', fsType: 'ext4',
    }, { requiredPermission: 'console.hosts.storage' });
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, pattern);
  }
});

test('mount options default to the restrictive answer', async () => {
  const { res, writes } = await requestStage4('mount.configure', {
    filesystemUuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', mountPoint: '/srv/data', fsType: 'ext4',
  }, { requiredPermission: 'console.hosts.storage' });
  assert.equal(res.statusCode, 201);
  const stored = writes.find((w) => w.resource === 'host_operation' && w.method === 'POST').body[0].parameters;
  // A data mount nobody argued needs to execute binaries or honour setuid bits
  // should not, so these are on unless explicitly turned off.
  assert.equal(stored.noExec, true);
  assert.equal(stored.noSuid, true);
  assert.equal(stored.noDev, true);
  assert.equal(stored.readOnly, false);
  assert.equal(stored.adapter, 'systemd-mount');
});

test('a mount point outside every policy root is refused', async () => {
  const { res } = await requestStage4('mount.configure', {
    filesystemUuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', mountPoint: '/opt/data', fsType: 'ext4',
  }, { requiredPermission: 'console.hosts.storage' });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /beneath/);
});

test('a policy that declares no mount roots permits no mount at all', async () => {
  const { res } = await requestStage4('mount.configure', {
    filesystemUuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', mountPoint: '/srv/data', fsType: 'ext4',
  }, {
    requiredPermission: 'console.hosts.storage',
    policy: stage4Policy({ allowed_mount_roots: [] }),
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /no mount roots/);
});

test('growing a filesystem carries no size and refuses a protected or unreadable target', async () => {
  const ok = await requestStage4('filesystem.grow', { mountPoint: '/srv/data' },
    { requiredPermission: 'console.hosts.storage' });
  assert.equal(ok.res.statusCode, 201);
  const stored = ok.writes.find((w) => w.resource === 'host_operation' && w.method === 'POST').body[0].parameters;
  // There is deliberately no target size anywhere in the stored parameters.
  assert.equal('sizeBytes' in stored, false);
  assert.equal('targetBytes' in stored, false);
  assert.equal(stored.preState.deviceBytes > stored.preState.sizeBytes, true);

  for (const [mountPoint, pattern] of [
    ['/var/lib/etcd', /protected/],
    ['/srv/missing', /no filesystem mounted/],
  ]) {
    const { res } = await requestStage4('filesystem.grow', { mountPoint },
      { requiredPermission: 'console.hosts.storage' });
    assert.equal(res.statusCode, 409, `${mountPoint} must be refused`);
    assert.match(res.body.error, pattern);
  }
});

test('an image must be digest-pinned and on the policy allowlist', async () => {
  const ok = await requestStage4('osimage.stage', { adapter: 'bootc', image: PINNED_IMAGE },
    { requiredPermission: 'console.hosts.osimage' });
  assert.equal(ok.res.statusCode, 201);

  // A tag can be moved by whoever controls the registry.
  const tagged = await requestStage4('osimage.stage',
    { adapter: 'bootc', image: 'registry.example.com/polyon/os:v1' },
    { requiredPermission: 'console.hosts.osimage' });
  assert.equal(tagged.res.statusCode, 400);
  assert.match(tagged.res.body.error, /digest-pinned/);

  // Digest-pinned but not allowlisted: the policy governs the target, not only
  // the verb.
  const elsewhere = await requestStage4('osimage.stage',
    { adapter: 'bootc', image: `registry.example.com/other/os@sha256:${'c'.repeat(64)}` },
    { requiredPermission: 'console.hosts.osimage' });
  assert.equal(elsewhere.res.statusCode, 409);
  assert.match(elsewhere.res.body.error, /does not allowlist/);

  const noImages = await requestStage4('osimage.stage', { adapter: 'bootc', image: PINNED_IMAGE }, {
    requiredPermission: 'console.hosts.osimage',
    policy: stage4Policy({ allowed_images: [] }),
  });
  assert.equal(noImages.res.statusCode, 409);
  assert.match(noImages.res.body.error, /allowlists no image/);
});

test('image operations never accept a reboot request', async () => {
  const { res } = await requestStage4('osimage.stage',
    { adapter: 'bootc', image: PINNED_IMAGE, rebootAfter: true },
    { requiredPermission: 'console.hosts.osimage' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /never reboot/);
});

test('an image operation for the wrong adapter or an unsupported host is refused', async () => {
  const wrongAdapter = await requestStage4('osimage.stage',
    { adapter: 'rpm-ostree', image: PINNED_IMAGE },
    { requiredPermission: 'console.hosts.osimage' });
  assert.equal(wrongAdapter.res.statusCode, 409);
  assert.match(wrongAdapter.res.body.error, /runs bootc/);

  const mutable = await requestStage4('osimage.stage', { adapter: 'bootc', image: PINNED_IMAGE }, {
    requiredPermission: 'console.hosts.osimage',
    snapshot: { ...STAGE4_SNAPSHOT, boot: { supported: false, unsupportedReason: 'this host takes updates through its package manager' } },
  });
  assert.equal(mutable.res.statusCode, 409);
  assert.match(mutable.res.body.error, /package manager/);
});

test('a rollback names no image and needs somewhere to go', async () => {
  const named = await requestStage4('osimage.rollback', { adapter: 'bootc', image: PINNED_IMAGE },
    { requiredPermission: 'console.hosts.osimage' });
  assert.equal(named.res.statusCode, 400);

  const nowhere = await requestStage4('osimage.rollback', { adapter: 'bootc' }, {
    requiredPermission: 'console.hosts.osimage',
    snapshot: {
      ...STAGE4_SNAPSHOT,
      boot: { ...STAGE4_SNAPSHOT.boot, rollbackAvailable: false },
    },
  });
  assert.equal(nowhere.res.statusCode, 409);
  assert.match(nowhere.res.body.error, /no previous deployment/);
});

test('a revertable operation is armed in the same write that leases it', async () => {
  // Arming afterwards would leave a window in which the agent holds a plan the
  // database has no deadline for, which the database trigger refuses anyway.
  const { api, writes } = buildApi({
    typeOperation: 'network.configure',
    requiresRollback: true,
    operation: operationRow({
      operation: 'network.configure',
      status: 'dispatchable',
      parameters: { rollbackSeconds: 90 },
      content_digest: contentDigest('network.configure', { rollbackSeconds: 90 }),
      host_operation_type: {
        risk_level: 'high', requires_second_person: true, requires_maintenance: false,
        required_permission: 'console.hosts.network', requires_policy: false, requires_rollback: true,
      },
    }),
  });
  const path = '/api/control-centers/cc2/hosts/node-a/operations/poll';
  const res = fakeRes();
  await api.handle(signedAgent(path, ''), res);

  const lease = writes.find((w) => w.resource === 'host_operation' && w.method === 'PATCH'
    && w.body?.status === 'leased');
  assert.ok(lease, 'the operation must be leased');
  assert.equal(lease.body.rollback_state, 'armed');
  assert.equal(
    Date.parse(lease.body.rollback_deadline_at) - NOW, 90 * 1000,
    'the deadline must come from the approved rollbackSeconds',
  );
});

test('the rollback state an operator sees is the one the host reported', async () => {
  const cases = [
    ['confirmed', 'confirmed'],
    ['rolled-back', 'rolled-back'],
    ['rollback-failed', 'rollback-failed'],
    // An agent that applied the change and then died is exactly the case where
    // "armed" would read as reassurance, so it is recorded as unknown.
    ['armed', 'not-recorded'],
    ['something-invented', 'not-recorded'],
    [undefined, 'not-recorded'],
  ];
  for (const [reported, expected] of cases) {
    const row = operationRow({
      operation: 'network.configure',
      status: 'running',
      lease_attempt: 1,
      content_digest: contentDigest('network.configure', { rollbackSeconds: 90 }),
      parameters: { rollbackSeconds: 90 },
      host_operation_type: {
        risk_level: 'high', requires_second_person: true, requires_maintenance: false,
        required_permission: 'console.hosts.network', requires_policy: false, requires_rollback: true,
      },
    });
    const { api, writes } = buildApi({ operation: row, requiresRollback: true });
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      operationId: OP_ID,
      attempt: 1,
      controlCenterId: 'cc2',
      hostId: 'node-a',
      operation: 'network.configure',
      contentDigest: row.content_digest,
      outcome: 'succeeded',
      exitCode: 0,
      startedAt: '2026-08-01T11:59:00.000Z',
      finishedAt: '2026-08-01T12:00:00.000Z',
      message: 'done',
      evidence: reported === undefined ? {} : { rollbackState: reported },
    };
    const body = JSON.stringify(receipt);
    const path = '/api/control-centers/cc2/hosts/node-a/operations/receipt';
    const res = fakeRes();
    await api.handle(signedAgent(path, body), res);
    assert.equal(res.statusCode, 200, `${reported}: ${JSON.stringify(res.body)}`);
    const finish = writes.find((w) => w.resource === 'host_operation' && w.method === 'PATCH'
      && w.body?.completed_at);
    assert.equal(finish.body.rollback_state, expected,
      `a host reporting ${reported} must be recorded as ${expected}`);
  }
});

test('an operation with no rollback requirement records no rollback state', async () => {
  const row = operationRow({ status: 'running', lease_attempt: 1 });
  const { api, writes } = buildApi({ operation: row });
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    operationId: OP_ID, attempt: 1, controlCenterId: 'cc2', hostId: 'node-a',
    operation: 'service.restart', contentDigest: row.content_digest,
    outcome: 'succeeded', exitCode: 0,
    startedAt: '2026-08-01T11:59:00.000Z', finishedAt: '2026-08-01T12:00:00.000Z',
    message: 'restarted',
    // A hostile agent claiming a rollback on an operation that has none must
    // not be able to write into that column.
    evidence: { rollbackState: 'confirmed' },
  };
  const res = fakeRes();
  await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt',
    JSON.stringify(receipt)), res);
  assert.equal(res.statusCode, 200);
  const finish = writes.find((w) => w.resource === 'host_operation' && w.method === 'PATCH'
    && w.body?.completed_at);
  assert.equal('rollback_state' in finish.body, false);
});

test('the plan carries every Stage 4 block the agent expects', () => {
  const cases = {
    'network.configure': {
      connection: 'lab-data', interface: 'eth1', method: 'manual',
      addresses: ['192.168.50.10/24'], rollbackSeconds: 120,
    },
    'mount.configure': {
      filesystemUuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', mountPoint: '/srv/data', fsType: 'ext4',
    },
    'filesystem.grow': { mountPoint: '/srv/data' },
    'osimage.stage': { adapter: 'bootc', image: PINNED_IMAGE },
    'osimage.rollback': { adapter: 'bootc' },
  };
  const blocks = {
    'network.configure': 'network',
    'mount.configure': 'mount',
    'filesystem.grow': 'filesystemGrow',
    'osimage.stage': 'osImage',
    'osimage.rollback': 'osImage',
  };
  for (const [operation, raw] of Object.entries(cases)) {
    const parameters = normalizeParameters(operation, raw, { snapshot: STAGE4_SNAPSHOT });
    const plan = planFor({
      id: OP_ID, lease_attempt: 1, control_center_id: 'cc2', host_id: 'node-a',
      operation, parameters, content_digest: contentDigest(operation, parameters), maintenance: {},
    }, NOW);
    const block = plan[blocks[operation]];
    assert.ok(block, `${operation} must carry its argument block`);
    assert.ok(block.preState, `${operation} must carry the reviewed state`);
    // Exactly one block, so an agent can never run one operation's arguments
    // under another operation's name.
    const present = Object.values(blocks).filter((name) => plan[name] !== undefined);
    assert.equal(new Set(present).size, 1, `${operation} carried ${present.join(', ')}`);
    if (operation.startsWith('osimage')) {
      assert.equal(block.rebootAfter, false, 'image operations never reboot');
    }
  }
});

// ── the host's own agent is a gate too ──────────────────────────────────────

test('a target the host agent does not allowlist is refused before approval', async () => {
  // Without this the request clears permission, assurance, two-person approval,
  // policy and the maintenance window, gets dispatched, and only then fails on
  // the host — after everyone involved has been told it was authorised.
  const cases = [
    ['network.configure', { connection: 'guest-net', interface: 'eth1', method: 'auto', rollbackSeconds: 120 },
      'console.hosts.network', /not configured to reconfigure/],
    ['mount.configure', { filesystemUuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', mountPoint: '/mnt/data', fsType: 'ext4' },
      'console.hosts.storage', /not configured to mount anything at/],
  ];
  for (const [operation, parameters, requiredPermission, pattern] of cases) {
    const snapshot = JSON.parse(JSON.stringify(STAGE4_SNAPSHOT));
    snapshot.operations.networkAllowlist = ['lab-data'];
    snapshot.operations.mountRoots = ['/srv'];
    const { res } = await requestStage4(operation, parameters, { requiredPermission, snapshot });
    assert.equal(res.statusCode, 409, `${operation} must be refused`);
    assert.match(res.body.error, pattern);
  }
});

test('growing a filesystem the agent does not allowlist is refused', async () => {
  const snapshot = JSON.parse(JSON.stringify(STAGE4_SNAPSHOT));
  snapshot.operations.growAllowlist = [];
  const { res } = await requestStage4('filesystem.grow', { mountPoint: '/srv/data' },
    { requiredPermission: 'console.hosts.storage', snapshot });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /not configured to grow/);
});

test('staging an image the agent does not allowlist is refused', async () => {
  const snapshot = JSON.parse(JSON.stringify(STAGE4_SNAPSHOT));
  snapshot.operations.imageAllowlist = [];
  const { res } = await requestStage4('osimage.stage', { adapter: 'bootc', image: PINNED_IMAGE },
    { requiredPermission: 'console.hosts.osimage', snapshot });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /not configured to stage/);
});

test('a host reporting no allowlists at all can be asked for nothing', async () => {
  // The absent case must fail closed rather than read as "no restrictions".
  const snapshot = JSON.parse(JSON.stringify(STAGE4_SNAPSHOT));
  delete snapshot.operations;
  const { res } = await requestStage4('network.configure',
    { connection: 'lab-data', interface: 'eth1', method: 'auto', rollbackSeconds: 120 },
    { snapshot });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /not configured to reconfigure/);
});

test('an allowlisted mount root never reaches above itself', async () => {
  // Mirrors guard.UnderRoot in the agent: a sibling directory that merely
  // shares a prefix is not beneath the root, and the root itself is not a
  // target because mounting onto it would hide what is already there.
  //
  // The policy is widened to admit the sibling on purpose. Left at its default
  // the policy refuses /srv-evil/data first, and this test would keep passing
  // with the agent-allowlist prefix check removed entirely — it would be
  // watching the wrong gate.
  const snapshot = JSON.parse(JSON.stringify(STAGE4_SNAPSHOT));
  snapshot.operations.mountRoots = ['/srv'];
  const policy = stage4Policy({ allowed_mount_roots: ['/srv', '/srv-evil'] });
  for (const mountPoint of ['/srv', '/srv-evil/data']) {
    const { res } = await requestStage4('mount.configure',
      { filesystemUuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', mountPoint, fsType: 'ext4' },
      { requiredPermission: 'console.hosts.storage', snapshot, policy });
    assert.equal(res.statusCode, 409, `${mountPoint} must be refused`);
    assert.match(res.body.error, /not configured to mount anything at/,
      `${mountPoint} must be refused by the host's own allowlist, not incidentally`);
  }
});

// ── the reviewed pre-state must be the whole pre-state ──────────────────────

test('a profile with more static addresses than a plan can carry is refused', async () => {
  // The agent compares the recorded address set to the live one as a whole, so
  // a truncated pre-state would not merely be incomplete — it could never
  // match, and the operation would be approved and then refused on every run.
  const snapshot = JSON.parse(JSON.stringify(STAGE4_SNAPSHOT));
  snapshot.networkState.links[1].staticAddresses =
    ['10.1.0.1/24', '10.1.0.2/24', '10.1.0.3/24', '10.1.0.4/24', '10.1.0.5/24'];
  const { res } = await requestStage4('network.configure',
    { connection: 'lab-data', interface: 'eth1', method: 'auto', rollbackSeconds: 120 },
    { snapshot });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /at most 4/);
});

// ── the unit grammar the agent actually enforces ────────────────────────────

test('the backend accepts exactly the unit names the agent does', () => {
  // A name the backend accepts and the agent refuses becomes an operation that
  // is approved and can never run; a name the agent accepts and the backend
  // does not is a gap in what can be reviewed. Both directions are checked.
  const accepted = ['nginx.service', 'getty@tty1.service', 'a.service', 'my-app_1.service'];
  const refused = ['foo..service', '.service', '-bad.service', 'a\\b.service', 'a:b.service', 'nginx.socket'];
  for (const unit of accepted) {
    assert.deepEqual(normalizeParameters('service.restart', { unit }), { unit }, `${unit} must be accepted`);
  }
  for (const unit of refused) {
    assert.throws(() => normalizeParameters('service.restart', { unit }),
      (error) => error.code === 400 && /unit must be a plain/.test(error.msg), `${unit} must be refused`);
  }
  // journal.query shares the grammar but not the .service restriction.
  assert.doesNotThrow(() => normalizeParameters('journal.query', { units: ['nginx.socket'], priority: '' }));
  assert.throws(() => normalizeParameters('journal.query', { units: ['foo..service'], priority: '' }),
    (error) => error.code === 400 && /not a valid systemd unit name/.test(error.msg));
});

// ── a receipt must be a document the agent could have signed ────────────────

test('a receipt without ordered timestamps is refused', async () => {
  const base = {
    schemaVersion: RECEIPT_SCHEMA_VERSION, operationId: OP_ID, attempt: 1,
    controlCenterId: 'cc2', hostId: 'node-a', operation: 'service.restart',
    contentDigest: operationRow().content_digest, outcome: 'succeeded',
  };
  for (const [name, extra] of [
    ['no timestamps', {}],
    ['only a start', { startedAt: '2026-08-01T11:59:00.000Z' }],
    ['out of order', { startedAt: '2026-08-01T12:00:00.000Z', finishedAt: '2026-08-01T11:59:00.000Z' }],
    ['not a time', { startedAt: 'yesterday', finishedAt: 'today' }],
  ]) {
    const { api } = buildApi({
      operation: operationRow({ status: 'running', lease_attempt: 1, started_at: '2026-08-01T11:30:00Z' }),
    });
    const res = fakeRes();
    await api.handle(signedAgent('/api/control-centers/cc2/hosts/node-a/operations/receipt',
      JSON.stringify({ ...base, ...extra })), res);
    assert.equal(res.statusCode, 422, `${name} must be refused`);
  }
});

test('a malformed request body is a client error, not a platform failure', async () => {
  const { api } = buildApi({});
  const res = fakeRes();
  await api.handle({
    method: 'POST',
    url: '/api/control-centers/cc2/hosts/node-a/operations',
    rawBody: '{"operation": ',
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not valid JSON/);
});

test('preparation gets the host name the host itself reported', async () => {
  // maintenance-coordinator falls back to the reported hostname when the host
  // id is neither the node name nor its kubernetes.io/hostname label. That
  // fallback is only as good as the query that fetches it: without the
  // snapshot embedded the value is always the empty string, and every reboot
  // on such a host fails to prepare with a message blaming the node mapping.
  const seen = [];
  const maintenance = {
    prepare: async (hostId, hostname) => {
      seen.push([hostId, hostname]);
      return { prepared: true, node: 'node-a', blocking: [], warnings: [], cordon: {}, drain: {} };
    },
    uncordon: async () => {},
  };
  const row = operationRow({
    operation: 'host.reboot', status: 'approved', parameters: { deadlineSeconds: 300 },
    host: {
      host_id: 'node-a', display_name: 'node-a', agent_key_id: KEY_ID,
      host_snapshot: { payload: { identity: { hostname: 'node-a.cc2.local' } } },
    },
    host_operation_type: {
      risk_level: 'high', requires_second_person: true, requires_maintenance: true,
      required_permission: 'console.hosts.operate',
    },
  });
  const { api } = buildApi({ operation: row }, { maintenance });
  await api.prepare(row);
  assert.deepEqual(seen, [['node-a', 'node-a.cc2.local']]);
});

test('the operation query asks for the snapshot the preparation needs', async () => {
  // The test above supplies the row directly, so it would keep passing if the
  // query stopped fetching the snapshot. This asserts the query itself, which
  // is the thing that was actually wrong.
  const { api, writes } = buildApi({});
  const res = fakeRes();
  await api.handle({
    method: 'GET',
    url: `/api/control-centers/cc2/operations/${OP_ID}`,
    headers: {},
  }, res);
  const reads = writes.filter((w) => w.resource === 'host_operation' && w.method === 'GET');
  assert.ok(reads.length > 0, 'the operation must be read');
  assert.ok(reads.every((r) => /host\([^)]*host_snapshot/.test(r.query)),
    `the embedded host must carry its snapshot: ${reads.map((r) => r.query).join(' | ')}`);
});

test('SSH ban parameters are derived from the live sshd jail and reject ranges and protected addresses', () => {
  const snapshot = {
    sshBan: {
      provider: 'fail2ban', jail: 'sshd', supported: true, active: true,
      bannedAddresses: ['198.51.100.9'],
    },
    operations: {
      sshBanEnabled: true,
      sshProtectedAddresses: ['203.0.113.10'],
    },
  };
  assert.deepEqual(
    normalizeParameters('ssh.ban', { address: '203.0.113.24', jail: 'other', expectedBanned: true }, { snapshot }),
    { jail: 'sshd', address: '203.0.113.24', expectedBanned: false },
  );
  assert.deepEqual(
    normalizeParameters('ssh.unban', { address: '198.51.100.9' }, { snapshot }),
    { jail: 'sshd', address: '198.51.100.9', expectedBanned: true },
  );
  for (const address of [
    '203.0.113.0/24',
    '127.0.0.1',
    '::ffff:127.0.0.1',
    '203.0.113.10',
  ]) {
    assert.throws(
      () => normalizeParameters('ssh.ban', { address }, { snapshot }),
      (error) => error.code === 400 || error.code === 409,
      address,
    );
  }
  assert.throws(
    () => normalizeParameters('ssh.unban', { address: '198.51.100.8' }, { snapshot }),
    (error) => error.code === 409 && /no longer banned/.test(error.msg),
  );
});

test('SSH ban plans contain only the fixed jail, exact address and reviewed state', () => {
  const base = {
    id: OP_ID, lease_attempt: 2, control_center_id: 'cc2', host_id: 'node-a',
    content_digest: `sha256:${'a'.repeat(64)}`,
  };
  const ban = planFor({
    ...base, operation: 'ssh.ban',
    parameters: { jail: 'sshd', address: '203.0.113.24', expectedBanned: false },
  }, NOW);
  assert.deepEqual(ban.sshBan, {
    jail: 'sshd', address: '203.0.113.24', expectedBanned: false,
  });
  assert.equal(ban.expiresAt, new Date(NOW + 600_000).toISOString());
  assert.equal(ban.leaseExpiresAt, new Date(NOW + 120_000).toISOString());
});

test('SSH protection setup derives every policy field from the live host snapshot', () => {
  const snapshot = {
    sshBan: {
      provider: 'fail2ban', jail: 'sshd', installed: false, active: false, supported: false,
      candidateVersion: '1.0.2-3ubuntu0.1',
    },
    operations: {
      enabled: true,
      sshBanEnabled: true,
      sshProtectedAddresses: ['2001:db8::10', '203.0.113.10'],
    },
  };
  assert.deepEqual(
    normalizeParameters('ssh.protection.enable', {}, { snapshot }),
    {
      provider: 'fail2ban',
      jail: 'sshd',
      profile: 'rcc-ssh-baseline-v1',
      packageVersion: '1.0.2-3ubuntu0.1',
      expectedProfileDigest: '',
      expectedInstalled: false,
      expectedActive: false,
      protectedAddresses: ['2001:db8::10', '203.0.113.10'],
    },
  );
  assert.throws(
    () => normalizeParameters(
      'ssh.protection.enable',
      { jail: 'other', config: '[sshd]' },
      { snapshot },
    ),
    (error) => error.code === 400 && /no operator-supplied/.test(error.msg),
  );
  assert.throws(
    () => normalizeParameters('ssh.protection.enable', {}, {
      snapshot: {
        ...snapshot,
        operations: { ...snapshot.operations, sshProtectedAddresses: [] },
      },
    }),
    (error) => error.code === 409 && /protected management/.test(error.msg),
  );

  const digest = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(
    normalizeParameters('ssh.protection.enable', {}, {
      snapshot: {
        sshBan: {
          provider: 'fail2ban',
          jail: 'sshd',
          installed: true,
          packageVersion: '1.0.2-3ubuntu0.1',
          active: true,
          supported: true,
          protectionProfile: 'rcc-ssh-baseline-v1-drift',
          profileDigest: digest,
        },
        operations: snapshot.operations,
      },
    }),
    {
      provider: 'fail2ban',
      jail: 'sshd',
      profile: 'rcc-ssh-baseline-v1',
      packageVersion: '1.0.2-3ubuntu0.1',
      expectedProfileDigest: digest,
      expectedInstalled: true,
      expectedActive: true,
      protectedAddresses: ['2001:db8::10', '203.0.113.10'],
    },
    'an active RCC-owned profile may be reconciled when protected addresses drift',
  );
  assert.throws(
    () => normalizeParameters('ssh.protection.enable', {}, {
      snapshot: {
        sshBan: {
          provider: 'fail2ban', jail: 'sshd', installed: true,
          packageVersion: '1.0.2-3ubuntu0.1', active: true, supported: true,
          protectionProfile: 'external', profileDigest: digest,
        },
        operations: snapshot.operations,
      },
    }),
    (error) => error.code === 409 && /external policy/.test(error.msg),
  );
});

test('SSH protection plans carry only the pinned fixed profile and reviewed pre-state', () => {
  const parameters = {
    provider: 'fail2ban',
    jail: 'sshd',
    profile: 'rcc-ssh-baseline-v1',
    packageVersion: '1.0.2-3ubuntu0.1',
    expectedProfileDigest: '',
    expectedInstalled: false,
    expectedActive: false,
    protectedAddresses: ['203.0.113.10'],
  };
  const setup = planFor({
    id: OP_ID,
    lease_attempt: 2,
    control_center_id: 'cc2',
    host_id: 'node-a',
    operation: 'ssh.protection.enable',
    content_digest: contentDigest('ssh.protection.enable', parameters),
    parameters,
  }, NOW);
  assert.deepEqual(setup.sshProtection, parameters);
  assert.equal(setup.expiresAt, new Date(NOW + 1_800_000).toISOString());
  assert.equal(setup.leaseExpiresAt, new Date(NOW + 1_800_000).toISOString());
});
