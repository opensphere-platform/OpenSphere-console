const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const policy = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  '..',
  'release',
  'policies',
  'build-authority-policy.json',
), 'utf8'));

test('edge accepts only Windows Docker Desktop localhost amd64 publication', () => {
  const edge = policy.spec.releaseClasses.edge;
  assert.deepEqual(edge.tags, ['edge']);
  assert.deepEqual(edge.allowedBuildAuthorities, ['localhost']);
  assert.equal(edge.requiredHost, 'windows-amd64-docker-desktop');
  assert.equal(edge.requiredPlatform, 'linux/amd64');
  assert.deepEqual(edge.requiredPublication, [
    'ghcr-immutable-digest',
    'kst-yyyyMMddHHmm-version',
    'edge-channel-tag',
  ]);
});

test('candidate and stable are GitHub-only pre-GA channels', () => {
  const preGa = policy.spec.releaseClasses.preGa;
  assert.deepEqual(preGa.tags, ['candidate', 'stable']);
  assert.deepEqual(preGa.allowedBuildAuthorities, ['github-actions']);
  assert.equal(preGa.localBuildAllowed, false);
  assert.equal(preGa.promotionToGa.retagArtifact, false);
  assert.equal(preGa.promotionToGa.sourceRevisionMayBeRebuilt, true);
});

test('GA accepts only GitHub Actions rebuilds with complete supply-chain evidence', () => {
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

test('official version and canonical channel uniqueness are fail-closed', () => {
  assert.equal(policy.metadata.state, 'edge-ga-authority-enforced');
  assert.equal(policy.spec.officialVersion.pattern, '^[0-9]{12}$');
  assert.equal(policy.spec.officialVersion.format, 'yyyyMMddHHmm');
  assert.equal(policy.spec.officialVersion.timezone, 'Asia/Seoul');
  assert.equal(policy.spec.officialVersion.displayField, 'artifactVersion');
  assert.equal(policy.spec.officialVersion.compatibilityField, 'compatibilityVersion');
  assert.ok(policy.spec.officialVersion.forbiddenOfficialExamples.includes('v0.2.2-edge.2'));
  assert.equal(policy.spec.enforcement.channelUniqueness.failClosed, true);
  assert.match(policy.spec.enforcement.channelUniqueness.mapping, /exactly-one canonical repository digest/);
});

test('policy records all admission metadata required by the controller', () => {
  assert.ok(policy.spec.scope.artifacts.includes('subshell-runtime-images'));
  assert.ok(policy.spec.scope.artifacts.includes('plugin-runtime-images'));
  assert.deepEqual(policy.spec.requiredArtifactAnnotations, [
    'opensphere.io/build-authority',
    'opensphere.io/release-class',
    'opensphere.io/ga-eligible',
    'io.opensphere.release-tag',
    'org.opencontainers.image.version',
  ]);
  assert.equal(policy.spec.enforcement.localEdge.channel, 'edge');
  assert.equal(policy.spec.enforcement.localEdge.requiredPlatform, 'linux/amd64');
  assert.equal(policy.spec.enforcement.localEdge.requiredBuildAuthority, 'localhost');
  assert.equal(policy.spec.enforcement.localEdge.gaEligible, false);
});
