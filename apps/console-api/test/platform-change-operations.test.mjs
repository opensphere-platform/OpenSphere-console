import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { createOperationService } from '../src/operation-service.mjs';
import { createPlatformChangeOperations } from '../src/platform-change-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';

const actorRef = '11111111-1111-4111-8111-111111111111';
const operationId = '33333333-3333-4333-8333-333333333333';
const current = new Date('2026-09-02T00:00:00.000Z');
const policyCatalog = JSON.parse(await readFile(
  new URL('../../../packages/contracts/action-policies.json', import.meta.url), 'utf8',
));
const session = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  subjectId: actorRef,
  expiresAt: '2026-09-02T01:00:00.000Z',
  revokedAt: null,
  authorityFresh: true,
  permissions: ['console.git.change'],
  permissionRevision: '9',
  revokeEpoch: '2',
  aal: 'aal2',
};
const approverSession = {
  ...session,
  sessionId: '44444444-4444-4444-8444-444444444444',
  subjectId: '55555555-5555-4555-8555-555555555555',
  permissions: ['console.operation.approve'],
};

function record(input) {
  return {
    operation_id: operationId,
    action_id: input.actionId,
    action_version: input.actionVersion,
    actor_ref: input.actorRef,
    target_ref: input.targetRef,
    required_permission: input.requiredPermission,
    payload_digest: input.payloadDigest,
    request_digest: 'sha256:' + 'd'.repeat(64),
    reason: input.reason,
    risk: input.risk,
    aal: 'aal2',
    permission_revision: input.expectedPermissionRevision,
    approval_required: input.approvalRequired,
    approval_revision: null,
    plan_revision: input.planRevision,
    idempotency_key: input.idempotencyKey,
    correlation_id: input.correlationId,
    source_revision: null,
    owner_ref: input.ownerRef,
    execution_plan: input.executionPlan,
    state: 'Planned',
    state_version: 0,
    expected_postcondition: null,
    observed_postcondition: null,
    error: null,
    created_at: current.toISOString(),
    updated_at: current.toISOString(),
  };
}

function fixture({ rejectIntent = false, rejectGitea = false, rejectMergeBinding = false, giteaReady = true } = {}) {
  const order = [];
  const accepted = [];
  const proposed = [];
  const approvals = [];
  const mergeBindings = [];
  let operationRecord = null;
  const store = {
    async accept(input) {
      order.push('intent');
      if (rejectIntent) throw Object.assign(new Error('intent rejected'), { code: 'PolicyRejected', status: 422 });
      accepted.push(input);
      operationRecord = record(input);
      return { operationRecord, replayed: false };
    },
    async approve(input) {
      order.push('approval');
      approvals.push(input);
      operationRecord = { ...operationRecord, state: 'Authorized', state_version: 1, approval_revision: input.approvalRevision };
      return { operationRecord, replayed: false };
    },
    async verify() { throw new Error('not used'); },
    async get() { return null; },
    async getGiteaOperationForApproval() {
      order.push('approval-read');
      return operationRecord;
    },
    async recordGiteaMerge(input) {
      order.push('merge-binding');
      mergeBindings.push(input);
      if (rejectMergeBinding) throw Object.assign(new Error('database unavailable'), { code: 'AuthorityUnavailable', status: 503 });
      const replayed = operationRecord.state === 'Submitted';
      operationRecord = { ...operationRecord, state: 'Submitted', state_version: 2, source_revision: input.sourceRevision };
      return { operationRecord, replayed };
    },
  };
  const operationService = createOperationService({ store, policyCatalog, clock: () => current });
  const giteaClient = {
    repository: 'opensphere-platform/platform-declarations',
    defaultBranch: 'main',
    async supplyChainStatus() {
      order.push('preflight');
      return { ready: giteaReady, reason: giteaReady ? '' : 'branch protection is incomplete' };
    },
    async ensureProposal(input) {
      order.push('gitea');
      proposed.push(input);
      if (rejectGitea) throw Object.assign(new Error('Gitea unavailable'), {
        code: 'AuthorityUnavailable', status: 503, sideEffect: 'unknown',
      });
      return {
        branch: `control/${operationId}`,
        pullRequest: { number: 17, url: 'https://gitea.example/pulls/17' },
        desiredRevision: 'a'.repeat(40),
        replayed: false,
      };
    },
    async approveAndMerge(input) {
      order.push('gitea-merge');
      if (rejectGitea) throw Object.assign(new Error('Gitea merge unavailable'), {
        code: 'AuthorityUnavailable', status: 503, sideEffect: 'unknown',
      });
      return { merged: true, mergeRevision: 'b'.repeat(40), pullNumber: 17, branch: `control/${operationId}` };
    },
  };
  const operations = createPlatformChangeOperations({
    operationService, policyRevision: policyCatalog.policyRevision, projectionStore: store, giteaClient, clock: () => current,
  });
  return { operations, order, accepted, proposed, approvals, mergeBindings };
}

