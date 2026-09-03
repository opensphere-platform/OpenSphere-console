import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionStaticContractSha256 } from '../src/extension-release.mjs';
import { createKubernetesExtensionManagementAuthority } from '../src/kubernetes-extension-management.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
const previousDigest = 'sha256:' + 'b'.repeat(64);
const manifest = 'c'.repeat(64);
const previousManifest = 'd'.repeat(64);

function pkg(overrides = {}) {
  return {
    apiVersion: 'plugins.opensphere.io/v1alpha1',
    kind: 'UIPluginPackage',
    metadata: {
      name: 'metrics', namespace: 'opensphere-console', uid: 'package-metrics-uid', resourceVersion: '10', generation: 2,
      labels: { 'opensphere.io/scope': 'workspace-extension' },
    },
    spec: {
      displayName: 'Metrics', owner: 'Platform', version: '1.2.3', description: 'Metrics UI',
      kind: 'subShell', hostRef: 'main', hostApiVersion: '1.0', hostCompat: '1.0.0',
      image: { repository: 'ghcr.io/opensphere-platform/metrics', digest },
      resolution: {
        requestedRef: 'edge', requestedChannel: 'edge', resolvedDigest: digest,
        resolvedAt: '2026-09-02T00:00:00.000Z', artifactVersion: '202609020001',
        compatibilityVersion: '1.2.3', buildAuthority: 'github-actions',
        source: 'https://github.com/opensphere-platform/metrics',
        revision: '1'.repeat(40), signatureIdentity: 'release-key',
        registryCredentialsRequired: true, evidenceRefs: ['manifest', 'signature'],
      },
      manifest: { path: '/plugins/ui-shell.manifest.json', sha256: manifest },
      trust: { keyId: 'release-key' }, shellCompat: '1.0.0',
      permissions: ['console.read'],
      nav: { band: 'Operate', label: 'Metrics', icon: 'chart-line', order: 2 },
      contributions: {
        page: { enabled: true }, navigation: { enabled: true, mode: 'runtime' },
        api: { enabled: false }, cli: { enabled: false }, manual: { enabled: false, mode: 'none' },
        search: { enabled: false, mode: 'none' }, notification: { enabled: false, frontend: false, backend: false },
        observability: { enabled: false, logs: false, metrics: false, traces: false },
      },
    },
    ...overrides,
  };
}
function registration(overrides = {}) {
  return {
    apiVersion: 'plugins.opensphere.io/v1alpha1',
    kind: 'UIPluginRegistration',
    metadata: { name: 'metrics', namespace: 'opensphere-console', uid: 'reg-1', resourceVersion: '11', generation: 3 },
    spec: {
      packageRef: { name: 'metrics' }, desiredState: 'Enabled',
      installation: { requestedAt: '2026-09-02T00:00:00.000Z', requestedBy: 'operator' },
      approval: { requestedBy: 'operator', reason: 'approved release' },
    },
    status: {
      phase: 'Activated', currentDigest: digest, currentManifestSha256: manifest,
      currentVersion: '1.2.3', currentArtifactVersion: '202609020001', currentCompatibilityVersion: '1.2.3',
      workload: { phase: 'Ready' }, verification: { manifest: 'Verified', signature: 'Verified' },
      serving: { phase: 'Current' }, revalidation: { phase: 'Passed' },
    },
    ...overrides,
  };
}
function binding(overrides = {}) {
  return {
    apiVersion: 'console.opensphere.io/v1alpha1',
    kind: 'CLIDownload',
    metadata: { name: 'workforce-cli', uid: 'binding-workforce-uid', resourceVersion: '4' },
    spec: {
      displayName: 'Workforce CLI', description: 'Signed download', enabled: true,
      links: [{ text: 'Windows', href: 'https://downloads.opensphere.dev/workforce.exe', os: 'windows', arch: 'amd64' }],
    },
    ...overrides,
  };
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function authority(fetchImpl) {
  return createKubernetesExtensionManagementAuthority({
    baseUrl: 'http://127.0.0.1:9443',
    token: 'target-kubernetes-token-0001',
    fetchImpl,
  });
}
function pathOf(url) { return new URL(url).pathname; }

test('management projections are bounded to canonical Package, Registration, preference, and Binding fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ path: pathOf(url), options });
    const path = pathOf(url);
    if (path.endsWith('/uipluginpackages')) return json({ items: [pkg()] });
    if (path.endsWith('/uipluginregistrations')) return json({ items: [registration()] });
    if (path.endsWith('/clidownloads')) return json({ items: [binding(), binding({ metadata: { name: 'os', uid: 'binding-os-uid', resourceVersion: '1' } })] });
    return json({}, 404);
  };
  const target = authority(fetchImpl);
  const preferences = new Map([['metrics', { navigation: { icon: 'dashboard', labelOverride: 'Live metrics', bandOverride: 'Build', order: 0 } }]]);
  const catalog = await target.catalog(preferences);
  assert.equal(catalog.length, 1);
  assert.deepEqual(catalog[0].nav, { band: 'Build', label: 'Metrics', icon: 'dashboard', order: 0, labelOverride: 'Live metrics', bandOverride: 'Build' });
  assert.equal(catalog[0].installedDigest, digest);
  assert.equal(Object.hasOwn(catalog[0], 'env'), false);
  const registrations = await target.registrations();
  assert.equal(registrations[0].health, 'Ready');
  assert.equal(registrations[0].status.phase, 'Activated');
  const bindings = await target.bindings();
  assert.deepEqual(bindings.map((item) => item.name), ['workforce-cli']);
  assert.ok(calls.every((call) => call.options.headers.authorization === 'Bearer target-kubernetes-token-0001'));
});

