'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createR2d2RemediationApi, createRestRemediationWorkerStore } = require('./r2d2-remediation-api');
const { REPOSITORIES, patchTextDigest } = require('./r2d2-engineering-remediation');

const actorId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const assessmentId = '33333333-3333-4333-8333-333333333333';
const incidentId = '44444444-4444-4444-8444-444444444444';
const exact = (character) => `sha256:${character.repeat(64)}`;

function body() {
  const patchText = '--- a/backend/opensphere-console-oaa-gateway/server.js\n+++ b/backend/opensphere-console-oaa-gateway/server.js\n@@ -1 +1 @@\n-old\n+new\n';
  return {
    incidentId, repositoryId: 'console', repository: REPOSITORIES.console.url,
    baseRevision: 'a'.repeat(40), allowedPaths: ['backend/opensphere-console-oaa-gateway/'],
    patchText, patchDigest: exact('b'), reason: 'known runtime mismatch requires a bounded source repair',
    riskLevel: 'R2', affectedComponents: ['oaaGateway'], affectedImages: ['opensphere-console-oaa-gateway'],
    requiredTests: ['unit','contract','integration','security'], releaseScope: 'component',
    targetChannel: 'edge', buildAuthority: 'localhost', rollbackRevision: 'c'.repeat(40),
    rollbackImageDigests: [exact('d')], approvalExpiresAt: '2999-01-01T00:00:00Z',
    idempotencyKey: 'remediation-proposal-1',
  };
}

function fixture(enabled = true, executionEnabled = false, workerReady = false) {
  const persisted = []; const approvals = [];
  const rowFor = (input, stage = 'proposed') => ({
    remediation_request_id: input.remediationRequestId, assessment_id: input.assessmentId,
    incident_id: input.incidentId, operation_id: '55555555-5555-4555-8555-555555555555',
    repository: input.repository, base_revision: input.baseRevision, allowed_paths: input.allowedPaths,
    patch_digest: input.patchDigest, reason: input.reason, risk_level: input.riskLevel,
    affected_components: input.affectedComponents, affected_images: input.affectedImages,
    required_tests: input.requiredTests, release_scope: input.releaseScope,
    full_release_justification: null, target_channel: input.targetChannel,
    build_authority: input.buildAuthority, rollback_revision: input.rollbackRevision,
    rollback_image_digests: input.rollbackImageDigests, approval_binding_digest: input.approvalBindingDigest,
    approval_expires_at: input.approvalExpiresAt, stage, created_at: 'now', updated_at: 'now',
  });
  const store = { propose: async (input) => {
    persisted.push(input);
    return rowFor(input);
  }, get: async () => persisted[0], latestBuild: async () => null,
  approveScoped: async (input) => { approvals.push(input); return rowFor(persisted[0], 'approved'); } };
  const api = createR2d2RemediationApi({
    proposalEnabled: enabled, executionEnabled, workerReady,
    authenticate: async () => ({ actor: { sub: actorId, browserSessionId: sessionId, assurance: 'aal2', credentialRevision: 9 } }),
    store,
    now: () => new Date('2026-08-10T00:00:00Z'),
  });
  return { api, persisted, approvals };
}

test('proposal is patch-bound, session-bound and cannot activate repository or delivery execution', async () => {
  const { api, persisted } = fixture();
  const result = await api.propose({ headers: { 'x-os-idempotency-key': 'remediation-proposal-1' } }, assessmentId, body());
  assert.equal(persisted[0].actorId, actorId);
  assert.equal(persisted[0].authSessionId, sessionId);
  assert.equal(persisted[0].patchDigest, patchTextDigest(body().patchText));
  assert.deepEqual(persisted[0].patchArtifact.changedFiles, ['backend/opensphere-console-oaa-gateway/server.js']);
  assert.match(persisted[0].approvalBindingDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.activation, {
    proposalOnly: true, approvalApi: false, workerReady: false,
    repositoryWrite: false, build: false, publish: false, deploy: false,
  });
});

test('source execution requires a separate exact AAL2 approval and remains default-off', async () => {
  const disabled = fixture(true, false);
  const proposal = await disabled.api.propose({ headers: { 'x-os-idempotency-key': 'remediation-proposal-1' } }, assessmentId, body());
  await assert.rejects(() => disabled.api.approve({}, proposal.remediationRequestId, 'source_patch', {}),
    (error) => error?.code === 503);

  const enabled = fixture(true, true);
  const created = await enabled.api.propose({ headers: { 'x-os-idempotency-key': 'remediation-proposal-1' } }, assessmentId, body());
  const confirmation = `approve R2D2 source patch ${created.remediationRequestId} ${created.approvalBindingDigest}`;
  const approved = await enabled.api.approve({}, created.remediationRequestId, 'source_patch', { confirmation });
  assert.equal(approved.stage, 'approved');
  assert.equal(enabled.approvals[0].scope, 'source_patch');
  assert.equal(enabled.approvals[0].bindingDigest, created.approvalBindingDigest);
  assert.deepEqual(approved.activation, {
    proposalOnly: false, approvalApi: true, workerReady: false,
    repositoryWrite: false, build: false, publish: false, deploy: false,
  });
  await assert.rejects(() => enabled.api.approve({}, created.remediationRequestId, 'source_patch', { confirmation: 'approve everything' }),
    (error) => error?.code === 400);
});

