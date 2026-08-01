const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { condition, deploymentRolloutConverged, deploymentReadyResult, normalizeHisStatus, foundationDevOverrideEnabled, verifiedActivatedRegistration, verifiedStagedUpdate, admissionRedTestDenied, platformVerificationProjection, platformVerificationComparable, platformSupportAdmission, argocdApplicationEvidence } = require('./controller');

const root = path.resolve(__dirname, '../..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('live condition never infers Ready from a label alone', () => {
  const failed = condition('Observability', false, 'TelemetryEvidenceMissing', 'missing', []);
  assert.equal(failed.status, 'False');
  assert.equal(failed.ready, false);
});

test('deployment readiness requires a fully observed rollout, not ready replicas from the old revision', () => {
  const converged = {
    metadata: { generation: 3 },
    spec: { replicas: 2 },
    status: { observedGeneration: 3, replicas: 2, updatedReplicas: 2, availableReplicas: 2, readyReplicas: 2 },
  };
  assert.equal(deploymentRolloutConverged(converged), true);
  assert.equal(deploymentRolloutConverged({ ...converged, status: { ...converged.status, observedGeneration: 2 } }), false);
  assert.equal(deploymentRolloutConverged({ ...converged, status: { ...converged.status, updatedReplicas: 1 } }), false);
  assert.equal(deploymentRolloutConverged({ ...converged, status: { ...converged.status, replicas: 3 } }), false);
  assert.equal(deploymentReadyResult('n', 'x', { ok: true, json: converged }).ready, true);
});

test('HIS status is fail-closed on an unavailable or degraded Cluster Manager response', () => {
  assert.equal(normalizeHisStatus({ ok: false, status: 502, body: null }).ready, false);
  assert.equal(normalizeHisStatus({ ok: true, status: 200, body: { state: 'Degraded' } }).ready, false);
  assert.equal(normalizeHisStatus({ ok: true, status: 200, body: { state: 'Ready' } }).ready, true);
});

