'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPOSITORIES, assessRemediation, validateEnvelope, approvalStillValid, sandboxSpec,
  validatePatchFiles, validateBuildEvidence, verifyDeployment,
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

test('build evidence is bound to patch, authority, tests, SBOM, provenance, signature and exact digest', () => {
  const approved = envelope();
  const evidence = { sourceRevision: sha, patchDigest: patch, buildAuthority: 'localhost', imageDigests: [image], sbomDigest: image, provenanceDigest: image, signatureDigest: image,
    tests: ['unit','contract','security'].map((id) => ({ id, status: 'passed' })) };
  assert.equal(validateBuildEvidence(approved, evidence).valid, true);
  assert.throws(() => validateBuildEvidence(approved, { ...evidence, patchDigest: image }), /approved patch/);
  assert.throws(() => validateBuildEvidence(approved, { ...evidence, tests: [] }), /tests are incomplete/);
});

test('deployment succeeds only on exact digest and API/UI postconditions', () => {
  const build = { imageDigests: [image] };
  assert.equal(verifyDeployment(envelope(), build, { imageDigests: [image], authorityFresh: true, api: { passed: true }, ui: { passed: true } }).status, 'succeeded');
  assert.equal(verifyDeployment(envelope(), build, { imageDigests: [], authorityFresh: true, api: { passed: true }, ui: { passed: true } }).rollbackRequired, true);
  assert.equal(verifyDeployment(envelope(), build, { imageDigests: [image], authorityFresh: false, api: { passed: false }, ui: { passed: false } }).status, 'inconclusive');
});
