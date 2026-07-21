const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { condition, deploymentReadyResult, normalizeHisStatus, foundationDevOverrideEnabled, verifiedActivatedRegistration, verifiedStagedUpdate } = require('./controller');

const root = path.resolve(__dirname, '../..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('live condition never infers Ready from a label alone', () => {
  const failed = condition('Observability', false, 'TelemetryEvidenceMissing', 'missing', []);
  assert.equal(failed.status, 'False');
  assert.equal(failed.ready, false);
});

test('deployment readiness requires every desired replica', () => {
  assert.equal(deploymentReadyResult('n', 'x', { ok: true, json: { spec: { replicas: 2 }, status: { readyReplicas: 1 } } }).ready, false);
  assert.equal(deploymentReadyResult('n', 'x', { ok: true, json: { spec: { replicas: 2 }, status: { readyReplicas: 2 } } }).ready, true);
});

test('HIS status is fail-closed on an unavailable or degraded Cluster Manager response', () => {
  assert.equal(normalizeHisStatus({ ok: false, status: 502, body: null }).ready, false);
  assert.equal(normalizeHisStatus({ ok: true, status: 200, body: { state: 'Degraded' } }).ready, false);
  assert.equal(normalizeHisStatus({ ok: true, status: 200, body: { state: 'Ready' } }).ready, true);
});

test('Foundation admission is enforced by API and exposed by Console page', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const page = read('src', 'app', 'pages', 'admin-platform-readiness.ts');
  assert.match(controller, /PlatformSupportProfileRequired/);
  assert.match(controller, /id === FOUNDATION_ID && action === 'enable'/);
  assert.match(controller, /PlatformSupportProfileRequiredForPfsPlugin/);
  assert.match(controller, /foundation-development-override/);
  assert.match(controller, /const domainAdmissionReady = pfsEstablished && supportReady/);
  assert.match(page, /PFS ADMISSION/);
  assert.match(page, /\/p\/cluster-manager\/his\/his/);
});

test('Foundation development override is explicit and production fail-closed', () => {
  assert.equal(foundationDevOverrideEnabled({}), false);
  assert.equal(foundationDevOverrideEnabled({ OPENSPHERE_RUNTIME_MODE: 'production', FOUNDATION_ACTIVATION_DEV_OVERRIDE: 'true' }), false);
  assert.equal(foundationDevOverrideEnabled({ OPENSPHERE_RUNTIME_MODE: 'development', FOUNDATION_ACTIVATION_DEV_OVERRIDE: 'false' }), false);
  assert.equal(foundationDevOverrideEnabled({ OPENSPHERE_RUNTIME_MODE: 'development', FOUNDATION_ACTIVATION_DEV_OVERRIDE: 'true' }), true);
  const manifest = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  assert.match(manifest, /OPENSPHERE_RUNTIME_MODE, value: production/);
  assert.match(manifest, /FOUNDATION_ACTIVATION_DEV_OVERRIDE, value: "false"/);
});

test('closed readiness gate permits only a verified update of an existing PFS plugin', () => {
  const verified = {
    workload: { phase: 'Ready' },
    verification: { manifest: 'Verified', signature: 'Verified', entryDigest: 'Verified', permissions: 'Approved' },
    currentDigest: `sha256:${'a'.repeat(64)}`,
  };
  assert.equal(verifiedActivatedRegistration({ spec: { desiredState: 'Enabled' }, status: { ...verified, phase: 'Activated' } }), true);
  assert.equal(verifiedActivatedRegistration({ spec: { desiredState: 'Installed' }, status: { ...verified, phase: 'Ready' } }), false);
  assert.equal(verifiedStagedUpdate({ spec: { desiredState: 'Installed' }, status: {
    ...verified, phase: 'Ready', previousDigest: `sha256:${'b'.repeat(64)}`,
  } }), true);
  assert.equal(verifiedStagedUpdate({ spec: { desiredState: 'Installed' }, status: {
    ...verified, phase: 'Ready', previousDigest: verified.currentDigest,
  } }), false);
  assert.equal(verifiedStagedUpdate({ spec: { desiredState: 'Installed' }, status: { ...verified, phase: 'Ready' } }), false);
});

test('bootstrap owns the PlatformSupportProfile CRD lifecycle', () => {
  const crd = read('backend', 'dupa-control', 'platform-support-profile-crd.yaml');
  const setup = fs.readFileSync(path.resolve(root, '..', 'OpenSphere-Setup-CLI', 'src', 'bootstrap.mjs'), 'utf8');
  assert.match(crd, /kind: PlatformSupportProfile/);
  assert.match(crd, /subresources:\s*\n\s*status:/);
  assert.match(setup, /platformsupportprofiles\.platform\.opensphere\.io/);
  assert.match(setup, /platform-support-profile-crd\.yaml/);
});
