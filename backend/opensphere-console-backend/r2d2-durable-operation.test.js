'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DESCRIPTORS, exactConfirmation, bindOperation, authorizeAtExecution,
  checkLivePreconditions, DurableOperationWorker,
} = require('./r2d2-durable-operation');

function request(action = 'restart-workload') {
  const descriptor = DESCRIPTORS[action];
  const target = {
    kind: descriptor.targetKind, namespace: ['retry-delivery', 'owner-recover'].includes(action) ? '' : 'opensphere-system',
    name: action === 'retry-delivery' ? 'delivery-1' : 'console', uid: 'uid-1', generation: 7,
    resourceVersion: '100', desiredRevision: 'rev-1', digest: `sha256:${'a'.repeat(64)}`,
    image: `ghcr.io/opensphere-platform/console@sha256:${'a'.repeat(64)}`, container: 'console', replicas: 2,
  };
  return { action, target, confirmation: exactConfirmation(descriptor, target), reason: 'operator requested recovery' };
}

test('closed binder selects only release descriptor values', () => {
  const out = bindOperation({ ...request(), evidence: { toolId: 'evil.shell', target: { uid: 'evil' } } });
  assert.equal(out.toolId, 'owner.workload.restart');
  assert.equal(out.target.uid, 'uid-1');
  assert.equal(out.riskClass, 'R1');
});

test('binder rejects missing human exact confirmation and arbitrary action', () => {
  assert.throws(() => bindOperation({ ...request(), confirmation: '' }), /human-supplied exact confirmation/);
  assert.throws(() => bindOperation({ ...request(), action: 'run-shell' }), /unsupported management action/);
});

test('local-edge rollback is exact-digest only and R2', () => {
  const valid = bindOperation(request('rollback-image'));
  assert.equal(valid.riskClass, 'R2');
  const invalid = request('rollback-image');
  invalid.target.digest = 'edge';
  invalid.confirmation = exactConfirmation(DESCRIPTORS['rollback-image'], invalid.target);
  assert.throws(() => bindOperation(invalid), /exact image digest/);
});

test('HIS owner recovery is a closed R2 capability with an exact human confirmation', () => {
  const input = request('owner-recover'); input.target.name = 'kube-prometheus-stack'; input.target.uid = 'his:kube-prometheus-stack';
  input.confirmation = exactConfirmation(DESCRIPTORS['owner-recover'], input.target);
  const bound = bindOperation(input);
  assert.equal(bound.ownerRoute, 'cluster-manager/his');
  assert.equal(bound.riskClass, 'R2');
});

test('execution authorization is revalidated and R3 requires two distinct AAL2 people', () => {
  const operation = { actorId: 'actor', action: 'rollback-image', authzRevision: 'r1', requiredAssurance: 'aal2', riskClass: 'R3', requiredPermission: 'oaa.action.execute.high' };
  const session = { active: true, actorId: 'actor', authzRevision: 'r1', assurance: 'aal2', permissions: ['oaa.action.execute.high'], accessToken: 'memory-only' };
  assert.equal(authorizeAtExecution(operation, session, [{ approverId: 'a', assurance: 'aal2' }]).code, 'TwoPersonApprovalRequired');
  assert.equal(authorizeAtExecution(operation, session, [{ approverId: 'a', assurance: 'aal2' }, { approverId: 'a', assurance: 'aal2' }]).allowed, false);
  assert.equal(authorizeAtExecution(operation, session, [{ approverId: 'a', assurance: 'aal2' }, { approverId: 'b', assurance: 'aal2' }]).allowed, true);
  assert.equal(authorizeAtExecution(operation, { ...session, authzRevision: 'r2' }, []).code, 'AuthorizationRevisionChanged');
});

test('live UID/generation/resource/desired revisions are authoritative preconditions', () => {
  const operation = { target: request().target };
  const live = { ...request().target, fresh: true, snapshotComplete: true };
  assert.equal(checkLivePreconditions(operation, live).ok, true);
  assert.equal(checkLivePreconditions(operation, { ...live, uid: 'recreated' }).code, 'TargetUidChanged');
  assert.equal(checkLivePreconditions(operation, { ...live, desiredRevision: 'new' }).code, 'DesiredRevisionChanged');
  assert.equal(checkLivePreconditions(operation, { ...live, snapshotComplete: false }).code, 'AuthorityUnavailable');
});

function workerFixture(overrides = {}) {
  const phases = []; const steps = []; let calls = 0;
  const deps = {
    store: {
      appendStep: async (_id, item) => steps.push(item), setPhase: async (_id, phase) => phases.push(phase),
      getApprovals: async () => [], heartbeat: async () => true,
    },
    sessions: { resolve: async () => ({ active: true, actorId: 'actor', authzRevision: 'r1', assurance: 'aal2', permissions: ['oaa.action.execute.high'], accessToken: 'secret' }) },
    authority: { read: async () => ({ ...request().target, fresh: true, snapshotComplete: true }) },
    owners: { invoke: async () => { calls += 1; return { operationId: 'owner-1' }; }, reconcile: async () => null },
    verifiers: { verify: async () => ({ status: 'succeeded', observed: { ready: true } }) },
    ...overrides,
  };
  return { worker: new DurableOperationWorker(deps), phases, steps, calls: () => calls };
}

