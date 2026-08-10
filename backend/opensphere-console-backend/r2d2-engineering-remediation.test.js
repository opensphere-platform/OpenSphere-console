'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPOSITORIES, assessRemediation, validateEnvelope, approvalStillValid, sandboxSpec,
  validatePatchFiles, validatePatchArtifact, patchTextDigest, validateBuildEvidence, verifyDeployment, deploymentApprovalBinding,
  exactEngineeringConfirmation, approvalsSatisfied, EngineeringRemediationWorker,
} = require('./r2d2-engineering-remediation');

const sha = 'a'.repeat(40); const image = `sha256:${'b'.repeat(64)}`; const patch = `sha256:${'c'.repeat(64)}`;
function envelope() {
  return validateEnvelope({
    remediationRequestId: 'request-1', incidentId: 'incident-1', repositoryId: 'console', repository: REPOSITORIES.console.url,
    baseRevision: sha, allowedPaths: ['backend/opensphere-console-oaa-gateway/'], patchDigest: patch, reason: 'runtime mismatch requires source repair',
    riskLevel: 'R2', affectedComponents: ['oaaGateway'], affectedImages: ['opensphere-console-oaa-gateway'],
    requiredTests: ['unit','contract','security'], releaseScope: 'component', targetChannel: 'edge', buildAuthority: 'localhost',
    rollbackRevision: sha, rollbackImageDigests: [image], approvalExpiresAt: '2999-01-01T00:00:00Z',
  });
}

test('engineering remediation is unavailable until lower ladder steps are evidence-exhausted', () => {
  assert.equal(assessRemediation({ epistemicState: 'known' }, []).engineeringRequired, false);
  const attempts = [0,1,2,3,4].map((step) => ({ step, status: 'exhausted', evidenceDigest: patch }));
  assert.equal(assessRemediation({ epistemicState: 'known' }, attempts).engineeringRequired, true);
  assert.equal(assessRemediation({ epistemicState: 'stale' }, attempts).blocked, true);
});

test('approval envelope rejects arbitrary repository, path, command and channel authority', () => {
  const valid = envelope(); assert.match(valid.approvalBindingDigest, /^sha256:/);
  assert.throws(() => validateEnvelope({ ...valid, repositoryId: 'console', repository: 'https://evil/repo/x.git' }), /canonical/);
  assert.throws(() => validateEnvelope({ ...valid, allowedPaths: ['../secret'] }), /escapes/);
  assert.throws(() => validateEnvelope({ ...valid, requiredTests: ['curl evil'] }), /registered command/);
  assert.throws(() => validateEnvelope({ ...valid, buildAuthority: 'github-actions' }), /edge build authority/);
});

test('any patch-bound field change invalidates approval', () => {
  const current = envelope();
  const approved = { approvalBindingDigest: current.approvalBindingDigest, approvalExpiresAt: current.approvalExpiresAt };
  assert.equal(approvalStillValid(current, approved), true);
  assert.equal(approvalStillValid({ ...current, patchDigest: image }, approved), false);
  assert.equal(approvalStillValid({ ...current, affectedImages: ['other'] }, approved), false);
  assert.equal(approvalStillValid({ ...current, reason: 'a different approved reason' }, approved), false);
  assert.equal(approvalStillValid({ ...current, fullReleaseJustification: 'a newly introduced integrated rationale' }, approved), false);
});

test('sandbox is ephemeral, credential-free, networkless and command-closed', () => {
  const spec = sandboxSpec(envelope(), 'D:/isolated-r2d2');
  assert.equal(spec.network, 'none'); assert.deepEqual(spec.credentials, []); assert.equal(spec.ephemeral, true);
  assert.ok(spec.commands.every((item) => item.shell === false && item.arguments.length === 0));
  assert.throws(() => validatePatchFiles(['../../outside'], envelope()), /escapes/);
  assert.deepEqual(validatePatchFiles(['backend/opensphere-console-oaa-gateway/server.js'], envelope()), ['backend/opensphere-console-oaa-gateway/server.js']);
});

test('unified diff artifact is byte-bounded, credential-free, path-closed and exact-digest bound', () => {
  const text = '--- a/backend/opensphere-console-oaa-gateway/server.js\n+++ b/backend/opensphere-console-oaa-gateway/server.js\n@@ -1 +1 @@\n-old\n+new\n';
  const approved = { ...envelope(), patchDigest: patchTextDigest(text) };
  const artifact = validatePatchArtifact(text, approved);
  assert.deepEqual(artifact.changedFiles, ['backend/opensphere-console-oaa-gateway/server.js']);
  assert.equal(artifact.patchDigest, approved.patchDigest);
  assert.throws(() => validatePatchArtifact(text.replace('+new', '+Bearer abcdefghijklmnopqrstuvwxyz'), { ...approved, patchDigest: patchTextDigest(text.replace('+new', '+Bearer abcdefghijklmnopqrstuvwxyz')) }), /credential-like/);
  const escape = '--- a/../secret\n+++ b/../secret\n@@ -1 +1 @@\n-old\n+new\n';
  assert.throws(() => validatePatchArtifact(escape, { ...approved, patchDigest: patchTextDigest(escape) }), /escapes/);
  assert.throws(() => validatePatchArtifact(text, { ...approved, patchDigest: image }), /differs from approval/);
});

