'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  POSTGRES_LIFECYCLE_MATRIX, capabilityAvailability, lifecycleCoverage,
  readinessDecision, operationWorkflow,
} = require('./r2d2-postgres-workflow');

const capabilities = { capability: 'data.sql.postgres', operations: ['catalog.read','cluster.plan','cluster.create','operation.watch'] };
const OPERATION_ID = '8a3f9d41-1b4e-4d71-9d36-71c0cb73af52';
const EVIDENCE_REVISION = 'a'.repeat(64);
const readiness = (overrides = {}) => ({
  capability: 'data.sql.postgres', observedAt: '2026-08-14T00:00:00Z',
  evidenceRevision: 'a'.repeat(64), sourceRevision: 'owner-v1',
  evidence: [{ id: 'owner', stale: false }], staleness: { stale: false },
  ...overrides,
});
const canonicalSuccess = () => ({
  operationId: OPERATION_ID,
  planId: 'pgplan-11111111-1111-4111-8111-111111111111',
  planDigest: `sha256:${'b'.repeat(64)}`,
  actionDigest: `sha256:${'c'.repeat(64)}`,
  phase: 'Succeeded',
  stage: 'Ready',
  verificationState: 'succeeded',
  verifierId: 'owner.foundation.postgres.ready',
  completion: {
    terminal: true,
    success: true,
    verified: true,
    state: 'Succeeded',
    stale: false,
    evidenceRevision: EVIDENCE_REVISION,
    receipt: {
      operationId: OPERATION_ID,
      verifierId: 'owner.foundation.postgres.ready',
      verificationState: 'succeeded',
      verifiedAt: '2026-08-14T01:02:03.000Z',
      updatedAt: '2026-08-14T01:02:03.000Z',
      semanticIdentity: {
        capabilityId: 'data.sql.postgres',
        requestType: 'Instance',
        actionId: 'cluster.create',
        toolId: 'foundation.postgres.apply',
      },
      actionBinding: {
        method: 'POST',
        path: '/api/foundation/oaa/postgres/durable-apply/{planId}',
        pathParams: ['planId'],
        approval: 'exact-confirmation',
      },
      ownerEvidenceRevision: EVIDENCE_REVISION,
      additiveOwnerField: { allowed: true },
    },
    additiveCompletionField: 'allowed',
  },
});

test('missing, stale and not-ready owner evidence returns stable blocker and nextAction', () => {
  assert.equal(readinessDecision(null, capabilities).blocker.code, 'POSTGRES_READINESS_MISSING');
  assert.equal(readinessDecision(readiness({ observedAt: '2020-01-01T00:00:00Z' }), capabilities,
    { nowMs: Date.parse('2026-08-14T00:00:00Z') }).blocker.code, 'POSTGRES_READINESS_STALE');
  const blocked = readinessDecision(readiness({ readyToPlan: false,
    blockers: [{ code: 'CATALOG_BLOCKED', message: 'catalog unavailable', remediation: { owner: 'PFSS', action: 'restore catalog', automatic: false } }] }), capabilities,
  { nowMs: Date.parse('2026-08-14T00:00:10Z') });
  assert.equal(blocked.blocker.code, 'CATALOG_BLOCKED'); assert.deepEqual(blocked.nextAction, { owner: 'PFSS', action: 'restore catalog', automatic: false });
});

test('every canonical stale signal blocks planning even with a fresh observedAt', () => {
  const cases = [
    readiness({ stale: true }),
    readiness({ staleness: { stale: true } }),
    readiness({ evidence: [{ id: 'owner', stale: true }] }),
  ];
  for (const item of cases) {
    const decision = readinessDecision(item, capabilities, { nowMs: Date.parse('2026-08-14T00:00:10Z') });
    assert.equal(decision.readyToPlan, false);
    assert.equal(decision.blocker.code, 'POSTGRES_READINESS_STALE');
  }
});

test('v1 readiness without evidenceRevision or sourceRevision fails closed with stable provenance blocker', () => {
  for (const item of [readiness({ evidenceRevision: '' }), readiness({ sourceRevision: '' })]) {
    const decision = readinessDecision(item, capabilities, { nowMs: Date.parse('2026-08-14T00:00:10Z') });
    assert.equal(decision.readyToPlan, false);
    assert.equal(decision.blocker.code, 'POSTGRES_READINESS_PROVENANCE_MISSING');
    assert.equal(decision.nextAction.owner, 'PFSS');
  }
});

