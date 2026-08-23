'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DESCRIPTORS, exactConfirmation, bindOperation, authorizeAtExecution,
  checkLivePreconditions, DurableOperationWorker,
} = require('./r2d2-durable-operation');
const {
  LOCAL_EDGE_R1_MODE,
  localhostHttps,
  localEdgeR1ApprovalPolicy,
} = require('./local-edge-r1-approval');

const localEdgeDescriptor = Object.freeze({
  riskClass: 'R1', assurance: 'aal2', ownerRoute: 'cluster-manager/workloads',
  governedToolId: 'osaa.k8s.workload.restart',
});

function localEdgeCandidate(overrides = {}) {
  return {
    publicUrl: 'https://localhost:1114',
    installedSummary: { channel: 'edge', buildAuthority: 'localhost', releaseClass: 'pre-ga' },
    descriptor: localEdgeDescriptor,
    ownerRoute: 'cluster-manager/workloads',
    consumerId: 'osaa-gateway',
    action: 'apply',
    desiredState: {
      toolId: 'osaa.k8s.workload.restart',
      durableOperationId: '123e4567-e89b-42d3-a456-426614174000',
      inputs: { confirm: 'restart deployment opensphere-console/backend' },
    },
    ...overrides,
  };
}

test('R1 single-admin automation is restricted to localhost HTTPS edge operations', () => {
  const policy = localEdgeR1ApprovalPolicy(localEdgeCandidate());
  assert.equal(policy.mode, LOCAL_EDGE_R1_MODE);
  assert.equal(policy.requiredHumanApprovals, 1);
  assert.equal(policy.approvingHuman, 'requesting-admin');
  assert.equal(policy.autoMerge, true);
  assert.equal(localhostHttps('https://127.0.0.1:1114'), true);
  assert.equal(localhostHttps('http://localhost:1114'), false);
});

test('R1 single-admin automation fails closed outside its exact authority boundary', () => {
  const denied = [
    { publicUrl: 'https://console.example.com' },
    { installedSummary: { channel: 'ga', buildAuthority: 'github-actions', releaseClass: 'ga' } },
    { descriptor: { ...localEdgeDescriptor, riskClass: 'R2' } },
    { descriptor: { ...localEdgeDescriptor, assurance: 'aal1' } },
    { ownerRoute: 'foundation/platform-release' },
    { consumerId: 'platform-release' },
    { action: 'rollback' },
    { desiredState: { ...localEdgeCandidate().desiredState, toolId: 'osaa.k8s.workload.rollback-image' } },
    { desiredState: { ...localEdgeCandidate().desiredState, durableOperationId: 'not-an-operation' } },
    { desiredState: { ...localEdgeCandidate().desiredState, inputs: { confirm: '' } } },
  ];
  for (const override of denied) assert.equal(localEdgeR1ApprovalPolicy(localEdgeCandidate(override)), null);
});

function request(action = 'restart-workload') {
  const descriptor = DESCRIPTORS[action];
  const target = {
    kind: descriptor.targetKind, namespace: ['retry-delivery', 'owner-recover'].includes(action) ? '' : 'opensphere-system',
    name: action === 'retry-delivery' ? 'delivery-1' : 'console', uid: 'uid-1', generation: 7,
    resourceVersion: '100', desiredRevision: 'rev-1', digest: `sha256:${'a'.repeat(64)}`,
    image: `ghcr.io/opensphere-platform/console@sha256:${'a'.repeat(64)}`, container: 'console', replicas: 2,
  };
  if (action === 'create-postgres-cluster') {
    Object.assign(target, {
      namespace: 'opensphere-foundation', name: 'r2d2-e2e-pg',
      request: { name: 'r2d2-e2e-pg', namespace: 'opensphere-foundation', alias: 'R2D2 E2E PostgreSQL',
        database: 'r2d2_e2e', owner: 'r2d2_e2e', plan: 'postgresql-dev-single', postgresVersion: '18.4', deletionPolicy: 'Retain' },
    });
  }
  if (action === 'run-recovery-drill') {
    Object.assign(target, {
      namespace: 'opensphere-console-recovery', name: 'opensphere-supabase-recovery-drill',
      request: { component: 'supabase' },
    });
  }
  const bindingDigest = action === 'create-postgres-cluster' ? `sha256:${'b'.repeat(64)}` : '';
  return {
    action, target, bindingDigest,
    confirmation: exactConfirmation(descriptor, target, { bindingDigest }),
    reason: 'operator requested recovery',
  };
}

