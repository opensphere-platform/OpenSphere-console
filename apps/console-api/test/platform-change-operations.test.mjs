import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createOperationService } from '../src/operation-service.mjs';
import { createPlatformChangeOperations } from '../src/platform-change-operations.mjs';

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

function fixture({ rejectIntent = false, rejectGitea = false } = {}) {
  const order = [];
  const accepted = [];
  const proposed = [];
  const store = {
    async accept(input) {
      order.push('intent');
      if (rejectIntent) throw Object.assign(new Error('intent rejected'), { code: 'PolicyRejected', status: 422 });
      accepted.push(input);
      return { operationRecord: record(input), replayed: false };
    },
    async approve() { throw new Error('not used'); },
    async verify() { throw new Error('not used'); },
    async get() { return null; },
  };
  const operationService = createOperationService({ store, policyCatalog, clock: () => current });
  const giteaClient = {
    repository: 'opensphere-platform/platform-declarations',
    defaultBranch: 'main',
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
  };
  const operations = createPlatformChangeOperations({
    operationService, policyRevision: policyCatalog.policyRevision, giteaClient, clock: () => current,
  });
  return { operations, order, accepted, proposed };
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
  assert.deepEqual(order, ['intent', 'gitea']);
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
  assert.deepEqual(order, ['intent']);
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
  assert.deepEqual(order, ['intent', 'gitea']);
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
  assert.deepEqual(order, []);
});
