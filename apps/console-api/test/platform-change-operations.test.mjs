import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { createOperationService } from '../src/operation-service.mjs';
import { createPlatformChangeOperations } from '../src/platform-change-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import {
  ARGOCD_VERIFICATION_CONFIRMATION,
  ARGOCD_VERIFICATION_PATH,
  ARGOCD_VERIFICATION_TEMPLATE_ID,
} from '../src/argocd-verification-contract.mjs';

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

function fixture({ rejectIntent = false, rejectGitea = false, rejectProposalBinding = false,
  rejectMergeBinding = false, giteaReady = true, argocdReady = false,
  postMergeOwnerReady = true, wirePostMergeOwner = true } = {}) {
  const order = [];
  const accepted = [];
  const proposed = [];
  const approvals = [];
  const proposalBindings = [];
  const mergeBindings = [];
  let operationRecord = null;
  let ownerReady = postMergeOwnerReady;
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
    async listGiteaChanges() {
      order.push('projection');
      if (!operationRecord) return { observedAt: current.toISOString(), items: [] };
      return {
        observedAt: current.toISOString(),
        items: [{
          operationId, actorRef: operationRecord.actor_ref,
          action: operationRecord.execution_plan.action,
          target: operationRecord.execution_plan.target,
          reason: operationRecord.reason,
          repository: operationRecord.execution_plan.repository,
          state: operationRecord.state,
          sourceRevision: operationRecord.source_revision,
          errorCode: null,
          createdAt: operationRecord.created_at,
          updatedAt: operationRecord.updated_at,
          proposal: proposalBindings.length ? {
            branch: `control/${operationId}`, pullNumber: 17, desiredRevision: 'a'.repeat(40),
          } : null,
          approvals: approvals.map(() => ({
            approverId: approverSession.subjectId, createdAt: current.toISOString(),
          })),
          outbox: { attemptCount: 0, claimedAt: null, leaseExpiresAt: null, deliveredAt: null, createdAt: current.toISOString() },
        }],
      };
    },
    async recordGiteaProposal(input) {
      order.push('proposal-binding');
      proposalBindings.push(input);
      if (rejectProposalBinding) throw Object.assign(new Error('database unavailable'), {
        code: 'AuthorityUnavailable', status: 503,
      });
      return {
        proposalRecord: {
          repository: 'opensphere/platform-declarations', branch: input.branch,
          pullNumber: input.pullNumber, desiredRevision: input.desiredRevision,
        },
        replayed: proposalBindings.length > 1,
      };
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
    repository: 'opensphere/platform-declarations',
    organization: 'opensphere',
    defaultBranch: 'main',
    async supplyChainStatus() {
      order.push('preflight');
      return {
        configured: true,
        ready: giteaReady,
        checkedAt: current.toISOString(),
        version: '1.24.0',
        repository: 'opensphere/platform-declarations',
        defaultBranch: 'main',
        repositoryMetadata: {
          name: 'platform-declarations', private: true, archived: false, empty: false,
          defaultBranch: 'main', updatedAt: current.toISOString(), sizeKiB: 42,
        },
        protected: giteaReady,
        requiredApprovals: giteaReady ? 1 : 0,
        directPushEnabled: false,
        signedCommitsRequired: giteaReady,
        blockRejectedReviews: giteaReady,
        reason: giteaReady ? '' : 'branch protection is incomplete',
      };
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
    async argocdVerificationStatus() {
      order.push('argocd-status');
      return {
        ready: argocdReady,
        path: ARGOCD_VERIFICATION_PATH,
        mainRevision: 'c'.repeat(40),
        sourceSha: 'd'.repeat(40),
      };
    },
    async ensureArgocdVerificationProposal(input) {
      order.push('argocd-gitea');
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
  const dependencies = {
    operationService, policyRevision: policyCatalog.policyRevision, projectionStore: store, giteaClient, clock: () => current,
  };
  if (wirePostMergeOwner) dependencies.postMergeOwnerReady = () => ownerReady;
  const operations = createPlatformChangeOperations(dependencies);
  return {
    operations, order, accepted, proposed, approvals, proposalBindings, mergeBindings,
    setPostMergeOwnerReady(value) { ownerReady = value === true; },
  };
}

function bootstrapRequest() {
  return {
    reason: 'establish the fixed Argo CD verification declaration',
    confirm: ARGOCD_VERIFICATION_CONFIRMATION,
  };
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

test('Gitea status is current-session permission gated and keeps owner readiness false', async () => {
  const { operations, order } = fixture();
  await assert.rejects(operations.status({ session: { ...session, permissions: [] } }), {
    code: 'PermissionDenied', status: 403, sideEffect: 'none',
  });
  assert.deepEqual(order, []);

  const result = await operations.status({ session });
  assert.deepEqual(order, ['projection', 'preflight']);
  assert.equal(result.ready, true);
  assert.equal(result.managementReady, false);
  assert.equal(result.repositoryCount, 1);
  assert.equal(result.repositories[0].name, 'platform-declarations');
  assert.deepEqual(result.contracts, []);
  assert.match(result.reason, /post-merge owner reconciliation is not configured/u);
});

test('HTTP Gitea status is a CSRF-free authenticated read with no query surface', async () => {
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
    const response = await fetch(`http://127.0.0.1:${address.port}/api/platform/gitea/status`, {
      headers: { 'x-os-correlation-id': 'gitea-status-http-correlation-0001' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.meta.source, 'gitea');
    assert.equal(body.managementReady, false);
    assert.deepEqual(sessionChecks, [{ requireCsrf: false, correlationId: 'gitea-status-http-correlation-0001' }]);

    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/platform/gitea/status?detail=secret`);
    assert.equal(invalid.status, 400);
    assert.equal(sessionChecks.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Unconfigured post-merge owner keeps proposal paths fail-closed without durable or Gitea mutation', async () => {
  const state = fixture({ wirePostMergeOwner: false });
  await assert.rejects(state.operations.propose({
    session,
    body: request(),
    idempotencyKey: 'platform-change-owner-unavailable-0001',
    correlationId: 'platform-change-owner-unavailable-correlation-0001',
  }), {
    code: 'AuthorityUnavailable', status: 503, sideEffect: 'none',
    details: { managementReady: false },
  });
  assert.deepEqual(state.order, []);
  assert.equal(state.accepted.length, 0);
  assert.equal(state.proposed.length, 0);

  await assert.rejects(state.operations.bootstrapArgocdVerification({
    session,
    body: bootstrapRequest(),
    idempotencyKey: 'argocd-owner-unavailable-0001',
    correlationId: 'argocd-owner-unavailable-correlation-0001',
  }), {
    code: 'AuthorityUnavailable', status: 503, sideEffect: 'none',
    details: { managementReady: false },
  });
  assert.deepEqual(state.order, ['argocd-status']);
  assert.equal(state.accepted.length, 0);
  assert.equal(state.proposed.length, 0);
});

test('Platform change persists authorized intent before the first Gitea call', async () => {
  const { operations, order, accepted, proposed } = fixture();
  const result = await operations.propose({
    session,
    body: request(),
    idempotencyKey: 'platform-change-proposal-0001',
    correlationId: 'platform-change-correlation-0001',
  });
  assert.deepEqual(order, ['preflight', 'intent', 'gitea', 'proposal-binding']);
  assert.equal(result.requestId, operationId);
  assert.equal(result.pullRequest.number, 17);
  assert.equal(result.operation.state, 'Planned');
  assert.equal(accepted[0].requiredPermission, 'console.git.change');
  assert.equal(accepted[0].ownerRef, 'API_GIT');
  assert.deepEqual(proposed[0].desiredState, { replicas: 2 });
});

test('Database failure after proposal creation reports a present side effect for safe replay', async () => {
  const state = fixture({ rejectProposalBinding: true });
  await assert.rejects(state.operations.propose({
    session,
    body: request(),
    idempotencyKey: 'platform-change-proposal-receipt-0001',
    correlationId: 'platform-change-proposal-receipt-correlation-0001',
  }), (error) => {
    assert.equal(error.operationId, operationId);
    assert.equal(error.sideEffect, 'present');
    return true;
  });
  assert.deepEqual(state.order, ['preflight', 'intent', 'gitea', 'proposal-binding']);
});

test('Gitea status projects durable proposal coordinates without claiming an apply owner', async () => {
  const state = fixture();
  await state.operations.propose({
    session,
    body: request(),
    idempotencyKey: 'platform-change-proposal-status-0001',
    correlationId: 'platform-change-proposal-status-correlation-0001',
  });
  state.order.length = 0;
  const result = await state.operations.status({ session });
  assert.deepEqual(state.order, ['projection', 'preflight']);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].status, 'intent');
  assert.equal(result.changes[0].execution.pull_number, 17);
  assert.equal(result.changes[0].execution.desired_revision, 'a'.repeat(40));
  assert.equal(result.changes[0].execution.reconciler, 'NotConfigured');
  assert.equal(result.changes[0].outbox.status, 'pending');
  assert.equal(result.changes[0].outbox.next_attempt_at, null);
  assert.equal(result.byStatus.intent, 1);
  assert.equal(result.managementReady, false);
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

test('Argo CD bootstrap fixes path and declaration before durable proposal creation', async () => {
  const state = fixture();
  const result = await state.operations.bootstrapArgocdVerification({
    session,
    body: bootstrapRequest(),
    idempotencyKey: 'argocd-verification-bootstrap-0001',
    correlationId: 'argocd-verification-bootstrap-correlation-0001',
  });
  assert.deepEqual(state.order, ['argocd-status', 'intent', 'argocd-gitea', 'proposal-binding']);
  assert.equal(result.changed, true);
  assert.equal(result.ready, false);
  assert.equal(result.path, ARGOCD_VERIFICATION_PATH);
  assert.equal(state.accepted[0].executionPlan.templateId, ARGOCD_VERIFICATION_TEMPLATE_ID);
  assert.equal(state.accepted[0].executionPlan.target, ARGOCD_VERIFICATION_PATH);
  assert.equal(state.proposed[0].sourceSha, 'd'.repeat(40));
  assert.deepEqual(Object.keys(state.proposed[0]).sort(), ['operationId', 'reason', 'sourceSha']);
});

test('Argo CD bootstrap returns an observed no-op and performs no durable mutation when main already matches', async () => {
  const state = fixture({ argocdReady: true });
  const result = await state.operations.bootstrapArgocdVerification({
    session,
    body: bootstrapRequest(),
    idempotencyKey: 'argocd-verification-bootstrap-noop-0001',
    correlationId: 'argocd-verification-bootstrap-noop-correlation-0001',
  });
  assert.deepEqual(state.order, ['argocd-status']);
  assert.deepEqual(result, {
    ready: true,
    changed: false,
    path: ARGOCD_VERIFICATION_PATH,
    mergeRevision: 'c'.repeat(40),
  });
  assert.equal(state.accepted.length, 0);
  assert.equal(state.proposed.length, 0);
});

test('Argo CD bootstrap rejects input expansion and reserved template impersonation', async () => {
  const state = fixture();
  await assert.rejects(state.operations.bootstrapArgocdVerification({
    session,
    body: { ...bootstrapRequest(), path: 'operator/controlled.json' },
    idempotencyKey: 'argocd-verification-bootstrap-0002',
    correlationId: 'argocd-verification-bootstrap-correlation-0002',
  }), { code: 'ValidationFailed' });
  await assert.rejects(state.operations.bootstrapArgocdVerification({
    session,
    body: { ...bootstrapRequest(), confirm: 'yes' },
    idempotencyKey: 'argocd-verification-bootstrap-0003',
    correlationId: 'argocd-verification-bootstrap-correlation-0003',
  }), { code: 'Conflict', status: 409 });
  await assert.rejects(state.operations.propose({
    session,
    body: { ...request(), templateId: ARGOCD_VERIFICATION_TEMPLATE_ID },
    idempotencyKey: 'argocd-verification-bootstrap-0004',
    correlationId: 'argocd-verification-bootstrap-correlation-0004',
  }), { code: 'ValidationFailed' });
  await assert.rejects(state.operations.propose({
    session,
    body: { ...request(), target: ARGOCD_VERIFICATION_PATH },
    idempotencyKey: 'argocd-verification-bootstrap-0005',
    correlationId: 'argocd-verification-bootstrap-correlation-0005',
  }), { code: 'ValidationFailed' });
  assert.deepEqual(state.order, []);
});

test('HTTP Argo CD bootstrap uses the shared CSRF and idempotency boundary', async () => {
  const state = fixture();
  const sessionChecks = [];
  const handler = createConsoleApiHandler({
    resolveSession: async (_request, options) => { sessionChecks.push(options); return session; },
    platformChangeOperations: state.operations,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/platform/gitea/bootstrap/argocd-verification`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-os-csrf-token': 'csrf-proof-for-argocd-bootstrap',
        'x-os-idempotency-key': 'argocd-verification-bootstrap-http-0001',
        'x-os-correlation-id': 'argocd-verification-bootstrap-http-correlation-0001',
      },
      body: JSON.stringify(bootstrapRequest()),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/platform/operations/${operationId}`);
    assert.equal(body.path, ARGOCD_VERIFICATION_PATH);
    assert.deepEqual(sessionChecks, [{ requireCsrf: true, correlationId: 'argocd-verification-bootstrap-http-correlation-0001' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Argo CD bootstrap uses the fixed writer again during independent approval', async () => {
  const state = fixture();
  await state.operations.bootstrapArgocdVerification({
    session,
    body: bootstrapRequest(),
    idempotencyKey: 'argocd-verification-bootstrap-approval-0001',
    correlationId: 'argocd-verification-bootstrap-approval-correlation-0001',
  });
  state.order.length = 0;
  const result = await state.operations.approve({
    session: approverSession,
    operationId,
    body: { reason: 'approve the fixed Argo CD verification declaration' },
    idempotencyKey: 'argocd-verification-bootstrap-approval-0002',
    correlationId: 'argocd-verification-bootstrap-approval-correlation-0002',
  });
  assert.deepEqual(state.order, ['approval-read', 'approval', 'argocd-gitea', 'proposal-binding', 'gitea-merge', 'merge-binding']);
  assert.equal(result.merged, true);
});

test('Argo CD bootstrap approval rejects a stored fixed-plan substitution before Gitea', async () => {
  const state = fixture();
  await state.operations.bootstrapArgocdVerification({
    session,
    body: bootstrapRequest(),
    idempotencyKey: 'argocd-verification-bootstrap-tamper-0001',
    correlationId: 'argocd-verification-bootstrap-tamper-correlation-0001',
  });
  state.accepted[0].executionPlan.target = 'operator/controlled.json';
  state.order.length = 0;
  await assert.rejects(state.operations.approve({
    session: approverSession,
    operationId,
    body: { reason: 'approve the fixed Argo CD verification declaration' },
    idempotencyKey: 'argocd-verification-bootstrap-tamper-0002',
    correlationId: 'argocd-verification-bootstrap-tamper-correlation-0002',
  }), { code: 'ClaimBindingMismatch', status: 409 });
  assert.deepEqual(state.order, ['approval-read']);
});

test('Owner readiness loss blocks approval before operation, proposal, or merge mutation', async () => {
  const state = fixture();
  await state.operations.propose({
    session, body: request(), idempotencyKey: 'platform-change-owner-loss-proposal-0001',
    correlationId: 'platform-change-owner-loss-proposal-correlation-0001',
  });
  state.setPostMergeOwnerReady(false);
  state.order.length = 0;
  await assert.rejects(state.operations.approve({
    session: approverSession,
    operationId,
    body: { reason: 'approve reviewed Console settings declaration' },
    idempotencyKey: 'platform-change-owner-loss-approval-0001',
    correlationId: 'platform-change-owner-loss-approval-correlation-0001',
  }), {
    code: 'AuthorityUnavailable', status: 503, sideEffect: 'none',
    details: { managementReady: false },
  });
  assert.deepEqual(state.order, []);
  assert.equal(state.approvals.length, 0);
  assert.equal(state.mergeBindings.length, 0);
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
  assert.deepEqual(order, ['approval-read', 'approval', 'gitea', 'proposal-binding', 'gitea-merge', 'merge-binding']);
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
  assert.deepEqual(fixtureState.order, ['approval-read', 'approval', 'gitea', 'proposal-binding', 'gitea-merge', 'merge-binding']);
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

test('Change-control UI disables both mutations while management is unavailable and makes no automatic-apply promise', async () => {
  const source = await readFile(
    new URL('../../console-web/src/app/pages/admin-change-control.ts', import.meta.url), 'utf8',
  );
  assert.match(source, /current\.managementReady && change\.status === 'authorized'/u);
  assert.match(source, /async submitChange\(\): Promise<void> \{ if \(!this\.managementReady\(\)\)/u);
  assert.match(source, /async approveSelected\(reason: string\): Promise<void> \{[^\n]+if \(!this\.managementReady\(\)\)/u);
  assert.doesNotMatch(source, /자동 적용|자동 실행/u);
});
