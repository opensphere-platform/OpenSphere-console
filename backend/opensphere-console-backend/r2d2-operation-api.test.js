'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createR2d2OperationApi } = require('./r2d2-operation-api');
const { DESCRIPTORS, exactConfirmation } = require('./r2d2-durable-operation');

function request(action = 'restart-workload') {
  const descriptor = DESCRIPTORS[action];
  const target = { kind: descriptor.targetKind, namespace: 'opensphere-console', name: 'console', uid: 'uid', generation: 1, resourceVersion: '2', digest: `sha256:${'a'.repeat(64)}`, image: `ghcr.io/opensphere-platform/console@sha256:${'a'.repeat(64)}`, container: 'console', replicas: 2 };
  return { action, target, reason: 'operator requested restart', confirmation: exactConfirmation(descriptor, target), idempotencyKey: 'request-123' };
}
function fixture(actor = {}) {
  const rows = []; const approvals = []; const plans = [];
  const store = {
    insertPlan: async (row) => { plans.push({ ...row }); return plans.at(-1); },
    getPlan: async (id) => plans.find((row) => row.plan_id === id) || null,
    consumePlan: async (id, operationId) => { const plan = plans.find((row) => row.plan_id === id); if (!plan || plan.consumed_operation_id) return false; plan.consumed_operation_id = operationId; return true; },
    insert: async (row) => { rows.push({ ...row, created_at: 'now', updated_at: 'now' }); return rows.at(-1); },
    get: async (id) => rows.find((r) => r.operation_id === id), list: async () => rows, steps: async () => [],
    approve: async (id, item) => approvals.push({ operation_id: id, approver_id: item.approverId, assurance: item.assurance, approval_digest: item.approvalDigest }),
    approvals: async (id) => approvals.filter((a) => a.operation_id === id), queue: async (id) => { rows.find((r) => r.operation_id === id).phase = 'Queued'; },
  };
  const api = createR2d2OperationApi({ enabled: true, authenticate: async () => ({ actor: { sub: '11111111-1111-4111-8111-111111111111', assurance: 'aal2', browserSessionId: '22222222-2222-4222-8222-222222222222', credentialRevision: 3, lastReauthenticatedAt: '2026-08-09T23:59:00.000Z', ...actor } }), store,
    resolveTarget: async (action, target) => action === 'create-postgres-cluster'
      ? { kind: 'FoundationClaim', namespace: target.namespace, name: target.name, uid: 'pending:owner-revision',
        generation: 0, resourceVersion: 'catalog-rv:runtime-rv', request: { ...target } }
      : ({ ...request().target, ...target, kind: 'Deployment', uid: 'live-uid', generation: 9, resourceVersion: 'live-rv' }),
    now: () => new Date('2026-08-10T00:00:00Z') });
  return { api, rows, approvals, plans, store };
}
test('operation acceptance persists only digests/session identity and queues R1', async () => {
  const { api, rows } = fixture();
  const body = { ...request(), expectedPostcondition: { forged: true } };
  const out = await api.accept({ headers: { 'x-os-idempotency-key': 'request-123' } }, body);
  assert.equal(out.phase, 'Queued'); assert.equal(rows[0].auth_session_id, '22222222-2222-4222-8222-222222222222');
  assert.equal(rows[0].target_uid, 'live-uid');
  assert.deepEqual(rows[0].expected_postcondition, {
    verifierId: 'authority.workload.rollout', targetUid: 'live-uid', generationGreaterThan: 9,
  });
  assert.equal(JSON.stringify(rows).includes('forged'), false);
  assert.equal(JSON.stringify(rows).includes('Bearer'), false); assert.equal(JSON.stringify(rows).includes('accessToken'), false);
});

test('R1 acceptance requires the requesting administrator to have recent AAL2', async () => {
  const f = fixture({ lastReauthenticatedAt: '2026-08-09T23:50:00.000Z' });
  await assert.rejects(
    () => f.api.accept({ headers: { 'x-os-idempotency-key': 'request-stale-aal2' } }, request()),
    (error) => error?.code === 428 && error?.errorCode === 'recent_aal2_required',
  );
  assert.equal(f.rows.length, 0);
});
test('R2 remains awaiting approval until an AAL2 approval', async () => {
  const actor = {}; const f = fixture(actor); const body = request('rollback-image'); body.target.namespace = 'opensphere-console'; body.confirmation = exactConfirmation(DESCRIPTORS['rollback-image'], body.target);
  const op = await f.api.accept({ headers: { 'x-os-idempotency-key': 'rollback-123' } }, body);
  assert.equal(op.phase, 'AwaitingApproval'); const row = f.rows[0];
  actor.sub = '33333333-3333-4333-8333-333333333333';
  await f.api.approve({}, row.operation_id, { confirmation: `approve R2D2 operation ${row.operation_id} ${row.descriptor_digest}` });
  assert.equal(row.phase, 'Queued');
});