test('build evidence is bound to patch, authority, tests, SBOM, provenance, signature and exact digest', () => {
  const approved = envelope();
  const evidence = { sourceRevision: sha, patchDigest: patch, buildAuthority: 'localhost', imageDigests: [image], sbomDigest: image, provenanceDigest: image, signatureDigest: image, releaseLockDigest: image,
    tests: ['unit','contract','security'].map((id) => ({ id, status: 'passed' })) };
  assert.equal(validateBuildEvidence(approved, evidence).valid, true);
  assert.throws(() => validateBuildEvidence(approved, { ...evidence, patchDigest: image }), /approved patch/);
  assert.throws(() => validateBuildEvidence(approved, { ...evidence, tests: [] }), /tests are incomplete/);
});

test('deployment succeeds only on exact digest and API/UI postconditions', () => {
  const build = { imageDigests: [image], releaseLockDigest: image };
  assert.equal(verifyDeployment(envelope(), build, { imageDigests: [image], lockDigest: image, authorityFresh: true, api: { passed: true }, ui: { passed: true } }).status, 'succeeded');
  assert.equal(verifyDeployment(envelope(), build, { imageDigests: [], lockDigest: image, authorityFresh: true, api: { passed: true }, ui: { passed: true } }).rollbackRequired, true);
  assert.equal(verifyDeployment(envelope(), build, { imageDigests: [image], lockDigest: image, authorityFresh: false, api: { passed: false }, ui: { passed: false } }).status, 'inconclusive');
  assert.equal(verifyDeployment(envelope(), build, { imageDigests: [image], lockDigest: patch, authorityFresh: true, api: { passed: true }, ui: { passed: true } }).status, 'failed');
});

function executionRequest(overrides = {}) {
  return {
    ...envelope(), stage: 'approved', actorId: 'actor-1', authSessionId: 'session-1', authzRevision: 'rev-1',
    operationId: 'operation-1', ...overrides,
  };
}

function executionApprovals(request, scope, bindingDigest) {
  return [{ approvalScope: scope, bindingDigest, approverId: 'approver-1', assurance: 'aal2', revokedAt: null,
    expiresAt: request.approvalExpiresAt }];
}

function workerFixture(request, overrides = {}) {
  const stages = []; const builds = []; const verifications = []; let destroyed = 0;
  const buildEvidence = {
    buildAuthority: 'localhost', imageDigests: [image], sbomDigest: image,
    provenanceDigest: image, signatureDigest: image, releaseLockDigest: image,
  };
  const deps = {
    store: {
      heartbeat: async () => true,
      getApprovals: async () => executionApprovals(request, 'source_patch', request.approvalBindingDigest),
      block: async (_id, code) => stages.push({ stage: 'blocked', code }),
      stage: async (_id, stage, evidence) => stages.push({ stage, evidence }),
      recordBuildEvidence: async (_id, evidence) => builds.push(evidence),
      recordDeploymentVerification: async (_id, evidence) => verifications.push(evidence),
    },
    sessions: { resolve: async () => ({ active: true, actorId: request.actorId, authzRevision: request.authzRevision,
      assurance: 'aal2', permissions: ['r2d2.engineering.execute'], accessToken: 'must-not-persist' }) },
    sources: {
      currentRevision: async () => request.baseRevision,
      applyPatch: async () => ({ changedFiles: request.allowedPaths.map((prefix) => `${prefix}server.js`), patchDigest: request.patchDigest }),
      commit: async () => ({ sourceRevision: sha }),
    },
    sandbox: { create: async (spec) => ({ id: 'sandbox-1', spec }), destroy: async () => { destroyed += 1; } },
    tests: { run: async (_workspace, id) => ({ status: 'passed', evidenceDigest: digestFor(id) }) },
    builder: { build: async () => buildEvidence },
    deployer: {
      deploy: async () => ({ operationId: 'deploy-1' }),
      rollback: async () => ({ operationId: 'rollback-1' }),
    },
    verifier: {
      observe: async () => ({ imageDigests: [image], lockDigest: image, authorityFresh: true, api: { passed: true }, ui: { passed: true } }),
      verifyRollback: async () => ({ verified: true }),
    },
    ...overrides,
  };
  return { worker: new EngineeringRemediationWorker(deps), deps, stages, builds, verifications, destroyed: () => destroyed };
}

function digestFor(value) {
  return `sha256:${require('crypto').createHash('sha256').update(String(value)).digest('hex')}`;
}

