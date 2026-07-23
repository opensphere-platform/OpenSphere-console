const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { condition, deploymentReadyResult, normalizeHisStatus, foundationDevOverrideEnabled, verifiedActivatedRegistration, verifiedStagedUpdate, admissionRedTestDenied, platformVerificationProjection, platformVerificationComparable } = require('./controller');

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

test('SecurityPolicy readiness requires a real server dry-run denial from the canonical admission policy', () => {
  assert.equal(admissionRedTestDenied({ ok: false, status: 422, json: {
    message: 'ValidatingAdmissionPolicy denied request: opensphere-console must declare Manual UI contract console-help-center-v2',
  } }), true);
  assert.equal(admissionRedTestDenied({ ok: false, status: 422, json: { message: 'another policy denied the request' } }), false);
  assert.equal(admissionRedTestDenied({ ok: true, status: 200, json: {} }), false);

  const controller = read('backend', 'dupa-control', 'controller.js');
  const manifest = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  assert.match(controller, /dryRun=All&fieldManager=opensphere-security-red-test/);
  assert.match(controller, /mode: 'KubernetesServerDryRun'/);
  assert.match(controller, /evidenceDigest/);
  assert.match(controller, /opensphere-console-image-integrity-workload/);
  assert.match(controller, /opensphere-console-image-integrity-cronjob/);
  assert.match(controller, /Promise\.all\(SECURITY_ADMISSION_TESTS\.map/);
  assert.doesNotMatch(controller, /const redTest = false/);
  assert.match(manifest, /resources: \[validatingadmissionpolicies, validatingadmissionpolicybindings\]/);
  assert.match(manifest, /opensphere-console-manual-ui-contract/);
  assert.match(manifest, /opensphere-console-image-integrity-workload/);
  assert.match(manifest, /opensphere-console-image-integrity-cronjob/);
});

test('image admission policies deny mutable and off-registry workload references in every Console-managed namespace', () => {
  const policy = read('deploy', 'console-image-admission-policy.yaml');
  assert.match(policy, /kind: ValidatingAdmissionPolicy/);
  assert.match(policy, /failurePolicy: Fail/);
  assert.match(policy, /resources: \["deployments", "statefulsets", "daemonsets"\]/);
  assert.match(policy, /resources: \["cronjobs"\]/);
  assert.match(policy, /opensphere-console-data/);
  assert.match(policy, /ghcr\\\\\.io\/opensphere-platform/);
  assert.match(policy, /@sha256:\[a-f0-9\]\{64\}/);
  assert.match(policy, /validationActions: \[Deny\]/);
});

test('PlatformSupportProfile status is a controller-owned projection that changes only with evidence', () => {
  const prior = {
    phase: 'Degraded', observedGeneration: 1, lastVerifiedAt: '2026-07-23T00:00:00.000Z', verifiedBy: 'old',
    conditions: [{ type: 'SecurityPolicy', status: 'True', reason: 'Verified', message: 'verified', lastTransitionTime: '2026-07-22T00:00:00.000Z' }],
    evidenceRefs: [{ ref: 'live:securitypolicy:0', type: 'SecurityPolicy' }],
  };
  const state = {
    observedAt: '2026-07-23T01:00:00.000Z', phase: 'Degraded',
    profile: { declared: true, generation: 1, status: prior },
    capabilities: [{ type: 'SecurityPolicy', status: 'True', reason: 'Verified', message: 'verified', evidence: [{}] }],
  };
  const projected = platformVerificationProjection({ username: 'cmars' }, state);
  assert.equal(projected.verifiedBy, 'cmars');
  assert.equal(projected.conditions[0].lastTransitionTime, '2026-07-22T00:00:00.000Z');
  assert.equal(platformVerificationComparable(prior), platformVerificationComparable(projected));
  const controller = read('backend', 'dupa-control', 'controller.js');
  assert.match(controller, /reconcilePlatformVerification\(\)/);
  assert.match(controller, /Promise\.all\(\[reconcile\(\), pollK8sEvents\(\), reconcilePlatformVerification\(\)\]\)/);
});
