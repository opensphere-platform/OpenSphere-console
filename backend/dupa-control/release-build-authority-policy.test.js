const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const policyPath = path.join(
  __dirname,
  '..',
  'release',
  'policies',
  'build-authority-policy.json',
);
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

test('GA accepts only GitHub Actions builds with complete supply-chain evidence', () => {
  const ga = policy.spec.releaseClasses.ga;

  assert.deepEqual(ga.tags, ['ga']);
  assert.deepEqual(ga.allowedBuildAuthorities, ['github-actions']);
  assert.equal(ga.officialDistribution, true);
  assert.equal(ga.localBuildAllowed, false);
  assert.deepEqual(ga.requiredEvidence, [
    'immutable-digest',
    'slsa-provenance',
    'spdx-sbom',
    'release-bom-attestation',
  ]);
  assert.equal(ga.promotion.retagPreGaArtifact, false);
  assert.equal(ga.promotion.rebuildFromSourceInGaWorkflow, true);
});

test('pre-GA accepts local builds without making them GA eligible', () => {
  const preGa = policy.spec.releaseClasses.preGa;

  assert.deepEqual(preGa.tags, ['edge', 'candidate', 'stable']);
  assert.deepEqual(preGa.allowedBuildAuthorities, ['localhost', 'github-actions']);
  assert.equal(preGa.officialDistribution, false);
  assert.equal(preGa.localBuildAllowed, true);
  assert.equal(preGa.evidenceMode, 'advisory');
  assert.equal(preGa.promotionToGa.retagArtifact, false);
  assert.equal(preGa.promotionToGa.sourceRevisionMayBeRebuilt, true);
});

test('policy covers subShells and records declaration-only enforcement', () => {
  assert.ok(policy.spec.scope.artifacts.includes('subshell-runtime-images'));
  assert.ok(policy.spec.scope.artifacts.includes('plugin-runtime-images'));
  assert.deepEqual(policy.spec.requiredArtifactAnnotations, [
    'opensphere.io/build-authority',
    'opensphere.io/release-class',
    'opensphere.io/ga-eligible',
  ]);
  assert.equal(policy.metadata.state, 'declared');
  assert.equal(policy.spec.enforcement.phase, 'declaration-only');
  assert.equal(policy.spec.enforcement.runtimeAdmissionUnchanged, true);
});