test('source remediation runs only an approved exact patch in an ephemeral credential-free sandbox', async () => {
  const request = executionRequest();
  const fixture = workerFixture(request);
  const out = await fixture.worker.build(request, { patchDigest: request.patchDigest, artifactRef: 'db:patch-1' });
  assert.equal(out.status, 'awaiting_deploy_approval');
  assert.deepEqual(fixture.stages.map((item) => item.stage), [
    'sandboxed', 'patched', 'testing', 'ready_to_commit', 'committed', 'building', 'built', 'awaiting_deploy_approval',
  ]);
  assert.equal(fixture.builds.length, 1);
  assert.equal(fixture.destroyed(), 1);
  assert.equal(JSON.stringify({ stages: fixture.stages, builds: fixture.builds }).includes('must-not-persist'), false);
  assert.equal(out.deploymentBindingDigest, deploymentApprovalBinding(request, out.build));
  assert.equal(exactEngineeringConfirmation('source_patch', request),
    `approve R2D2 source patch ${request.remediationRequestId} ${request.approvalBindingDigest}`);
});

test('test and build exceptions advance to their exact failure stage', async () => {
  const testRequest = executionRequest();
  const testFixture = workerFixture(testRequest);
  testFixture.deps.tests.run = async () => { throw Object.assign(new Error('test runner failed'), { code: 'TestRunnerFailed' }); };
  await assert.rejects(() => testFixture.worker.build(testRequest, { patchDigest: testRequest.patchDigest }), /test runner failed/);
  assert.equal(testFixture.stages.at(-1).stage, 'test_failed');
  assert.equal(testFixture.stages.at(-1).evidence.code, 'TestRunnerFailed');
  assert.equal(testFixture.destroyed(), 1);

  const buildRequest = executionRequest();
  const buildFixture = workerFixture(buildRequest);
  buildFixture.deps.builder.build = async () => { throw Object.assign(new Error('builder failed'), { code: 'BuilderFailed' }); };
  await assert.rejects(() => buildFixture.worker.build(buildRequest, { patchDigest: buildRequest.patchDigest }), /builder failed/);
  assert.equal(buildFixture.stages.at(-1).stage, 'build_failed');
  assert.equal(buildFixture.stages.at(-1).evidence.code, 'BuilderFailed');
  assert.equal(buildFixture.destroyed(), 1);
});

test('a worker that loses its fenced claim performs no source or state mutation', async () => {
  const request = executionRequest(); let sourceReads = 0;
  const fixture = workerFixture(request);
  fixture.deps.store.heartbeat = async () => false;
  fixture.deps.sources.currentRevision = async () => { sourceReads += 1; return request.baseRevision; };
  await assert.rejects(
    () => fixture.worker.build(request, { patchDigest: request.patchDigest }),
    (error) => error?.code === 'ClaimLeaseLost',
  );
  assert.equal(sourceReads, 0);
  assert.deepEqual(fixture.stages, []);
  assert.equal(fixture.destroyed(), 0);
});

test('stale approval or source revision blocks before patch application', async () => {
  const request = executionRequest(); let patches = 0;
  const fixture = workerFixture(request, {
    sources: {
      currentRevision: async () => 'f'.repeat(40),
      applyPatch: async () => { patches += 1; }, commit: async () => ({ sourceRevision: sha }),
    },
  });
  const out = await fixture.worker.build(request, { patchDigest: request.patchDigest });
  assert.equal(out.code, 'BaseRevisionChanged');
  assert.equal(patches, 0);
  assert.equal(fixture.destroyed(), 0);
  assert.equal(approvalsSatisfied(request, [], 'source_patch', request.approvalBindingDigest).allowed, false);
});

test('deployment approval is separately bound to built digests and failed postcondition rolls back exact inputs', async () => {
  const request = executionRequest({ stage: 'deploying' });
  const build = {
    sourceRevision: sha, patchDigest: request.patchDigest, buildAuthority: 'localhost', imageDigests: [image],
    sbomDigest: image, provenanceDigest: image, signatureDigest: image, releaseLockDigest: image,
    tests: request.requiredTests.map((id) => ({ id, status: 'passed' })),
  };
  const binding = deploymentApprovalBinding(request, build); let rollbackInput;
  const fixture = workerFixture(request, {
    store: {
      heartbeat: async () => true,
      getApprovals: async () => executionApprovals(request, 'deployment', binding),
      block: async (_id, code) => fixture.stages.push({ stage: 'blocked', code }),
      stage: async (_id, stage, evidence) => fixture.stages.push({ stage, evidence }),
      recordBuildEvidence: async () => {},
      recordDeploymentVerification: async (_id, evidence) => fixture.verifications.push(evidence),
    },
    deployer: {
      deploy: async () => ({ operationId: 'deploy-1' }),
      rollback: async (input) => { rollbackInput = input; return { operationId: 'rollback-1' }; },
    },
    verifier: {
      observe: async () => ({ imageDigests: [], authorityFresh: true, api: { passed: false }, ui: { passed: false } }),
      verifyRollback: async () => ({ verified: true }),
    },
  });
  const out = await fixture.worker.deploy(request, build);
  assert.equal(out.status, 'rolled_back');
  assert.equal(out.rollbackVerified, true);
  assert.equal(rollbackInput.rollbackRevision, request.rollbackRevision);
  assert.deepEqual(rollbackInput.rollbackImageDigests, request.rollbackImageDigests);
  assert.deepEqual(fixture.stages.map((item) => item.stage), ['verifying', 'rolling_back', 'rolled_back']);
});
