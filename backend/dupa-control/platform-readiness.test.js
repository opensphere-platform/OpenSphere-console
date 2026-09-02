const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { condition, deploymentRolloutConverged, deploymentReadyResult, normalizeHisStatus, foundationDevOverrideEnabled, requiresDomainAdmission, crossplaneProviderProjection, verifiedActivatedRegistration, verifiedStagedUpdate, authorizationOperationId, foundationUpgradeAuthorization, verifiedFoundationStagedUpdate, verifiedFoundationUpdateAuthorization, admissionRedTestDenied, platformVerificationProjection, platformVerificationComparable, platformSupportAdmission, argocdApplicationEvidence, persistEventBeforeSeen, settledProbeProjection, platformLifecycleGateProjection, platformLifecycleGateCachedProjection } = require('./controller');

const root = path.resolve(__dirname, '../..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('live condition never infers Ready from a label alone', () => {
  const failed = condition('Observability', false, 'TelemetryEvidenceMissing', 'missing', []);
  assert.equal(failed.status, 'False');
  assert.equal(failed.ready, false);
});

test('platform readiness maps asynchronous results by probe name, never by semantic index', () => {
  const definitions = [
    { name: 'profile', fallback: { declared: false } },
    { name: 'delivery', fallback: { ready: false, reason: 'delivery failed' } },
    { name: 'observability', fallback: { ready: false, reason: 'observability failed' } },
  ];
  const result = settledProbeProjection(definitions, [
    { status: 'fulfilled', value: { declared: true } },
    { status: 'rejected', reason: new Error('repository unavailable') },
    { status: 'fulfilled', value: { ready: true, capabilities: ['metrics'] } },
  ]);
  assert.deepEqual(result.values.profile, { declared: true });
  assert.deepEqual(result.values.delivery, { ready: false, reason: 'delivery failed' });
  assert.deepEqual(result.values.observability, { ready: true, capabilities: ['metrics'] });
  assert.deepEqual(result.failures, [{ probe: 'delivery', reason: 'repository unavailable' }]);
  assert.throws(() => settledProbeProjection(definitions, []), /cardinality mismatch/);
});

test('OSAA consumes a narrow lifecycle gate instead of rebuilding full platform readiness', () => {
  const ready = platformLifecycleGateProjection(
    { ready: true, phase: 'Activated', workload: 'Ready' },
    { ready: true, state: 'Ready', checkedAt: '2026-08-22T00:00:00.000Z' },
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, null);
  const blocked = platformLifecycleGateProjection(
    { ready: true, phase: 'Activated', workload: 'Ready' },
    { ready: false, state: 'Degraded', reason: 'HISS core incomplete' },
  );
  assert.equal(blocked.ready, false);
  assert.equal(blocked.reason, 'his_preflight_not_ready');
  const controller = read('backend', 'dupa-control', 'controller.js');
  const gateway = read('apps', 'osaa-gateway', 'server.js');
  assert.match(controller, /\/api\/admin\/platform-readiness\/lifecycle/);
  assert.match(gateway, /DUPA_CONTROL_URL\}\/api\/admin\/platform-readiness\/lifecycle/);
  const observedAt = Date.parse('2026-08-22T00:00:00.000Z');
  const fresh = platformLifecycleGateCachedProjection(ready, observedAt, observedAt + 15_000, 60_000);
  assert.equal(fresh.ready, true);
  assert.equal(fresh.source, 'controller-observation');
  assert.equal(fresh.ageMs, 15_000);
  const stale = platformLifecycleGateCachedProjection(ready, observedAt, observedAt + 60_001, 60_000);
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, 'lifecycle_projection_stale');
  assert.equal(platformLifecycleGateCachedProjection(null, 0, observedAt, 60_000).reason, 'lifecycle_projection_warming');
  assert.doesNotMatch(controller, /async function platformLifecycleGateStatus\(\) \{[\s\S]*?hisPreflightEvidence\(\)/);
});