test('planning can proceed while independent execution approval remains an explicit blocker', () => {
  const decision = readinessDecision(readiness({ state: 'Blocked',
    readyToPlan: true, readyToExecute: false, blockers: [{ code: 'INDEPENDENT_AAL2_APPROVAL_REQUIRED', message: 'approval required', remediation: { owner: 'Console', action: 'approve', automatic: false } }] }), capabilities,
  { nowMs: Date.parse('2026-08-14T00:00:10Z') });
  assert.equal(decision.readyToPlan, true); assert.equal(decision.readyToExecute, false);
  assert.equal(decision.blocker.code, 'INDEPENDENT_AAL2_APPROVAL_REQUIRED');
});

test('operation receipt maps to the stable conversational workflow vocabulary', () => {
  assert.equal(operationWorkflow({ phase: 'AwaitingApproval' }).phase, 'AwaitingApproval');
  assert.equal(operationWorkflow({ phase: 'Queued' }).phase, 'Accepted');
  assert.equal(operationWorkflow({ phase: 'Reconciling', stage: 'RuntimeProvisioning' }).phase, 'Reconciling');
  const complete = operationWorkflow(canonicalSuccess());
  assert.equal(complete.phase, 'Ready'); assert.equal(complete.success, true); assert.equal(complete.verified, true);
  assert.equal(complete.ownerEvidence.semanticIdentity.toolId, 'foundation.postgres.apply');
  assert.equal(complete.ownerEvidence.actionBinding.path, '/api/foundation/oaa/postgres/durable-apply/{planId}');
  assert.equal(complete.ownerEvidence.planId, 'pgplan-11111111-1111-4111-8111-111111111111');
  assert.equal(complete.ownerEvidence.planDigest, `sha256:${'b'.repeat(64)}`);
  assert.equal(complete.ownerEvidence.actionDigest, `sha256:${'c'.repeat(64)}`);
  assert.equal(operationWorkflow({ phase: 'VerificationFailed' }).phase, 'Failed');
  assert.equal(operationWorkflow({ phase: 'Inconclusive' }).phase, 'Unknown');
});

test('canonical PostgreSQL receipt projection retains the external Owner identity and never an R2D2 adapter alias', () => {
  const workflow = operationWorkflow(canonicalSuccess());
  assert.deepEqual(workflow.ownerEvidence.semanticIdentity, {
    capabilityId: 'data.sql.postgres', requestType: 'Instance',
    actionId: 'cluster.create', toolId: 'foundation.postgres.apply',
  });
  assert.deepEqual(workflow.ownerEvidence.actionBinding, {
    method: 'POST', path: '/api/foundation/oaa/postgres/durable-apply/{planId}',
    pathParams: ['planId'], approval: 'exact-confirmation',
  });
  assert.equal(JSON.stringify(workflow).includes('owner.foundation.postgres.create'), false);
});

test('success-like stage and phase never bypass canonical verified completion receipt', () => {
  const stageOnly = operationWorkflow({ phase: 'Running', stage: 'Ready', verificationState: 'pending' });
  assert.equal(stageOnly.phase, 'Reconciling'); assert.equal(stageOnly.success, false);
  const phaseOnly = operationWorkflow({ phase: 'Succeeded', stage: 'Ready', verificationState: 'succeeded' });
  assert.equal(phaseOnly.phase, 'Unknown'); assert.equal(phaseOnly.success, false);
  for (const completion of [
    { terminal: true, success: true, verified: false, receipt: { id: 'receipt' } },
    { terminal: true, success: true, verified: true, receipt: {} },
  ]) {
    const result = operationWorkflow({ phase: 'Succeeded', verificationState: 'succeeded', completion });
    assert.equal(result.phase, 'Unknown'); assert.equal(result.success, false);
  }
  const pending = operationWorkflow({ phase: 'Succeeded', verificationState: 'pending',
    completion: { terminal: true, success: true, verified: true, receipt: { id: 'receipt' } } });
  assert.equal(pending.phase, 'Unknown'); assert.equal(pending.success, false);
});