function operation() {
  const bound = bindOperation(request());
  return { ...bound, operationId: 'op-1', phase: 'accepted', actorId: 'actor', authSessionId: 'session-1', authzRevision: 'r1' };
}

test('worker performs durable preflight, owner call and authoritative verification', async () => {
  const fixture = workerFixture();
  const result = await fixture.worker.process(operation());
  assert.equal(result.phase, 'succeeded');
  assert.equal(fixture.calls(), 1);
  assert.deepEqual(fixture.phases, ['claimed', 'preflighting', 'executing', 'verifying', 'succeeded']);
  assert.equal(JSON.stringify(fixture.steps).includes('secret'), false);
});

test('revoked session blocks without owner invocation', async () => {
  let called = 0;
  const fixture = workerFixture({
    sessions: { resolve: async () => ({ active: false, actorId: 'actor' }) },
    owners: { invoke: async () => { called += 1; }, reconcile: async () => null },
  });
  const result = await fixture.worker.process(operation());
  assert.equal(result.phase, 'authorization_expired');
  assert.equal(called, 0);
});

test('ambiguous owner outcome reconciles by idempotency key without a second mutation', async () => {
  let invokes = 0; let reconciles = 0;
  const fixture = workerFixture({
    owners: {
      invoke: async () => { invokes += 1; throw Object.assign(new Error('connection lost'), { ambiguous: true }); },
      reconcile: async () => { reconciles += 1; return { operationId: 'owner-existing' }; },
    },
  });
  const result = await fixture.worker.process(operation());
  assert.equal(result.phase, 'succeeded');
  assert.equal(invokes, 1);
  assert.equal(reconciles, 1);
});

test('owner 200 with unmet postcondition is verification_failed', async () => {
  const fixture = workerFixture({ verifiers: { verify: async () => ({ status: 'failed', observed: { ready: false } }) } });
  const result = await fixture.worker.process(operation());
  assert.equal(result.phase, 'verification_failed');
});

test('claim lease loss fences the worker before owner mutation', async () => {
  let heartbeats = 0; let invoked = 0;
  const fixture = workerFixture({
    store: {
      appendStep: async () => {}, setPhase: async () => {}, getApprovals: async () => [],
      heartbeat: async () => { heartbeats += 1; return heartbeats < 4; },
      recordDownstreamIntent: async () => {},
    },
    owners: { invoke: async () => { invoked += 1; }, reconcile: async () => null },
  });
  await assert.rejects(() => fixture.worker.process(operation()), /claim lease was lost/);
  assert.equal(invoked, 0);
});

test('expired executing claim resumes from ambiguous reconciliation without replay', async () => {
  let invoked = 0; let reconciled = 0;
  const fixture = workerFixture({
    owners: {
      invoke: async () => { invoked += 1; throw new Error('must not replay'); },
      reconcile: async () => { reconciled += 1; return { operationId: 'owner-existing' }; },
    },
  });
  const resumed = { ...operation(), phase: 'ambiguous' };
  const result = await fixture.worker.process(resumed);
  assert.equal(result.phase, 'succeeded');
  assert.equal(invoked, 0);
  assert.equal(reconciled, 1);
});

test('deadline expires before downstream intent and prevents owner mutation', async () => {
  let invoked = 0;
  const fixture = workerFixture({
    now: () => new Date('2026-08-10T00:10:00Z'),
    owners: { invoke: async () => { invoked += 1; }, reconcile: async () => null },
  });
  const expired = { ...operation(), deadlineAt: '2026-08-10T00:09:59Z' };
  const result = await fixture.worker.process(expired);
  assert.equal(result.phase, 'timed_out');
  assert.equal(result.code, 'OperationDeadlineExceeded');
  assert.equal(invoked, 0);
});

test('deadline does not suppress reconciliation after owner outcome became uncertain', async () => {
  let invoked = 0; let reconciled = 0;
  const fixture = workerFixture({
    now: () => new Date('2026-08-10T00:10:00Z'),
    owners: {
      invoke: async () => { invoked += 1; },
      reconcile: async () => { reconciled += 1; return { operationId: 'owner-existing' }; },
    },
  });
  const resumed = { ...operation(), phase: 'ambiguous', deadlineAt: '2026-08-10T00:09:59Z' };
  const result = await fixture.worker.process(resumed);
  assert.equal(result.phase, 'succeeded');
  assert.equal(invoked, 0);
  assert.equal(reconciled, 1);
});