test('R2 submitter cannot self-approve', async () => {
  const f = fixture(); const body = request('rollback-image');
  body.confirmation = exactConfirmation(DESCRIPTORS['rollback-image'], body.target);
  await f.api.accept({ headers: { 'x-os-idempotency-key': 'rollback-self-123' } }, body);
  const row = f.rows[0];
  await assert.rejects(
    () => f.api.approve({}, row.operation_id, { confirmation: `approve R2D2 operation ${row.operation_id} ${row.descriptor_digest}` }),
    (error) => error?.code === 409 && /independent approver/.test(error?.msg),
  );
});

test('planning replaces caller identity fields with live resolver evidence', async () => {
  const f = fixture();
  const plan = await f.api.plan({}, { action: 'restart-workload', target: { namespace: 'opensphere-console', name: 'console', uid: 'forged' } });
  assert.equal(plan.target.uid, 'live-uid');
  assert.equal(plan.target.generation, 9);
  assert.equal(plan.expectedConfirmation, 'restart deployment opensphere-console/console');
});

test('PostgreSQL plan is durable, expiring, revision-bound, and consumed into module_operation', async () => {
  const f = fixture();
  const target = {
    name: 'r2d2-e2e-pg', namespace: 'opensphere-foundation', alias: 'R2D2 E2E PostgreSQL',
    database: 'r2d2_e2e', owner: 'r2d2_e2e', plan: 'postgresql-dev-single',
    postgresVersion: '18.4', deletionPolicy: 'Retain',
  };
  const planned = await f.api.plan({}, { action: 'create-postgres-cluster', target, reason: 'PFSS PostgreSQL configuration' });
  assert.match(planned.planId, /^pgplan-/);
  assert.match(planned.planDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(planned.targetRevision, 'catalog-rv:runtime-rv');
  assert.equal(planned.expectedConfirmation,
    'create PostgreSQL cluster opensphere-foundation/r2d2-e2e-pg plan postgresql-dev-single version 18.4');
  assert.equal(f.plans.length, 1);
  const accepted = await f.api.accept({ headers: {} }, { planId: planned.planId, confirmation: planned.expectedConfirmation });
  assert.equal(accepted.phase, 'AwaitingApproval');
  assert.equal(f.rows[0].action, 'create-postgres-cluster');
  assert.equal(f.rows[0].precondition.target.request.database, 'r2d2_e2e');
  assert.equal(f.plans[0].consumed_operation_id, accepted.operationId);
});

test('PostgreSQL durable plan cannot cross authenticated sessions', async () => {
  const actor = {};
  const f = fixture(actor);
  const target = {
    name: 'r2d2-e2e-pg', namespace: 'opensphere-foundation', alias: 'R2D2 E2E PostgreSQL',
    database: 'r2d2_e2e', owner: 'r2d2_e2e', plan: 'postgresql-dev-single',
    postgresVersion: '18.4', deletionPolicy: 'Retain',
  };
  const planned = await f.api.plan({}, { action: 'create-postgres-cluster', target, reason: 'PFSS PostgreSQL configuration' });
  actor.browserSessionId = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(
    () => f.api.accept({ headers: {} }, { planId: planned.planId, confirmation: planned.expectedConfirmation }),
    (error) => error?.code === 403 && /different authenticated session/.test(error?.msg),
  );
  assert.equal(f.rows.length, 0);
});

test('durable acceptance is fail-closed when activation is off', async () => {
  const disabled = createR2d2OperationApi({ enabled: false, authenticate: async () => ({ actor: {} }), store: {} });
  await assert.rejects(() => disabled.accept({ headers: {} }, request()), (error) => error?.code === 503 && /not activated/.test(error?.msg));
});

test('generic operation approval cannot activate an Engineering Remediation proposal', async () => {
  const f = fixture();
  f.rows.push({ operation_id: '66666666-6666-4666-8666-666666666666', action: 'engineering-remediation', descriptor_digest: `sha256:${'f'.repeat(64)}`, requested_risk_class: 'R2' });
  await assert.rejects(() => f.api.approve({}, f.rows[0].operation_id, { confirmation: 'anything' }),
    (error) => error?.code === 409 && /not activated/.test(error?.msg));
});