test('desired-state mutation is resourceVersion-bound and rejects shell-pinned removal before write', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = pathOf(url);
    calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (options.method === 'GET' && path.endsWith('/uipluginpackages/metrics')) return json(pkg());
    if (options.method === 'GET' && path.endsWith('/uipluginregistrations/metrics')) return json(registration());
    if (options.method === 'PATCH' && path.endsWith('/uipluginregistrations/metrics')) {
      return json(registration({
        metadata: { name: 'metrics', namespace: 'opensphere-console', uid: 'reg-1', resourceVersion: '12', generation: 4 },
        spec: { packageRef: { name: 'metrics' }, desiredState: 'Disabled', approval: { requestedBy: 'actor', reason: 'disable for maintenance' } },
      }));
    }
    return json({}, 404);
  };
  const receipt = await authority(fetchImpl).setDesiredState({
    id: 'metrics', desiredState: 'Disabled', actorRef: 'actor', reason: 'disable for maintenance',
  });
  assert.equal(receipt.registrationResourceVersionBefore, '11');
  assert.equal(receipt.registrationResourceVersion, '12');
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch.body.metadata, { resourceVersion: '11' });
  assert.equal(patch.body.spec.desiredState, 'Disabled');

  let writes = 0;
  const core = authority(async (url, options) => {
    if (options.method !== 'GET') writes += 1;
    if (pathOf(url).endsWith('/uipluginpackages/metrics')) {
      return json(pkg({ metadata: { name: 'metrics', namespace: 'opensphere-console', uid: 'package-metrics-uid', resourceVersion: '10', generation: 2, labels: { 'opensphere.io/scope': 'main-shell-core' } } }));
    }
    return json(registration());
  });
  await assert.rejects(core.setDesiredState({
    id: 'metrics', desiredState: 'Uninstalled', actorRef: 'actor', reason: 'remove obsolete module',
  }), { code: 'CoreExtensionImmutable', status: 409 });
  assert.equal(writes, 0);
});