test('closed binder selects only release descriptor values', () => {
  const out = bindOperation({ ...request(), evidence: { toolId: 'evil.shell', target: { uid: 'evil' } } });
  assert.equal(out.toolId, 'owner.workload.restart');
  assert.equal(out.target.uid, 'uid-1');
  assert.equal(out.riskClass, 'R1');
  assert.equal(out.requiredAssurance, 'aal2');
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
  const operation = { actorId: 'actor', action: 'rollback-image', authzRevision: 'r1', requiredAssurance: 'aal2', riskClass: 'R3', requiredPermission: 'osaa.action.execute.high' };
  const now = Date.parse('2026-08-23T00:00:00.000Z');
  const session = { active: true, actorId: 'actor', authzRevision: 'r1', assurance: 'aal2', permissions: ['osaa.action.execute.high'], accessToken: 'memory-only', lastReauthenticatedAt: '2026-08-22T23:59:00.000Z' };
  assert.equal(authorizeAtExecution(operation, session, [{ approverId: 'a', assurance: 'aal2' }], now).code, 'TwoPersonApprovalRequired');
  assert.equal(authorizeAtExecution(operation, session, [{ approverId: 'a', assurance: 'aal2' }, { approverId: 'a', assurance: 'aal2' }], now).allowed, false);
  assert.equal(authorizeAtExecution(operation, session, [{ approverId: 'a', assurance: 'aal2' }, { approverId: 'b', assurance: 'aal2' }], now).allowed, true);
  assert.equal(authorizeAtExecution(operation, { ...session, authzRevision: 'r2' }, [], now).code, 'AuthorizationRevisionChanged');
  assert.equal(authorizeAtExecution(operation, { ...session, lastReauthenticatedAt: '2026-08-22T23:50:00.000Z' }, [], now).code, 'RecentAssuranceRequired');
});

test('platform recovery drill is a closed R2 operation over a fixed CronJob target', () => {
  const input = request('run-recovery-drill');
  input.confirmation = exactConfirmation(DESCRIPTORS['run-recovery-drill'], input.target);
  const bound = bindOperation(input);
  assert.equal(bound.expectedConfirmation, 'run recovery drill supabase');
  assert.equal(bound.ownerRoute, 'recovery/isolated-drill');
  assert.equal(bound.requiredPermission, 'console.backup.restore');
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
    sessions: { resolve: async () => ({ active: true, actorId: 'actor', authzRevision: 'r1', assurance: 'aal2', permissions: ['osaa.action.execute.high'], accessToken: 'secret', lastReauthenticatedAt: new Date().toISOString() }) },
    authority: { read: async () => ({ ...request().target, fresh: true, snapshotComplete: true }) },
    owners: { invoke: async () => { calls += 1; return { operationId: 'owner-1' }; }, reconcile: async () => null },
    verifiers: { verify: async () => ({ status: 'succeeded', observed: { ready: true } }) },
    ...overrides,
  };
  return { worker: new DurableOperationWorker(deps), phases, steps, calls: () => calls };
}

function operation(action = 'restart-workload') {
  const bound = bindOperation(request(action));
  return { ...bound, operationId: 'op-1', idempotencyKey: `r2d2-plan-${action}`, phase: 'accepted', actorId: 'actor', authSessionId: 'session-1', authzRevision: 'r1' };
}