test('Foundation management shell stays accessible while PFS services remain evidence-gated', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const page = read('src', 'app', 'pages', 'admin-platform-readiness.ts');
  const extensions = read('src', 'app', 'pages', 'admin-plugins.ts');
  const client = read('src', 'app', 'core', 'plugin-control-client.service.ts');
  assert.match(controller, /PlatformSupportProfileRequired/);
  assert.match(controller, /id === FOUNDATION_ID && action === 'enable'/);
  assert.match(controller, /PlatformSupportProfileRequiredForPfsPlugin/);
  assert.match(controller, /const foundationActivationAllowed = true/);
  const foundationEnableStart = controller.indexOf("if (id === FOUNDATION_ID && action === 'enable')");
  const foundationEnableEnd = controller.indexOf('// Activation is the gate for PFS plugins', foundationEnableStart);
  const foundationEnable = controller.slice(foundationEnableStart, foundationEnableEnd);
  assert.match(foundationEnable, /foundation-shell-management-activation/);
  assert.doesNotMatch(foundationEnable, /return json\(res, 409/);
  assert.match(controller, /const pfs = await foundationEstablishmentStatus\(supportReady, foundationReg\)/);
  assert.match(controller, /const domainAdmissionReady = pfs\.established && supportReady/);
  assert.doesNotMatch(controller, /const pfsEstablished = foundationReg\?\.status\?\.phase === 'Activated'/);
  assert.match(page, /PFS ADMISSION/);
  assert.match(page, /관리 화면은 항상 접근할 수 있습니다/);
  assert.match(page, /\/p\/cluster-manager\/his\/his/);
  // Hosted PFS plugins remain bound to a visible lock, while the Foundation
  // management shell itself must never disappear behind that service gate.
  assert.ok((extensions.match(/\[disabled\]="activationLocked\(/g) || []).length >= 5);
  assert.equal(
    (extensions.match(/\[disabled\]="activationLocked\(/g) || []).length,
    (extensions.match(/\[title\]="activationLockReason\(/g) || []).length,
    'every disabled activation control must explain itself',
  );
  assert.match(extensions, /Ready · 활성화 대기/);
  assert.match(extensions, /foundationActivationLocked[\s\S]*?return false/);
  assert.match(extensions, /activationLockReason\(id\)/);
  assert.match(extensions, /admission\.activationAllowed !== false/);
  assert.match(client, /body\.message \|\| body\.error/);
  assert.match(client, /HTTP \$\{r\.status\}\$\{detail/);
});

test('a PFS plugin stages unconditionally and only its activation waits for the Support Profile', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');

  // The admission contract carries the split explicitly, so a client can tell
  // "may I install?" from "may I turn it on?" instead of inferring it.
  assert.match(controller, /pfsPluginStageAllowed:\s*true/);
  assert.match(controller, /pfsPluginActivationAllowed:\s*supportReady/);

  // Installation must not consult the gate. CONSTITUTION-0003 §7.3 forbids
  // disabling a whole consumer because a collector is missing, and §7.2 holds an
  // unmet activation dependency as DependencyPending rather than refusing it.
  const installStart = controller.indexOf("if (p === '/api/admin/extensions/install'");
  assert.ok(installStart > 0, 'install handler was not located');
  const installEnd = controller.indexOf('\n    if (p === ', installStart + 1);
  const install = controller.slice(installStart, installEnd > 0 ? installEnd : undefined);
  assert.doesNotMatch(install, /return json\(res, 409/, 'installation must not refuse a PFS plugin');
  assert.match(install, /pfs-plugin-stage/, 'staging a gated plugin must leave durable audit evidence');
  assert.match(install, /pendingCapabilities/, 'the install response must name what is still missing');

  // The gate moves to activation, in the reconcile loop and on the enable path.
  assert.match(controller, /\['enable', 'rollback'\]\.includes\(action\)/);
  assert.match(controller, /reason: 'PlatformSupportProfileIncomplete'/);
  assert.match(controller, /phase: 'DependencyPending',\s*\n\s*reason: 'PlatformSupportProfileIncomplete'/);
});

test('recovery drill evidence is advisory for service activation but remains visible', () => {
  const admission = platformSupportAdmission(true, true, [
    { type: 'Delivery', ready: true },
    { type: 'Observability', ready: true },
    { type: 'BackupRestore', ready: false, reason: 'RestoreEvidenceMissing' },
    { type: 'SecurityPolicy', ready: true },
  ]);
  assert.equal(admission.ready, true);
  assert.equal(admission.advisoryReady, false);
  assert.deepEqual(admission.advisory.map((item) => item.type), ['BackupRestore']);
  const controller = read('backend', 'dupa-control', 'controller.js');
  assert.match(controller, /backupRestore:\s*\{ required: false \}/);
  assert.match(controller, /advisoryCapabilities:/);
});

test('delivery evidence binds the exact governed Git source and resolved revision', () => {
  const ready = argocdApplicationEvidence({
    spec: {
      project: 'opensphere-platform-delivery',
      source: {
        repoURL: 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000/opensphere/platform-declarations.git',
        path: 'platform-delivery/verification',
        targetRevision: 'main',
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'opensphere-platform-delivery' },
      syncPolicy: { automated: { prune: true, selfHeal: true } },
    },
    status: { sync: { status: 'Synced', revision: 'a'.repeat(40) }, health: { status: 'Healthy' } },
  });
  assert.equal(ready.ready, true);
  assert.equal(argocdApplicationEvidence({ ...ready, spec: { source: { path: 'wrong' } } }).ready, false);
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
  assert.equal(platformVerificationComparable(null), platformVerificationComparable({}));
  assert.equal(platformVerificationComparable(prior), platformVerificationComparable(projected));
  const controller = read('backend', 'dupa-control', 'controller.js');
  assert.match(controller, /reconcilePlatformVerification\(\)/);
  assert.match(controller, /Promise\.all\(\[reconcile\(\), pollK8sEvents\(\), reconcilePlatformVerification\(\)\]\)/);
});

test('PlatformSupportProfile approval persists an actor label, not the authenticated actor object', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  assert.match(controller, /approval:\s*\{\s*requestedBy:\s*auditActorLabel\(actor\),\s*reason,/);
  assert.doesNotMatch(controller, /approval:\s*\{\s*requestedBy:\s*actor,\s*reason,/);
});

test('Delivery evidence reader is namespace-scoped and read-only', () => {
  const manifest = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  assert.match(manifest, /name: dupa-platform-delivery-evidence-reader\s+namespace: argocd/);
  assert.match(manifest, /resources: \[applications, appprojects\]/);
  assert.match(manifest, /resourceNames: \[opensphere-platform-delivery-verify, opensphere-platform-delivery\]\s+verbs: \[get\]/);
  const roleStart = manifest.indexOf('name: dupa-platform-delivery-evidence-reader');
  const roleEnd = manifest.indexOf('\n---', roleStart);
  const role = manifest.slice(roleStart, roleEnd);
  assert.doesNotMatch(role, /verbs: \[[^\]]*(?:create|update|patch|delete)/);
});

test('cluster infrastructure profile manifest matches the controller least-privilege contract', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const manifest = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  const controllerStart = controller.indexOf('function infrastructureManagerClusterRoleManifest()');
  const controllerEnd = controller.indexOf('// AI domain subShell profile', controllerStart);
  const controllerProfile = controller.slice(controllerStart, controllerEnd);
  const manifestStart = manifest.indexOf('name: opensphere-module-cluster-infrastructure-manager-v1');
  const manifestEnd = manifest.indexOf('\n---', manifestStart);
  const manifestProfile = manifest.slice(manifestStart, manifestEnd);
  for (const profile of [controllerProfile, manifestProfile]) {
    const normalized = profile.replace(/["']/g, '');
    assert.match(normalized, /resources: \[volumesnapshots\][^\n]*verbs: \[get, list, watch, create, update, patch\]/);
    assert.match(normalized, /apiGroups: \[ceph\.rook\.io, csi\.ceph\.io\][^\n]*verbs: \[get, list, watch, create, update, patch\]/);
    assert.doesNotMatch(normalized, /resources: \[volumesnapshots\][^\n]*delete/);
    assert.doesNotMatch(normalized, /apiGroups: \[ceph\.rook\.io, csi\.ceph\.io\][^\n]*delete/);
  }
});