test('rollback applies only a verified prior release and marks a second-write failure as present side effect', async () => {
  const prior = {
    ...registration().status,
    previousDigest,
    previousManifestSha256: previousManifest,
    previousVersion: '1.1.0',
    previousArtifactVersion: '202608310001',
    previousRepository: pkg().spec.image.repository,
    previousManifestPath: pkg().spec.manifest.path,
    previousSignaturePath: '/plugins/ui-shell.manifest.json.sig',
    previousStaticContractSha256: extensionStaticContractSha256(pkg()),
    previousCompatibilityVersion: '1.0.0',
    previousBuildAuthority: 'github-actions',
    previousRequestedRef: 'stable',
    previousRequestedChannel: 'stable',
    previousResolvedAt: '2026-08-31T00:00:00.000Z',
    previousSource: 'https://github.com/opensphere-platform/metrics',
    previousRevision: '2'.repeat(40),
    previousSignatureIdentity: 'release-key-old',
    previousEvidenceRefs: ['release:previous'],
    previousRegistryCredentialsRequired: true,
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = pathOf(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, body });
    if (options.method === 'GET' && path.endsWith('/uipluginpackages/metrics')) return json(pkg());
    if (options.method === 'GET' && path.endsWith('/uipluginregistrations/metrics')) return json(registration({ status: prior }));
    if (options.method === 'PATCH' && path.endsWith('/uipluginpackages/metrics')) {
      return json(pkg({
        metadata: { name: 'metrics', namespace: 'opensphere-console', uid: 'package-metrics-uid', resourceVersion: '13', generation: 3, labels: { 'opensphere.io/scope': 'workspace-extension' } },
        spec: { ...pkg().spec, ...body.spec, image: { ...pkg().spec.image, ...body.spec.image }, manifest: { ...pkg().spec.manifest, ...body.spec.manifest } },
      }));
    }
    if (options.method === 'PATCH' && path.endsWith('/uipluginregistrations/metrics')) {
      return json(registration({
        metadata: { name: 'metrics', namespace: 'opensphere-console', uid: 'reg-1', resourceVersion: '14', generation: 4 },
        spec: { packageRef: { name: 'metrics' }, desiredState: 'Enabled', approval: body.spec.approval },
        status: prior,
      }));
    }
    return json({}, 404);
  };
  const receipt = await authority(fetchImpl).rollback({ id: 'metrics', actorRef: 'actor', reason: 'restore verified release' });
  assert.equal(receipt.digest, previousDigest);
  assert.equal(receipt.packageResourceVersionBefore, '10');
  assert.equal(receipt.registrationResourceVersion, '14');
  const packagePatch = calls.find((call) => call.method === 'PATCH' && call.path.includes('uipluginpackages'));
  assert.equal(packagePatch.body.metadata.resourceVersion, '10');
  assert.equal(packagePatch.body.spec.version, prior.previousVersion);
  assert.equal(packagePatch.body.spec.resolution.resolvedDigest, previousDigest);
  assert.equal(packagePatch.body.spec.image.repository, prior.previousRepository);
  assert.equal(packagePatch.body.spec.manifest.path, prior.previousManifestPath);
  assert.equal(packagePatch.body.spec.manifest.signaturePath, prior.previousSignaturePath);
  assert.equal(packagePatch.body.spec.trust.keyId, prior.previousSignatureIdentity);
  assert.equal(packagePatch.body.spec.resolution.artifactVersion, prior.previousArtifactVersion);
  assert.equal(packagePatch.body.spec.resolution.compatibilityVersion, prior.previousCompatibilityVersion);
  assert.equal(packagePatch.body.spec.resolution.resolvedAt, prior.previousResolvedAt);
  assert.equal(packagePatch.body.spec.resolution.source, prior.previousSource);
  assert.equal(packagePatch.body.spec.resolution.revision, prior.previousRevision);
  assert.equal(packagePatch.body.spec.resolution.signatureIdentity, prior.previousSignatureIdentity);
  assert.deepEqual(packagePatch.body.spec.resolution.evidenceRefs, prior.previousEvidenceRefs);

  const missingBoolean = { ...prior };
  delete missingBoolean.previousRegistryCredentialsRequired;
  let missingBooleanWrites = 0;
  const incompleteTrust = authority(async (url, options) => {
    if (options.method !== 'GET') missingBooleanWrites += 1;
    return pathOf(url).endsWith('/uipluginpackages/metrics') ? json(pkg()) : json(registration({ status: missingBoolean }));
  });
  await assert.rejects(incompleteTrust.rollback({ id: 'metrics', actorRef: 'actor', reason: 'restore verified release' }),
    { code: 'PreviousReleaseUnavailable', status: 409 });
  assert.equal(missingBooleanWrites, 0);

  let staticDriftWrites = 0;
  const driftedPackage = pkg();
  driftedPackage.spec.permissions = ['console.admin'];
  const staticDrift = authority(async (url, options) => {
    if (options.method !== 'GET') staticDriftWrites += 1;
    return pathOf(url).endsWith('/uipluginpackages/metrics') ? json(driftedPackage) : json(registration({ status: prior }));
  });
  await assert.rejects(staticDrift.rollback({ id: 'metrics', actorRef: 'actor', reason: 'restore verified release' }),
    { code: 'PreviousReleaseUnavailable', status: 409 });
  assert.equal(staticDriftWrites, 0);

  const failed = authority(async (url, options) => {
    const path = pathOf(url);
    if (options.method === 'GET' && path.endsWith('/uipluginpackages/metrics')) return json(pkg());
    if (options.method === 'GET') return json(registration({ status: prior }));
    if (path.endsWith('/uipluginpackages/metrics')) {
      const body = JSON.parse(options.body);
      return json(pkg({
        metadata: { name: 'metrics', namespace: 'opensphere-console', uid: 'package-metrics-uid', resourceVersion: '13', generation: 3, labels: { 'opensphere.io/scope': 'workspace-extension' } },
        spec: { ...pkg().spec, ...body.spec, image: { ...pkg().spec.image, ...body.spec.image }, manifest: { ...pkg().spec.manifest, ...body.spec.manifest } },
      }));
    }
    return json({ error: 'conflict' }, 409);
  });
  await assert.rejects(failed.rollback({ id: 'metrics', actorRef: 'actor', reason: 'restore verified release' }),
    (error) => error.code === 'WriteConflict' && error.sideEffect === 'present');
});