test('Kubernetes warning evidence is never marked seen before durable audit persistence', async () => {
  const seen = new Set();
  const pending = new Map();
  const order = [];
  const event = { opId: 'warning-1', action: 'FailedScheduling' };
  let attempts = 0;
  const persist = async (candidate) => {
    attempts += 1;
    assert.equal(candidate, event);
    if (attempts === 1) throw new Error('audit authority unavailable');
  };

  const failed = await persistEventBeforeSeen({
    uid: 'event-uid-1', event, seen, pending, order, persist,
  });
  assert.equal(failed.persisted, false);
  assert.equal(seen.has('event-uid-1'), false);
  assert.equal(pending.get('event-uid-1'), event);

  const retried = await persistEventBeforeSeen({
    uid: 'event-uid-1', event: { different: true }, seen, pending, order, persist,
  });
  assert.equal(retried.persisted, true);
  assert.equal(seen.has('event-uid-1'), true);
  assert.equal(pending.has('event-uid-1'), false);
  assert.deepEqual(order, ['event-uid-1']);
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

test('HISS status is fail-closed on an unavailable or degraded Cluster Manager response', () => {
  const status = (state) => ({
    schema: 'hiss-status.opensphere.io/v1alpha1',
    stack: 'HISS',
    state,
    checkedAt: new Date().toISOString(),
    items: [],
    summary: { coreTotal: 8, coreReady: state === 'Ready' ? 8 : 7, selectedProfilesTotal: 1, selectedProfilesReady: 1 },
    projection: { authority: 'Cluster Manager HISS', realizationLayer: 'SRL-L1' },
  });
  assert.equal(normalizeHisStatus({ ok: false, status: 502, body: null }).ready, false);
  assert.equal(normalizeHisStatus({ ok: true, status: 200, body: status('Degraded') }).ready, false);
  const ready = normalizeHisStatus({ ok: true, status: 200, body: status('Ready') });
  assert.equal(ready.ready, true);
  assert.equal(ready.contract, 'opensphere.his.readiness-projection/v1');
  assert.deepEqual(ready.core, { ready: 8, total: 8 });
  assert.deepEqual(ready.selectedProfiles, { ready: 1, total: 1 });
  assert.equal(ready.authority, 'Cluster Manager HISS');
  assert.equal(ready.realizationLayer, 'SRL-L1');
  assert.equal(normalizeHisStatus({ ok: true, status: 200, body: { ...status('Ready'), checkedAt: '2020-01-01T00:00:00.000Z' } }).ready, false);
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
  assert.match(page, /\/p\/cluster-manager\/hiss\/hiss/);
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
  const pfsGateStart = install.indexOf('if (pkg.spec.hostRef === FOUNDATION_ID)');
  const pfsGateEnd = install.indexOf('} else if (requiresDomainAdmission(pkg))', pfsGateStart);
  assert.ok(pfsGateStart > 0 && pfsGateEnd > pfsGateStart, 'PFS staging gate was not located');
  assert.doesNotMatch(
    install.slice(pfsGateStart, pfsGateEnd),
    /return json\(/,
    'an incomplete Support Profile must not refuse PFS plugin installation',
  );
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

test('Foundation update evidence is exact-transition and expires without bypassing readiness', () => {
  const browserCorrelationId = '8e3844d6-d28e-4099-8099-123456789abc';
  assert.match(authorizationOperationId(browserCorrelationId), /^os-[a-f0-9]{32}$/);
  assert.equal(authorizationOperationId(browserCorrelationId), authorizationOperationId(browserCorrelationId));
  assert.equal(authorizationOperationId(`os-${'a'.repeat(24)}`), `os-${'a'.repeat(24)}`);
  const fromDigest = `sha256:${'a'.repeat(64)}`;
  const toDigest = `sha256:${'b'.repeat(64)}`;
  const fromManifestSha256 = 'c'.repeat(64);
  const toManifestSha256 = 'd'.repeat(64);
  const currentPkg = {
    metadata: { name: 'foundation' },
    spec: { image: { digest: fromDigest }, manifest: { sha256: fromManifestSha256 } },
  };
  const activeReg = {
    spec: { desiredState: 'Enabled' },
    status: {
      phase: 'Activated',
      workload: { phase: 'Ready' },
      verification: { manifest: 'Verified', signature: 'Verified', entryDigest: 'Verified', permissions: 'Approved' },
      currentDigest: fromDigest,
      currentManifestSha256: fromManifestSha256,
      currentVersion: '202607291100',
    },
  };
  const targetPkg = {
    metadata: { name: 'foundation' },
    spec: { image: { digest: toDigest }, manifest: { sha256: toManifestSha256 } },
  };
  const authorization = foundationUpgradeAuthorization(
    currentPkg, activeReg, targetPkg, { username: 'cmars' }, `os-${'e'.repeat(24)}`, '2026-07-29T02:00:00.000Z',
  );
  assert.ok(authorization);
  const staged = {
    spec: { desiredState: 'Installed' },
    status: {
      phase: 'Ready',
      workload: { phase: 'Ready' },
      verification: { manifest: 'Verified', signature: 'Verified', entryDigest: 'Verified', permissions: 'Approved' },
      currentDigest: toDigest,
      currentManifestSha256: toManifestSha256,
      previousDigest: fromDigest,
      previousManifestSha256: fromManifestSha256,
      foundationUpgradeAuthorization: authorization,
    },
  };
  assert.equal(verifiedFoundationStagedUpdate(staged, Date.parse('2026-07-29T02:10:00.000Z')), true);
  assert.equal(verifiedFoundationStagedUpdate({
    ...staged,
    status: { ...staged.status, foundationUpgradeAuthorization: { ...authorization, fromDigest: `sha256:${'f'.repeat(64)}` } },
  }, Date.parse('2026-07-29T02:10:00.000Z')), false);
  assert.equal(
    verifiedFoundationStagedUpdate(staged, Date.parse('2026-07-30T02:31:00.000Z')),
    false,
    'exact controller-owned update evidence must expire instead of becoming a permanent bypass token',
  );
  assert.equal(
    verifiedFoundationUpdateAuthorization(
      { ...staged, spec: { desiredState: 'Enabled' } },
      targetPkg,
      Date.parse('2026-07-30T02:31:00.000Z'),
    ),
    false,
    'expired authorization cannot be revived by the desiredState transition',
  );
  assert.equal(
    verifiedFoundationUpdateAuthorization(
      {
        ...staged,
        spec: { desiredState: 'Enabled' },
        status: {
          ...staged.status,
          phase: 'DependencyPending',
          workload: { phase: 'Pending' },
          verification: { manifest: 'Pending', signature: 'Pending', entryDigest: 'Pending', permissions: 'Pending' },
        },
      },
      targetPkg,
      Date.parse('2026-07-29T02:10:00.000Z'),
    ),
    true,
    'a transient projection may preserve fresh exact-transition evidence, but the admission gate still applies',
  );
  const pendingReconcile = {
    spec: { desiredState: 'Installed' },
    status: {
      ...activeReg.status,
      foundationUpgradeAuthorization: authorization,
    },
  };
  assert.equal(
    verifiedFoundationUpdateAuthorization(
      pendingReconcile, targetPkg, Date.parse('2026-07-29T02:10:00.000Z'),
    ),
    true,
    'enable may be queued before the reconciler has projected the target release as Ready',
  );
  assert.equal(
    verifiedFoundationUpdateAuthorization(
      { ...pendingReconcile, spec: { desiredState: 'Enabled' } }, targetPkg,
      Date.parse('2026-07-29T02:10:00.000Z'),
    ),
    true,
    'the reconciler revalidates the same authorization after desiredState becomes Enabled',
  );
  assert.equal(
    verifiedFoundationUpdateAuthorization(
      pendingReconcile,
      { ...targetPkg, spec: { ...targetPkg.spec, image: { digest: `sha256:${'f'.repeat(64)}` } } },
      Date.parse('2026-07-29T02:10:00.000Z'),
    ),
    false,
    'authorization cannot be reused for another target digest',
  );
  assert.equal(foundationUpgradeAuthorization(currentPkg, {
    ...activeReg, spec: { desiredState: 'Installed' }, status: { ...activeReg.status, phase: 'Ready' },
  }, targetPkg, { username: 'cmars' }, `os-${'e'.repeat(24)}`), null);

  const controller = read('backend', 'dupa-control', 'controller.js');
  const crd = read('backend', 'dupa-control', 'ui-plugin-crds.yaml');
  assert.match(controller, /setFoundationUpgradeAuthorization\(foundationAuthorization\)/);
  assert.doesNotMatch(controller, /foundationVerifiedUpdate/);
  assert.doesNotMatch(controller, /!activationAllowed && !currentReleaseAlreadyActivated && !foundationUpdate/);
  assert.match(controller, /consumed = await setFoundationUpgradeAuthorization\(null\)/);
  assert.doesNotMatch(controller, /foundation-verified-update-activate/);
  assert.match(controller, /FOUNDATION_UPGRADE_AUTHORIZATION_MAX_AGE_MS/);
  assert.match(crd, /foundationUpgradeAuthorization:/);
  assert.match(crd, /VerifiedActivatedFoundationUpdate\/v1/);
});

test('known L6 domain subShells are fail-closed behind live PFS admission', () => {
  for (const id of ['developer', 'workspace', 'customer', 'edge', 'website']) {
    assert.equal(requiresDomainAdmission({ metadata: { name: id }, spec: { kind: 'subShell', hostRef: 'main' } }), true);
  }
  assert.equal(requiresDomainAdmission({ metadata: { name: 'cluster-manager' }, spec: { kind: 'subShell', hostRef: 'main' } }), false);
  assert.equal(requiresDomainAdmission({ metadata: { name: 'developer' }, spec: { kind: 'plugin', hostRef: 'main' } }), false);

  const controller = read('backend', 'dupa-control', 'controller.js');
  assert.match(controller, /domainActivationAllowed:\s*domainAdmissionReady/);
  assert.match(controller, /else if \(requiresDomainAdmission\(pkg\)\)/);
  assert.match(controller, /else if \(targetPkg\.ok && requiresDomainAdmission\(targetPkg\.json\)\)/);
  assert.match(controller, /error: 'DomainAdmissionLocked'/);
  assert.match(controller, /phase: 'DependencyPending',\s*\n\s*reason: admission\.reason/);
});

test('recovery evidence has a bounded freshness gate', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  assert.match(controller, /RECOVERY_EVIDENCE_MAX_AGE_MS/);
  assert.match(controller, /value\.maxEvidenceAgeSeconds/);
  assert.match(controller, /const ready = evidenceFresh && archiveVerified && restored/);
  assert.match(controller, /expiresAt:/);
});

test('selected Crossplane adapter is part of live Delivery readiness', () => {
  const missing = { ok: false, status: 404, json: {} };
  assert.deepEqual(crossplaneProviderProjection({
    deployment: missing, provider: missing, providerConfig: missing,
  }), { selected: false, ready: true, state: 'NotSelected', reason: '' });

  const deployment = {
    ok: true, status: 200, json: {
      metadata: { generation: 2 },
      spec: { replicas: 1 },
      status: { observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 1, readyReplicas: 1 },
    },
  };
  const provider = { ok: true, status: 200, json: { status: { conditions: [
    { type: 'Healthy', status: 'True' }, { type: 'Installed', status: 'True' },
  ] } } };
  const providerConfig = { ok: true, status: 200, json: { spec: { credentials: { source: 'InjectedIdentity' } } } };
  assert.equal(crossplaneProviderProjection({ deployment, provider, providerConfig }).ready, true);
  assert.equal(crossplaneProviderProjection({
    deployment, provider: { ...provider, json: { status: { conditions: [{ type: 'Installed', status: 'True' }] } } }, providerConfig,
  }).ready, false);

  const controller = read('backend', 'dupa-control', 'controller.js');
  const manifest = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  assert.match(controller, /app\.ready && crossplane\.ready/);
  assert.match(manifest, /name: opensphere-crossplane-evidence-reader/);
  assert.match(manifest, /resourceNames: \[crossplane-contrib-provider-helm\]/);
  assert.match(manifest, /resourceNames: \[default\]/);
});

test('bootstrap owns the PlatformSupportProfile CRD lifecycle', () => {
  const crd = read('backend', 'dupa-control', 'platform-support-profile-crd.yaml');
  const setupContract = JSON.parse(read('packages', 'contracts', 'consumers', 'setup-cli-platform-support-profile.json'));
  assert.match(crd, /kind: PlatformSupportProfile/);
  assert.match(crd, /subresources:\s*\n\s*status:/);
  assert.equal(setupContract.consumer, 'OpenSphere-Setup-CLI');
  assert.equal(setupContract.resource.plural, 'platformsupportprofiles');
  assert.equal(setupContract.resource.apiGroup, 'platform.opensphere.io');
  assert.equal(setupContract.resource.statusSubresource, true);
  assert.deepEqual(setupContract.requiredAssets, ['platform-support-profile-crd.yaml']);
  assert.equal(setupContract.ownership.crdLifecycle, 'OpenSphere-Setup-CLI');
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
  assert.match(policy, /\[a-z0-9\._\/-\]\*/);
  assert.match(policy, /\(:\[A-Za-z0-9_\]/);
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

test('fresh install creates optional platform namespaces before their evidence RBAC', () => {
  const manifest = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  const documents = manifest.split(/^---\s*$/mu).map((document) => document.trim()).filter(Boolean);
  const namespaceDocumentIndex = (name) => documents.findIndex((document) => (
    /kind:\s*Namespace/.test(document)
      && new RegExp(`metadata:\\s*\\n(?:[ \\t].*\\n)*?[ \\t]+name:\\s*${name}(?:\\s|$)`).test(document)
  ));
  const namespacedRbacDocumentIndex = (name) => documents.findIndex((document) => (
    /kind:\s*(?:Role|RoleBinding)/.test(document)
      && new RegExp(`namespace:\\s*${name}(?:\\s|$)`).test(document)
  ));

  for (const namespace of ['argocd', 'crossplane-system']) {
    const namespaceIndex = namespaceDocumentIndex(namespace);
    const rbacIndex = namespacedRbacDocumentIndex(namespace);
    assert.notEqual(namespaceIndex, -1, `${namespace} Namespace must be part of the base manifest`);
    assert.notEqual(rbacIndex, -1, `${namespace} evidence RBAC must remain namespace-scoped`);
    assert.ok(namespaceIndex < rbacIndex, `${namespace} Namespace must precede its evidence RBAC`);
  }
});

test('Platform readiness consumes the named HISS preflight probe instead of rebranding Observability evidence', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  assert.match(controller, /hisPreflight:\s*his, observability/);
  assert.doesNotMatch(controller, /const his = \{\s*ready: observability\.stackReady/);
  assert.match(controller, /his\.core\.ready\}\/\$\{his\.core\.total/);
});