test('execution capability is reported only when both approval API and an execution worker are ready', async () => {
  const ready = fixture(true, true, true);
  const created = await ready.api.propose({ headers: { 'x-os-idempotency-key': 'remediation-proposal-1' } }, assessmentId, body());
  assert.deepEqual(created.activation, {
    proposalOnly: false, approvalApi: true, workerReady: true,
    repositoryWrite: true, build: true, publish: true, deploy: true,
  });
});

test('proposal intake is default-off and rejects arbitrary source scope', async () => {
  const disabled = fixture(false).api;
  await assert.rejects(() => disabled.propose({ headers: {} }, assessmentId, body()), (error) => error?.code === 503);
  const enabled = fixture(true).api;
  await assert.rejects(() => enabled.propose({ headers: {} }, assessmentId, { ...body(), allowedPaths: ['../../secrets'] }), (error) => error?.code === 400);
});

test('dedicated worker store keeps claim fencing and expected deployment evidence distinct from observations', async () => {
  const calls = []; const requestId = '66666666-6666-4666-8666-666666666666';
  const operationId = '77777777-7777-4777-8777-777777777777';
  const rest = async (resource, options = {}) => {
    calls.push({ resource, options });
    if (resource === 'rpc/claim_engineering_remediation') return [{
      remediation_request_id: requestId, assessment_id: assessmentId, incident_id: incidentId,
      operation_id: operationId, repository: REPOSITORIES.console.url, base_revision: 'a'.repeat(40),
      allowed_paths: ['backend/'], patch_digest: exact('b'), reason: 'bounded repair', risk_level: 'R2',
      affected_components: ['oaaGateway'], affected_images: ['opensphere-console-oaa-gateway'],
      required_tests: ['unit'], release_scope: 'component', target_channel: 'edge', build_authority: 'localhost',
      rollback_revision: 'c'.repeat(40), rollback_image_digests: [exact('d')],
      approval_binding_digest: exact('e'), approval_expires_at: '2999-01-01T00:00:00Z', stage: 'approved',
    }];
    if (resource === 'module_operation') return [{ actor_id: actorId, auth_session_id: sessionId, authz_revision: 'rev-1' }];
    if (resource === 'remediation_patch_artifact') return [{
      patch_digest: exact('b'), patch_text: '--- a/backend/a\n+++ b/backend/a\n',
      changed_paths: ['backend/a'], evidence_digest: exact('f'),
    }];
    if (resource === 'module_operation_approval') return [{
      approver_id: actorId, assurance: 'aal2', approval_scope: 'source_patch',
      binding_digest: exact('e'), approval_expires_at: '2999-01-01T00:00:00Z', revoked_at: null,
    }];
    if (resource === 'rpc/heartbeat_engineering_remediation') return true;
    if (resource === 'rpc/advance_engineering_remediation') return [{ remediation_request_id: requestId }];
    return [];
  };
  const store = createRestRemediationWorkerStore(rest, 'worker-1', 17);
  const [claimed] = await store.claim(1);
  assert.equal(claimed.patchArtifact.patchDigest, exact('b'));
  assert.equal(await store.heartbeat(requestId), true);
  assert.equal((await store.getApprovals(operationId))[0].approvalScope, 'source_patch');
  await store.stage(requestId, 'sandboxed', {});
  await store.stage(requestId, 'patched', { deploymentBindingDigest: exact('1') });
  await store.recordBuildEvidence(requestId, {
    sourceRevision: 'a'.repeat(40), patchDigest: exact('b'), tests: [{ id: 'unit', status: 'passed' }],
    sbomDigest: exact('2'), provenanceDigest: exact('3'), signatureDigest: exact('4'),
    imageDigests: [exact('5')], buildAuthority: 'localhost', releaseLockDigest: exact('6'),
  });
  await store.recordDeploymentVerification(requestId, {
    expectedImageDigests: [exact('5')], observedImageDigests: [exact('7')],
    expectedLockDigest: exact('6'), lockDigest: exact('8'), api: { passed: false }, ui: { passed: false },
    rollbackVerified: true, status: 'rolled_back',
  });
  const advanceCalls = calls.filter((item) => item.resource === 'rpc/advance_engineering_remediation');
  assert.deepEqual(advanceCalls.map((item) => item.options.body.p_expected_stage), ['approved', 'sandboxed']);
  assert.ok(advanceCalls.every((item) => item.options.body.p_claim_epoch === 17));
  assert.equal(calls.some((item) => item.resource === 'engineering_remediation_request'), false);
  const buildEvidence = calls.find((item) => item.resource === 'rpc/record_engineering_build_evidence').options.body;
  assert.equal(buildEvidence.p_worker, 'worker-1');
  assert.equal(buildEvidence.p_claim_epoch, 17);
  const verification = calls.find((item) => item.resource === 'rpc/record_engineering_deployment_verification').options.body;
  assert.deepEqual(verification.p_expected_image_digests, [exact('5')]);
  assert.deepEqual(verification.p_observed_image_digests, [exact('7')]);
  assert.equal(verification.p_expected_lock_digest, exact('6'));
  assert.equal(verification.p_lock_digest, exact('8'));
  assert.equal(verification.p_worker, 'worker-1');
  assert.equal(verification.p_claim_epoch, 17);
});