function request() {
  return {
    consumerId: 'opensphere-console',
    action: 'configure',
    target: 'console/settings',
    reason: 'apply the reviewed Console settings declaration',
    desiredState: { replicas: 2 },
  };
}

test('Platform change persists authorized intent before the first Gitea call', async () => {
  const { operations, order, accepted, proposed } = fixture();
  const result = await operations.propose({
    session,
    body: request(),
    idempotencyKey: 'platform-change-proposal-0001',
    correlationId: 'platform-change-correlation-0001',
  });
  assert.deepEqual(order, ['preflight', 'intent', 'gitea']);
  assert.equal(result.requestId, operationId);
  assert.equal(result.pullRequest.number, 17);
  assert.equal(result.operation.state, 'Planned');
  assert.equal(accepted[0].requiredPermission, 'console.git.change');
  assert.equal(accepted[0].ownerRef, 'API_GIT');
  assert.deepEqual(proposed[0].desiredState, { replicas: 2 });
});

test('Rejected Supabase intent causes zero Gitea calls', async () => {
  const { operations, order, proposed } = fixture({ rejectIntent: true });
  await assert.rejects(operations.propose({
    session,
    body: request(),
    idempotencyKey: 'platform-change-proposal-0002',
    correlationId: 'platform-change-correlation-0002',
  }), { code: 'PolicyRejected' });
  assert.deepEqual(order, ['preflight', 'intent']);
  assert.equal(proposed.length, 0);
});

test('Unavailable Gitea policy gate causes zero durable intent and zero mutation', async () => {
  const { operations, order, accepted, proposed } = fixture({ giteaReady: false });
  await assert.rejects(operations.propose({
    session,
    body: request(),
    idempotencyKey: 'platform-change-proposal-0006',
    correlationId: 'platform-change-correlation-0006',
  }), { code: 'AuthorityUnavailable', sideEffect: 'none' });
  assert.deepEqual(order, ['preflight']);
  assert.equal(accepted.length, 0);
  assert.equal(proposed.length, 0);
});

test('Ambiguous Gitea failure retains the durable operation identity for safe resume', async () => {
  const { operations, order, accepted } = fixture({ rejectGitea: true });
  await assert.rejects(operations.propose({
    session,
    body: request(),
    idempotencyKey: 'platform-change-proposal-0003',
    correlationId: 'platform-change-correlation-0003',
  }), (error) => {
    assert.equal(error.code, 'AuthorityUnavailable');
    assert.equal(error.sideEffect, 'unknown');
    assert.equal(error.operationId, operationId);
    return true;
  });
  assert.deepEqual(order, ['preflight', 'intent', 'gitea']);
  assert.equal(accepted.length, 1);
});

test('Platform change validation rejects unknown fields and oversized desired state before persistence', async () => {
  const { operations, order } = fixture();
  await assert.rejects(operations.propose({
    session,
    body: { ...request(), unexpected: true },
    idempotencyKey: 'platform-change-proposal-0004',
    correlationId: 'platform-change-correlation-0004',
  }), { code: 'ValidationFailed' });
  await assert.rejects(operations.propose({
    session,
    body: { ...request(), desiredState: { value: 'x'.repeat(65536) } },
    idempotencyKey: 'platform-change-proposal-0005',
    correlationId: 'platform-change-correlation-0005',
  }), { code: 'ValidationFailed' });
  await assert.rejects(operations.propose({
    session,
    body: { ...request(), desiredState: { database: { accessToken: 'must-never-enter-git' } } },
    idempotencyKey: 'platform-change-proposal-credential-0001',
    correlationId: 'platform-change-proposal-credential-correlation-0001',
  }), { code: 'ValidationFailed' });
  assert.deepEqual(order, []);
});