test('canonical receipt rejects mismatched operation and owner evidence revisions', () => {
  const wrongOperation = canonicalSuccess();
  wrongOperation.completion.receipt.operationId = '11111111-1111-4111-8111-111111111111';
  const wrongEvidence = canonicalSuccess();
  wrongEvidence.completion.receipt.ownerEvidenceRevision = 'b'.repeat(64);
  for (const [operation, reason] of [[wrongOperation, 'operation_id_mismatch'], [wrongEvidence, 'evidence_revision_mismatch']]) {
    const result = operationWorkflow(operation);
    assert.equal(result.phase, 'Unknown'); assert.equal(result.success, false);
    assert.equal(result.blocker.code, 'POSTGRES_COMPLETION_RECEIPT_UNVERIFIED');
    assert.ok(result.blocker.details.includes(reason));
  }
});

test('canonical receipt rejects missing verifier and semantic identity', () => {
  const missingVerifier = canonicalSuccess();
  missingVerifier.completion.receipt.verifierId = '';
  const missingIdentity = canonicalSuccess();
  delete missingIdentity.completion.receipt.semanticIdentity;
  for (const [operation, reason] of [[missingVerifier, 'verifier_id_missing'], [missingIdentity, 'semantic_identity_mismatch']]) {
    const result = operationWorkflow(operation);
    assert.equal(result.phase, 'Unknown'); assert.equal(result.success, false);
    assert.ok(result.blocker.details.includes(reason));
  }
});

test('canonical receipt requires succeeded verification, ISO time, durable apply binding, and fresh explicit completion', () => {
  const fixtures = [];
  const pending = canonicalSuccess(); pending.verificationState = 'pending'; fixtures.push([pending, 'verification_not_succeeded']);
  const receiptPending = canonicalSuccess(); receiptPending.completion.receipt.verificationState = 'pending'; fixtures.push([receiptPending, 'verification_not_succeeded']);
  const badTime = canonicalSuccess(); badTime.completion.receipt.verifiedAt = 'yesterday'; fixtures.push([badTime, 'verified_at_invalid']);
  const impossibleTime = canonicalSuccess(); impossibleTime.completion.receipt.verifiedAt = '2026-02-30T01:02:03.000Z'; fixtures.push([impossibleTime, 'verified_at_invalid']);
  const badBinding = canonicalSuccess(); badBinding.completion.receipt.actionBinding.path = '/api/foundation/oaa/postgres/apply'; fixtures.push([badBinding, 'action_binding_mismatch']);
  const badMethod = canonicalSuccess(); badMethod.completion.receipt.actionBinding.method = 'GET'; fixtures.push([badMethod, 'action_binding_mismatch']);
  const databaseRequest = canonicalSuccess(); databaseRequest.completion.receipt.semanticIdentity.requestType = 'Database'; fixtures.push([databaseRequest, 'semantic_identity_mismatch']);
  const accessRequest = canonicalSuccess(); accessRequest.completion.receipt.semanticIdentity.requestType = 'Access'; fixtures.push([accessRequest, 'semantic_identity_mismatch']);
  const wrongPathParam = canonicalSuccess(); wrongPathParam.completion.receipt.actionBinding.pathParams = ['operationId']; fixtures.push([wrongPathParam, 'action_binding_mismatch']);
  const missingPathParam = canonicalSuccess(); delete missingPathParam.completion.receipt.actionBinding.pathParams; fixtures.push([missingPathParam, 'action_binding_mismatch']);
  const extraPathParam = canonicalSuccess(); extraPathParam.completion.receipt.actionBinding.pathParams = ['planId', 'operationId']; fixtures.push([extraPathParam, 'action_binding_mismatch']);
  const missingApproval = canonicalSuccess(); delete missingApproval.completion.receipt.actionBinding.approval; fixtures.push([missingApproval, 'action_binding_mismatch']);
  const stale = canonicalSuccess(); stale.completion.stale = true; fixtures.push([stale, 'completion_stale_or_missing']);
  const stringReceipt = canonicalSuccess(); stringReceipt.completion.receipt = 'non-empty'; fixtures.push([stringReceipt, 'receipt_object_missing']);
  const arrayReceipt = canonicalSuccess(); arrayReceipt.completion.receipt = [{ operationId: OPERATION_ID }]; fixtures.push([arrayReceipt, 'receipt_object_missing']);
  for (const [operation, reason] of fixtures) {
    const result = operationWorkflow(operation);
    assert.equal(result.phase, 'Unknown'); assert.equal(result.success, false);
    assert.ok(result.blocker.details.includes(reason));
  }
});