test('rollback and Binding management fail closed for missing trust evidence and native or unsafe bindings', async () => {
  let writes = 0;
  const noPrevious = authority(async (url, options) => {
    if (options.method !== 'GET') writes += 1;
    return pathOf(url).includes('uipluginpackages') ? json(pkg()) : json(registration());
  });
  await assert.rejects(noPrevious.rollback({ id: 'metrics', actorRef: 'actor', reason: 'restore verified release' }),
    { code: 'PreviousReleaseUnavailable', status: 409 });
  assert.equal(writes, 0);
  await assert.rejects(noPrevious.setBindingEnabled({ name: 'os', enabled: false }), { code: 'ValidationFailed', status: 400 });

  const unsafe = authority(async () => json({ items: [binding({ spec: { ...binding().spec, links: [{ text: 'bad', href: 'javascript:alert(1)' }] } })] }));
  await assert.rejects(unsafe.bindings(), { code: 'AuthorityContractViolation' });
});

test('Binding mutation uses a compare-and-set resourceVersion and verifies the returned state', async () => {
  const calls = [];
  const target = authority(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method, path: pathOf(url), body });
    if (options.method === 'GET') return json(binding());
    return json(binding({ metadata: { name: 'workforce-cli', uid: 'binding-workforce-uid', resourceVersion: '5' }, spec: { ...binding().spec, enabled: false } }));
  });
  const receipt = await target.setBindingEnabled({ name: 'workforce-cli', enabled: false });
  assert.deepEqual(receipt, { name: 'workforce-cli', enabled: false, resourceVersionBefore: '4', resourceVersion: '5' });
  assert.deepEqual(calls[1].body.metadata, { resourceVersion: '4' });
});


