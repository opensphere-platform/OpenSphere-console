'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createR2d2RepairRunnerApi } = require('./r2d2-repair-runner-api');
const { CONSOLE_REPOSITORY } = require('./r2d2-repair-runner-contract');

const requestId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const operatorId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const runner = { runnerId: 'local-edge-test-runner', claimEpoch: 17 };
const exact = (value) => `sha256:${value.repeat(64)}`;

function fixture() {
  const calls = [];
  const row = {
    remediation_request_id: requestId, assessment_id: '55555555-5555-4555-8555-555555555555',
    incident_id: '66666666-6666-4666-8666-666666666666', operation_id: operationId,
    operator_id: operatorId, repository: CONSOLE_REPOSITORY, base_revision: 'a'.repeat(40),
    allowed_paths: ['apps/osaa-gateway/'], patch_digest: exact('b'), reason: 'bounded repair',
    risk_level: 'R2', affected_components: ['osaaGateway'], affected_images: ['opensphere-console-osaa-gateway'],
    required_tests: ['unit', 'contract', 'integration', 'security'], release_scope: 'component', target_channel: 'edge',
    build_authority: 'localhost', rollback_revision: 'c'.repeat(40), rollback_image_digests: [exact('d')],
    approval_binding_digest: exact('e'), approval_expires_at: '2999-01-01T00:00:00Z',
    approval_mode: 'local-edge-supervised', verification_profile: 'manual-route', verification_route: '/manual',
    stage: 'approved', claim_owner: runner.runnerId,
    claim_epoch: runner.claimEpoch, lease_expires_at: '2999-01-01T00:00:00Z',
  };
  const restRequest = async (resource, options = {}) => {
    calls.push({ resource, options });
    if (resource === 'rpc/register_engineering_remediation_runner') return [{ expires_at: '2999-01-01T00:00:00Z' }];
    if (resource === 'rpc/engineering_remediation_runner_ready') return true;
    if (resource === 'rpc/claim_engineering_remediation') return [row];
    if (resource === 'engineering_remediation_request') return [row];
    if (resource === 'module_operation') return [{ operation_id: operationId, actor_id: '00000000-0000-4000-8000-000000000006', auth_session_id: sessionId, authz_revision: '9' }];
    if (resource === 'remediation_patch_artifact') return [{ patch_digest: exact('b'),
      patch_text: '--- a/apps/osaa-gateway/server.js\n+++ b/apps/osaa-gateway/server.js\n',
      changed_paths: ['apps/osaa-gateway/server.js'], evidence_digest: exact('f') }];
    if (resource === 'module_operation_approval') return [{ approver_id: operatorId, assurance: 'aal2',
      approval_scope: 'source_patch', binding_digest: exact('e'), approval_expires_at: '2999-01-01T00:00:00Z', revoked_at: null }];
    if (resource === 'rpc/heartbeat_engineering_remediation') return true;
    if (resource === 'rpc/advance_engineering_remediation') return [{ ...row, stage: options.body.p_next_stage }];
    if (resource === 'engineering_browser_verification') return [{
      operator_id: operatorId, verification_profile: 'manual-route', verification_route: '/manual',
      observed_source_revision: 'f'.repeat(40), marker: '[data-manual-contract="console-help-center-v2"]',
      console_error_count: 0, network_failure_count: 0, passed: true, evidence_digest: exact('7'), observed_at: 'now',
    }];
    return [];
  };
  const api = createR2d2RepairRunnerApi({
    executionEnabled: true, authenticateAutomation: async () => ({ sub: 'automation' }), restRequest,
    resolveSession: async () => ({ active: true, actorId: operatorId, assurance: 'aal2', authzRevision: '9', permissions: ['r2d2.engineering.execute'] }),
  });
  return { api, calls };
}

test('runner registration and readiness use a fixed canonical repository', async () => {
  const { api, calls } = fixture();
  const out = await api.register({}, { ...runner, hostDigest: exact('1'), sourceRevision: 'a'.repeat(40) });
  assert.equal(out.ready, true); assert.equal(await api.ready(), true);
  assert.equal(calls[0].options.body.p_repository, CONSOLE_REPOSITORY);
});

test('claim returns only a patch-bound local edge request and never credentials', async () => {
  const { api } = fixture();
  const out = await api.claim({}, { ...runner, limit: 1 });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].request.actorId, operatorId);
  assert.equal(out.items[0].request.agentActorId, '00000000-0000-4000-8000-000000000006');
  assert.equal(out.items[0].request.patchArtifact.changedFiles[0], 'apps/osaa-gateway/server.js');
  assert.equal(JSON.stringify(out).includes('accessToken'), false);
});

test('runner authorization re-resolves the operator session and exact work-unit approval', async () => {
  const { api } = fixture();
  const result = await api.authorize({}, requestId, { ...runner, scope: 'source_patch', bindingDigest: exact('e') });
  assert.equal(result.allowed, true);
  const denied = await api.authorize({}, requestId, { ...runner, scope: 'source_patch', bindingDigest: exact('9') });
  assert.equal(denied.allowed, false);
});

test('runner stage and heartbeat calls remain claim-epoch fenced', async () => {
  const { api, calls } = fixture();
  assert.deepEqual(await api.heartbeat({}, requestId, runner), { alive: true });
  await api.transition({}, requestId, { ...runner, expectedStage: 'approved', nextStage: 'sandboxed', evidence: { patchDigest: exact('b') } });
  const transition = calls.find((item) => item.resource === 'rpc/advance_engineering_remediation').options.body;
  assert.equal(transition.p_worker, runner.runnerId); assert.equal(transition.p_claim_epoch, runner.claimEpoch);
  assert.match(transition.p_evidence_digest, /^sha256:[0-9a-f]{64}$/u);
});

test('runner reads only browser evidence bound to the claimed operator and fixed profile', async () => {
  const { api } = fixture();
  const out = await api.browserVerification({}, requestId, runner);
  assert.equal(out.ready, true); assert.equal(out.passed, true);
  assert.equal(out.observedSourceRevision, 'f'.repeat(40));
});

test('runner API remains fail-closed when execution is disabled', async () => {
  const api = createR2d2RepairRunnerApi({ executionEnabled: false, authenticateAutomation: async () => ({}), restRequest: async () => [] });
  await assert.rejects(() => api.claim({}, runner), (error) => error?.code === 503);
  assert.equal(await api.ready(), false);
});

test('Backend image carries the runner and deployment enables only the canonical Console lane', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  const deploy = fs.readFileSync(path.join(__dirname, 'deploy.yaml'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(dockerfile, /COPY backend\/opensphere-console-backend\/r2d2-repair-runner-api\.js \.\/r2d2-repair-runner-api\.js/u);
  assert.match(dockerfile, /COPY backend\/opensphere-console-backend\/r2d2-repair-runner-contract\.js \.\/r2d2-repair-runner-contract\.js/u);
  assert.match(deploy, /R2D2_ENGINEERING_PROPOSAL_ENABLED, value: "true"/u);
  assert.match(deploy, /R2D2_ENGINEERING_PROPOSAL_REPOSITORIES, value: "console"/u);
  assert.match(deploy, /R2D2_ENGINEERING_EXECUTION_ENABLED, value: "true"/u);
  assert.doesNotMatch(deploy, /R2D2_ENGINEERING_WORKER_READY/u);
  assert.match(server,
    /authenticate: async \(req, \{ requireAal2 = false \} = \{\}\)[\s\S]*?assertConsoleAdminActor\(session\.actor, \{ requireAal2 \}\)/u);
});