test('Database, Access and Day-2 remain explicit stable blockers until the owner publishes typed operations', () => {
  const unavailable = capabilityAvailability(capabilities);
  for (const area of ['database', 'access', 'day2']) {
    assert.equal(unavailable[area].available, false);
    assert.match(unavailable[area].blocker.code, /^POSTGRES_.+_CAPABILITY_NOT_AVAILABLE$/);
    assert.equal(unavailable[area].nextAction.owner, 'PFSS');
  }
  const available = capabilityAvailability({ capability: 'data.sql.postgres', operations: [
    'database.create', 'access.create', 'cluster.scale',
  ] });
  assert.equal(available.database.available, true);
  assert.equal(available.access.available, true);
  assert.equal(available.day2.available, true);
});

test('lifecycle coverage is exactly the seven published Owner actions plus fail-closed proposals', () => {
  const published = {
    capability: 'data.sql.postgres',
    operations: ['catalog.read', 'cluster.plan', 'cluster.create', 'cluster.status', 'operation.watch'],
    supportedRequestTypes: ['Instance'],
    actions: [
      ['capability.read', 'R0'], ['readiness.read', 'R0'], ['catalog.read', 'R0'],
      ['cluster.plan', 'R2'], ['cluster.create', 'R2'], ['cluster.status', 'R0'], ['operation.watch', 'R0'],
    ].map(([actionId, riskClass]) => ({ actionId, riskClass })),
  };
  const coverage = lifecycleCoverage(published);
  assert.equal(capabilityAvailability(published).lifecycle.length, POSTGRES_LIFECYCLE_MATRIX.length);
  const actual = coverage.filter((row) => row.proposed !== true);
  assert.equal(actual.length, 7);
  assert.equal(POSTGRES_LIFECYCLE_MATRIX.length, 13);
  assert.ok(actual.every((row) => row.available && row.supportState === 'owner-facade'));
  const create = actual.find((row) => row.id === 'cluster.create');
  assert.equal(create.ownerToolId, 'foundation.postgres.apply');
  assert.equal(create.r2d2Tool, 'oaa.foundation.postgres.claim.create');
  assert.equal(create.ownerRoute, '/api/foundation/oaa/postgres/durable-apply/{planId}');
  const database = coverage.find((row) => row.requestType === 'Database');
  const access = coverage.find((row) => row.requestType === 'Access');
  assert.equal(database.available, false);
  assert.equal(database.supportState, 'unavailable');
  assert.equal(access.available, false);
  assert.equal(access.supportState, 'unavailable');
  for (const row of coverage.filter((item) => item.proposed === true)) {
    assert.equal(row.available, false);
    assert.equal(row.supportState, 'unavailable');
    assert.equal(row.blocker.code, 'POSTGRES_OWNER_OPERATION_UNAVAILABLE');
  }
});

test('each unpublished update/delete/cancel/rollback lifecycle action remains unavailable at the action level', () => {
  const coverage = lifecycleCoverage({
    capability: 'data.sql.postgres', supportedRequestTypes: ['Instance'],
    operations: ['cluster.create'], actions: [{ actionId: 'cluster.create', riskClass: 'R2' }],
  });
  for (const id of ['update', 'delete', 'cancel', 'rollback']) {
    const row = coverage.find((item) => item.id === id);
    assert.equal(row.available, false, id);
    assert.equal(row.supportState, 'unavailable', id);
    assert.equal(row.r2d2Tool, null, id);
    assert.equal(row.cliCommand, null, id);
    assert.equal(row.blocker.code, 'POSTGRES_OWNER_OPERATION_UNAVAILABLE', id);
  }
});

test('a published Owner risk downgrade fails closed without inventing an alternate action route', () => {
  const coverage = lifecycleCoverage({
    capability: 'data.sql.postgres', operations: ['cluster.create'],
    actions: [{ actionId: 'cluster.create', riskClass: 'R0' }],
  });
  const create = coverage.find((row) => row.id === 'cluster.create');
  assert.equal(create.available, false);
  assert.equal(create.blocker.code, 'POSTGRES_OWNER_RISK_MISMATCH');
  assert.equal(create.r2d2Tool, 'oaa.foundation.postgres.claim.create');
});