test('management rejects duplicate identities, truncation, oversized preferences, and control characters', async () => {
  const duplicatePackage = pkg({
    metadata: { ...pkg().metadata, uid: 'duplicate-package-uid', resourceVersion: '12' },
  });
  const duplicate = authority(async (url) => pathOf(url).endsWith('/uipluginpackages')
    ? json({ items: [pkg(), duplicatePackage] }) : json({ items: [registration()] }));
  await assert.rejects(duplicate.catalog(), { code: 'AuthorityContractViolation' });

  const excessivePermissions = pkg({ spec: {
    ...pkg().spec,
    permissions: Array.from({ length: 257 }, (_, index) => `console.permission.${index}`),
  } });
  const excessive = authority(async (url) => pathOf(url).endsWith('/uipluginpackages')
    ? json({ items: [excessivePermissions] }) : json({ items: [registration()] }));
  await assert.rejects(excessive.catalog(), { code: 'AuthorityContractViolation' });

  const navigation = authority(async (url) => pathOf(url).endsWith('/uipluginpackages')
    ? json({ items: [pkg()] }) : json({ items: [registration()] }));
  await assert.rejects(navigation.catalog(new Map([['metrics', { navigation: { labelOverride: 'x'.repeat(5000) } }]])),
    { code: 'AuthorityContractViolation' });

  let calls = 0;
  const mutation = authority(async () => { calls += 1; return json({}); });
  await assert.rejects(mutation.setDesiredState({
    id: 'metrics', desiredState: 'Disabled', actorRef: 'actor\nadmin', reason: 'disable for maintenance',
  }), { code: 'ValidationFailed', status: 400 });
  await assert.rejects(mutation.rollback({
    id: 'metrics', actorRef: 'actor', reason: 'restore\nverified release',
  }), { code: 'ValidationFailed', status: 400 });
  assert.equal(calls, 0);
});

test('management mutations reject UID replacement evidence', async () => {
  const desired = authority(async (url, options) => {
    const path = pathOf(url);
    if (options.method === 'GET' && path.endsWith('/uipluginpackages/metrics')) return json(pkg());
    if (options.method === 'GET') return json(registration());
    return json(registration({
      metadata: { name: 'metrics', namespace: 'opensphere-console', uid: 'replacement-reg-uid', resourceVersion: '12', generation: 4 },
      spec: { packageRef: { name: 'metrics' }, desiredState: 'Disabled' },
    }));
  });
  await assert.rejects(desired.setDesiredState({
    id: 'metrics', desiredState: 'Disabled', actorRef: 'actor', reason: 'disable for maintenance',
  }), (error) => error.code === 'AuthorityContractViolation' && error.sideEffect === 'present');

  const bindingReplacement = authority(async (url, options) => options.method === 'GET' ? json(binding()) : json(binding({
    metadata: { name: 'workforce-cli', uid: 'replacement-binding-uid', resourceVersion: '5' },
    spec: { ...binding().spec, enabled: false },
  })));
  await assert.rejects(bindingReplacement.setBindingEnabled({ name: 'workforce-cli', enabled: false }),
    (error) => error.code === 'AuthorityContractViolation' && error.sideEffect === 'present');
});


test('management rejects missing, unknown, or malformed Package scope before mutation', async () => {
  for (const scope of [undefined, 'unknown-scope', 'workspace-extension\u0000']) {
    const calls = [];
    const labels = scope === undefined ? {} : { 'opensphere.io/scope': scope };
    const malformed = pkg({ metadata: { ...pkg().metadata, labels } });
    const target = authority(async (url, options) => {
      calls.push({ method: options.method, path: pathOf(url) });
      if (pathOf(url).endsWith('/uipluginpackages/metrics')) return json(malformed);
      if (pathOf(url).endsWith('/uipluginregistrations/metrics')) return json(registration());
      return json({}, 404);
    });
    await assert.rejects(target.setDesiredState({
      id: 'metrics', desiredState: 'Uninstalled', actorRef: 'actor', reason: 'remove obsolete module',
    }), { code: 'PackageScopeInvalid', status: 409, sideEffect: 'none' });
    assert.equal(calls.filter((call) => call.method !== 'GET').length, 0);
  }
});