test('HTTP platform change route requires the shared CSRF and idempotency boundary', async () => {
  const { operations } = fixture();
  const sessionChecks = [];
  const handler = createConsoleApiHandler({
    resolveSession: async (_request, options) => { sessionChecks.push(options); return session; },
    platformChangeOperations: operations,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/platform/changes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-os-csrf-token': 'csrf-proof-for-platform-change',
        'x-os-idempotency-key': 'platform-change-http-0001',
        'x-os-correlation-id': 'platform-change-http-correlation-0001',
      },
      body: JSON.stringify(request()),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/platform/operations/${operationId}`);
    assert.equal(body.requestId, operationId);
    assert.deepEqual(sessionChecks, [{ requireCsrf: true, correlationId: 'platform-change-http-correlation-0001' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Platform change approval records independent approval before protected merge and binds its revision', async () => {
  const { operations, order, approvals, mergeBindings } = fixture();
  await operations.propose({
    session, body: request(), idempotencyKey: 'platform-change-proposal-approval-0001',
    correlationId: 'platform-change-proposal-approval-correlation-0001',
  });
  order.length = 0;
  const result = await operations.approve({
    session: approverSession,
    operationId,
    body: { reason: 'approve reviewed Console settings declaration' },
    idempotencyKey: 'platform-change-approval-0001',
    correlationId: 'platform-change-approval-correlation-0001',
  });
  assert.deepEqual(order, ['approval-read', 'approval', 'gitea', 'gitea-merge', 'merge-binding']);
  assert.equal(approvals[0].actorRef, approverSession.subjectId);
  assert.equal(approvals[0].expectedStateVersion, 0);
  assert.equal(mergeBindings[0].sourceRevision, 'b'.repeat(40));
  assert.equal(result.state, 'Submitted');
  assert.equal(result.mergeRevision, 'b'.repeat(40));
});

test('Gitea merge failure preserves Authorized operation for safe resume', async () => {
  const fixtureState = fixture({ rejectGitea: true });
  await fixtureState.operations.propose({
    session, body: request(), idempotencyKey: 'platform-change-proposal-approval-0002',
    correlationId: 'platform-change-proposal-approval-correlation-0002',
  }).catch(() => undefined);
  fixtureState.order.length = 0;
  await assert.rejects(fixtureState.operations.approve({
    session: approverSession, operationId,
    body: { reason: 'approve reviewed Console settings declaration' },
    idempotencyKey: 'platform-change-approval-0002',
    correlationId: 'platform-change-approval-correlation-0002',
  }), (error) => error.operationId === operationId && error.sideEffect === 'unknown');
  assert.equal(fixtureState.mergeBindings.length, 0);
  assert.deepEqual(fixtureState.order, ['approval-read', 'approval', 'gitea']);
});

test('Database failure after observed merge reports sideEffect present and retains revision for replay', async () => {
  const fixtureState = fixture({ rejectMergeBinding: true });
  await fixtureState.operations.propose({
    session, body: request(), idempotencyKey: 'platform-change-proposal-approval-0003',
    correlationId: 'platform-change-proposal-approval-correlation-0003',
  });
  fixtureState.order.length = 0;
  await assert.rejects(fixtureState.operations.approve({
    session: approverSession, operationId,
    body: { reason: 'approve reviewed Console settings declaration' },
    idempotencyKey: 'platform-change-approval-0003',
    correlationId: 'platform-change-approval-correlation-0003',
  }), (error) => error.operationId === operationId && error.sideEffect === 'present');
  assert.deepEqual(fixtureState.order, ['approval-read', 'approval', 'gitea', 'gitea-merge', 'merge-binding']);
  assert.equal(fixtureState.mergeBindings[0].sourceRevision, 'b'.repeat(40));
});

test('HTTP platform change approval keeps the shared CSRF and idempotency boundary', async () => {
  const { operations } = fixture();
  await operations.propose({
    session, body: request(), idempotencyKey: 'platform-change-http-proposal-0002',
    correlationId: 'platform-change-http-proposal-correlation-0002',
  });
  const handler = createConsoleApiHandler({
    resolveSession: async () => approverSession,
    platformChangeOperations: operations,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/platform/changes/${operationId}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-os-csrf-token': 'csrf-proof-for-platform-change-approval',
        'x-os-idempotency-key': 'platform-change-http-approval-0001',
        'x-os-correlation-id': 'platform-change-http-approval-correlation-0001',
      },
      body: JSON.stringify({ reason: 'approve reviewed Console settings declaration' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, 'Submitted');
    assert.equal(body.merged, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