test('all initial management scenarios bind to a closed owner and authoritative postcondition', async () => {
  const scenarios = Object.keys(DESCRIPTORS);
  assert.deepEqual(scenarios, [
    'restart-workload', 'scale-workload', 'rollback-image',
    'run-cronjob', 'run-recovery-drill', 'owner-recover', 'retry-delivery', 'create-postgres-cluster',
  ]);
  for (const [index, action] of scenarios.entries()) {
    const op = { ...operation(action), operationId: `scenario-${index}` };
    let invoked;
    const fixture = workerFixture({
      store: {
        appendStep: async (_id, item) => fixture.steps.push(item),
        setPhase: async (_id, phase) => fixture.phases.push(phase),
        getApprovals: async () => op.riskClass === 'R1'
          ? [] : [{ approverId: 'operator-2', assurance: 'aal2' }],
        heartbeat: async () => true,
        recordDownstreamIntent: async () => {},
      },
      sessions: { resolve: async () => ({
        active: true, actorId: 'actor', authzRevision: 'r1', assurance: 'aal2',
        permissions: ['osaa.action.execute.high', 'console.notification.manage', 'console.backup.restore'], accessToken: 'memory-only',
        lastReauthenticatedAt: new Date().toISOString(),
      }) },
      authority: { read: async () => ({ ...op.target, fresh: true, snapshotComplete: true }) },
      owners: {
        invoke: async (route, payload) => { invoked = { route, payload }; return { operationId: `owner-${index}` }; },
        reconcile: async () => null,
      },
      verifiers: { verify: async (verifierId, target) => ({ status: 'succeeded', observed: { verifierId, uid: target.uid } }) },
    });
    const result = await fixture.worker.process(op);
    assert.equal(result.phase, 'succeeded', `${action} did not converge to succeeded`);
    assert.equal(invoked.route, DESCRIPTORS[action].ownerRoute);
    assert.equal(invoked.payload.toolId, DESCRIPTORS[action].toolId);
    assert.equal(invoked.payload.target.uid, op.target.uid);
    assert.equal(invoked.payload.idempotencyKey, op.idempotencyKey);
    assert.equal(JSON.stringify({ invoked, steps: fixture.steps }).includes('memory-only'), false);
  }
});

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

test('independent AAL2 approver can execute an R2 plan initiated by an active CLI aal1 session', async () => {
	const op = operation('create-postgres-cluster');
	let ownerToken = '';
	const fixture = workerFixture({
		store: {
			appendStep: async (_id, item) => fixture.steps.push(item), setPhase: async (_id, phase) => fixture.phases.push(phase),
			getApprovals: async () => [{ approverId: 'approver', assurance: 'aal2', authSessionId: 'browser-approval', authzRevision: 'r2' }],
			heartbeat: async () => true, recordDownstreamIntent: async () => {},
		},
		sessions: { resolve: async (sessionId) => sessionId === 'browser-approval'
			? { active: true, actorId: 'approver', assurance: 'aal2', authzRevision: 'r2', permissions: ['osaa.action.execute.high'], accessToken: 'approver-token', lastReauthenticatedAt: new Date().toISOString() }
			: { active: true, actorId: 'actor', assurance: 'aal1', authzRevision: 'r1', permissions: ['osaa.action.execute.high'], accessToken: 'cli-token' } },
		authority: { read: async () => ({ ...op.target, fresh: true, snapshotComplete: true }) },
		owners: { invoke: async (_route, _payload, token) => { ownerToken = token; return { operationId: 'owner-pg' }; }, reconcile: async () => null },
		verifiers: { verify: async () => ({ status: 'succeeded', observed: { ready: true } }) },
	});
	const result = await fixture.worker.process(op);
	assert.equal(result.phase, 'succeeded');
	assert.equal(ownerToken, 'approver-token');
	assert.ok(fixture.steps.some((item) => item.type === 'authorization-delegation'));
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
