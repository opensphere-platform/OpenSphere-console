'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createR2d2RemediationApi } = require('./r2d2-remediation-api');
const { REPOSITORIES } = require('./r2d2-engineering-remediation');

const actorId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const assessmentId = '33333333-3333-4333-8333-333333333333';
const incidentId = '44444444-4444-4444-8444-444444444444';
const exact = (character) => `sha256:${character.repeat(64)}`;

function body() {
  return {
    incidentId, repositoryId: 'console', repository: REPOSITORIES.console.url,
    baseRevision: 'a'.repeat(40), allowedPaths: ['backend/opensphere-console-oaa-gateway/'],
    patchDigest: exact('b'), reason: 'known runtime mismatch requires a bounded source repair',
    riskLevel: 'R2', affectedComponents: ['oaaGateway'], affectedImages: ['opensphere-console-oaa-gateway'],
    requiredTests: ['unit','contract','integration','security'], releaseScope: 'component',
    targetChannel: 'edge', buildAuthority: 'localhost', rollbackRevision: 'c'.repeat(40),
    rollbackImageDigests: [exact('d')], approvalExpiresAt: '2999-01-01T00:00:00Z',
    idempotencyKey: 'remediation-proposal-1',
  };
}

function fixture(enabled = true) {
  const persisted = [];
  const api = createR2d2RemediationApi({
    proposalEnabled: enabled,
    authenticate: async () => ({ actor: { sub: actorId, browserSessionId: sessionId, assurance: 'aal2', credentialRevision: 9 } }),
    store: { propose: async (input) => {
      persisted.push(input);
      return {
        remediation_request_id: input.remediationRequestId, assessment_id: input.assessmentId,
        incident_id: input.incidentId, operation_id: '55555555-5555-4555-8555-555555555555',
        repository: input.repository, base_revision: input.baseRevision, allowed_paths: input.allowedPaths,
        patch_digest: input.patchDigest, reason: input.reason, risk_level: input.riskLevel,
        affected_components: input.affectedComponents, affected_images: input.affectedImages,
        required_tests: input.requiredTests, release_scope: input.releaseScope,
        full_release_justification: null, target_channel: input.targetChannel,
        build_authority: input.buildAuthority, rollback_revision: input.rollbackRevision,
        rollback_image_digests: input.rollbackImageDigests, approval_binding_digest: input.approvalBindingDigest,
        approval_expires_at: input.approvalExpiresAt, stage: 'proposed', created_at: 'now', updated_at: 'now',
      };
    } },
  });
  return { api, persisted };
}

test('proposal is patch-bound, session-bound and cannot activate repository or delivery execution', async () => {
  const { api, persisted } = fixture();
  const result = await api.propose({ headers: { 'x-os-idempotency-key': 'remediation-proposal-1' } }, assessmentId, body());
  assert.equal(persisted[0].actorId, actorId);
  assert.equal(persisted[0].authSessionId, sessionId);
  assert.match(persisted[0].approvalBindingDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.activation, { proposalOnly: true, repositoryWrite: false, build: false, publish: false, deploy: false });
});

test('proposal intake is default-off and rejects arbitrary source scope', async () => {
  const disabled = fixture(false).api;
  await assert.rejects(() => disabled.propose({ headers: {} }, assessmentId, body()), (error) => error?.code === 503);
  const enabled = fixture(true).api;
  await assert.rejects(() => enabled.propose({ headers: {} }, assessmentId, { ...body(), allowedPaths: ['../../secrets'] }), (error) => error?.code === 400);
});
