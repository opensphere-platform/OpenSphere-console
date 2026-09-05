import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExtensionWorkloadPlan } from '../src/extension-release.mjs';
import {
  createKubernetesExtensionLifecycle,
  projectPreviousVerifiedRelease,
} from '../src/kubernetes-extension-lifecycle.mjs';
import { artifactFetch, json, makeReleaseFixture } from './extension-release-fixture.mjs';

const origin = 'https://kubernetes.test';
const namespace = 'opensphere-console';
const registrations = '/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginregistrations';
const packages = '/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginpackages';

function statusPatched(source, status) {
  return {
    ...structuredClone(source),
    metadata: { ...structuredClone(source.metadata), resourceVersion: `${source.metadata.resourceVersion}-status` },
    status: structuredClone(status),
  };
}

function registration(desiredState = 'Enabled') {
  return {
    apiVersion: 'plugins.opensphere.io/v1alpha1',
    kind: 'UIPluginRegistration',
    metadata: {
      name: 'workspace',
      namespace,
      uid: 'registration-uid',
      resourceVersion: '19',
      generation: 3,
    },
    spec: { packageRef: { name: 'workspace' }, desiredState },
  };
}

test('lifecycle is idle without an authoritative Registration', async () => {
  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer service-account-token-value');
      assert.equal(new URL(url).pathname, registrations);
      return json(200, { items: [] });
    },
  });
  assert.deepEqual(await lifecycle.reconcileOnce(), { state: 'Idle' });
});

for (const startState of ['ready', 'pending', 'failed-previous']) {
test('lifecycle independently verifies replacement after ' + startState, async () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const currentRegistration = {
    ...registration(),
    status: {
      currentDigest: 'sha256:' + 'c'.repeat(64),
      currentManifestSha256: 'd'.repeat(64),
      currentVersion: '1.1.0',
      currentArtifactVersion: '202608310001',
      currentRepository: fixture.pkg.spec.image.repository,
      currentManifestPath: fixture.pkg.spec.manifest.path,
      currentSignaturePath: fixture.pkg.spec.manifest.signaturePath,
      currentStaticContractSha256: plan.staticContractSha256,
      currentCompatibilityVersion: '1.0.0',
      currentBuildAuthority: 'localhost',
      currentRequestedRef: 'edge',
      currentRequestedChannel: 'edge',
      currentResolvedAt: '2026-09-01T00:00:00.000Z',
      currentSource: 'gitea',
      currentRevision: 'c'.repeat(40),
      currentSignatureIdentity: 'release-key',
      currentEvidenceRefs: ['release:previous'],
      currentRegistryCredentialsRequired: true,
      verification: {
        manifest: 'Verified',
        signature: 'Verified',
        entryDigest: 'Verified',
        permissions: 'Approved',
      },
      serving: {
        phase: 'Current',
        digest: 'sha256:' + 'c'.repeat(64),
        manifestSha256: 'd'.repeat(64),
      },
    },
  };
  if (startState === 'failed-previous') { currentRegistration.status.verification.manifest = 'Failed'; currentRegistration.status.serving.phase = 'Unavailable'; }
  let workloadReady = startState !== 'pending';
  const artifacts = artifactFetch(fixture);
  const resources = new Map();
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, path: parsed.pathname, method, body });
    if (parsed.origin !== origin) return artifacts(url, options);

    assert.equal(options.headers.authorization, 'Bearer service-account-token-value');
    if (method === 'GET' && parsed.pathname === registrations) {
      return json(200, { items: [currentRegistration] });
    }
    if (method === 'GET' && parsed.pathname === packages + '/workspace') return json(200, fixture.pkg);
    if (method === 'GET' && parsed.pathname.endsWith('/configmaps/opensphere-extension-trusted-keys')) {
      return json(200, { data: { 'trusted-keys.json': JSON.stringify({ trustedKeys: fixture.trustedKeys }) } });
    }
    if (method === 'PATCH' && parsed.pathname === registrations + '/workspace/status') {
      if (body.status.phase === 'Activated') {
        assert.equal(body.status.manifestUrl, `/api/plugins/${plan.revisionResourceName}${plan.contract.manifestPath}`);
        assert.equal(body.status.serving.revision, plan.revision);
      }
      Object.assign(currentRegistration, statusPatched(currentRegistration, {...currentRegistration.status,...body.status}));
      return json(200, currentRegistration);
    }

    if (method === 'GET' && plan.resources.some((item) => item.basePath === parsed.pathname)) {
      assert.equal(parsed.searchParams.get('labelSelector'), 'opensphere.io/extension-id=workspace');
      assert.equal(parsed.searchParams.get('limit'), '64');
      const {kind, apiVersion} = plan.resources.find((item) => item.basePath === parsed.pathname).manifest;
      return json(200, {
        apiVersion, kind: `${kind}List`,
        items: [...resources.entries()]
          .filter(([resourcePath, resource]) => resourcePath.startsWith(parsed.pathname + '/') && resource.kind === kind)
          // Real typed Kubernetes List responses omit item TypeMeta.
          .map(([, resource]) => { const value = structuredClone(resource); delete value.kind; delete value.apiVersion; return value; }),
      });
    }
    if (method === 'GET') {
      if (!resources.has(parsed.pathname)) return json(404, { reason: 'NotFound' });
      const value = structuredClone(resources.get(parsed.pathname));
      if (value.kind === 'Deployment') {
        value.metadata.generation = 1;
        value.status = {
          observedGeneration: 1,
          updatedReplicas: value.spec.replicas,
          availableReplicas: workloadReady ? value.spec.replicas : 0,
          unavailableReplicas: 0,
        };
      }
      return json(200, value);
    }
    if (method === 'POST') {
      const path = parsed.pathname + '/' + body.metadata.name;
      resources.set(path, {
        ...structuredClone(body),
        metadata: {
          ...structuredClone(body.metadata),
          uid: body.metadata.name + '-uid',
          resourceVersion: '1',
        },
      });
      return json(201, resources.get(path));
    }
    if (method === 'PATCH') {
      const existing = resources.get(parsed.pathname);
      assert.ok(existing, 'only an existing owned resource may be patched');
      resources.set(parsed.pathname, {
        ...structuredClone(existing),
        ...structuredClone(body),
        metadata: { ...structuredClone(existing.metadata), ...structuredClone(body.metadata) },
      });
      return json(200, resources.get(parsed.pathname));
    }
    throw new Error('unexpected Kubernetes request ' + method + ' ' + parsed.pathname);
  };

  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl,
  });
  if (!workloadReady) {
    assert.equal((await lifecycle.reconcileOnce()).state, 'Pending');
    assert.equal(currentRegistration.status.verification.manifest, 'Verified');
    assert.equal(currentRegistration.status.currentVersion, '1.1.0');
    assert.ok(!calls.some(c => c.url.startsWith('http://workspace-r-')));
    workloadReady = true;
  }
  const activationResourceVersion = currentRegistration.metadata.resourceVersion;
  const result = await lifecycle.reconcileOnce();
  assert.equal(result.state, 'Activated');
  assert.equal(result.extensionId, 'workspace');
  assert.equal(result.revision, plan.revision);

  const deploymentPath = plan.resources[1].basePath + '/' + plan.revisionResourceName;
  assert.equal(resources.get(deploymentPath).spec.template.spec.containers[0].image,
    fixture.pkg.spec.image.repository + '@' + fixture.pkg.spec.image.digest);
  const activePath = plan.activeService.basePath + '/workspace';
  assert.deepEqual(resources.get(activePath).spec.selector, plan.activeService.manifest.spec.selector);

  const artifactIndexes = calls
    .map((call, index) => call.url.startsWith('http://workspace-r-') ? index : -1)
    .filter((index) => index >= 0);
  const activeWriteIndex = calls.findIndex((call) => call.method === 'POST' && call.path === plan.activeService.basePath
    && call.body?.metadata?.name === 'workspace');
  assert.equal(artifactIndexes.length, 3);
  assert.ok(activeWriteIndex > Math.max(...artifactIndexes), 'stable Service cutover must follow all byte verification');

  const statusPatch = calls.find((call) => call.method === 'PATCH'
    && call.path === registrations + '/workspace/status' && call.body.status.phase === 'Activated');
  assert.equal(statusPatch.body.metadata.resourceVersion, activationResourceVersion);
  assert.equal(statusPatch.body.status.phase, 'Activated');
  if (startState === 'failed-previous') {
    assert.equal(statusPatch.body.status.previousDigest, undefined);
  } else assert.deepEqual({
    digest: statusPatch.body.status.previousDigest,
    manifestSha256: statusPatch.body.status.previousManifestSha256,
    version: statusPatch.body.status.previousVersion,
    artifactVersion: statusPatch.body.status.previousArtifactVersion,
    repository: statusPatch.body.status.previousRepository,
    manifestPath: statusPatch.body.status.previousManifestPath,
    signaturePath: statusPatch.body.status.previousSignaturePath,
    staticContractSha256: statusPatch.body.status.previousStaticContractSha256,
    revision: statusPatch.body.status.previousRevision,
    evidenceRefs: statusPatch.body.status.previousEvidenceRefs,
  }, {
    digest: 'sha256:' + 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    version: '1.1.0',
    artifactVersion: '202608310001',
    repository: fixture.pkg.spec.image.repository,
    manifestPath: fixture.pkg.spec.manifest.path,
    signaturePath: fixture.pkg.spec.manifest.signaturePath,
    staticContractSha256: plan.staticContractSha256,
    revision: 'c'.repeat(40),
    evidenceRefs: ['release:previous'],
  });
  assert.equal(statusPatch.body.status.currentArtifactVersion, fixture.pkg.spec.resolution.artifactVersion);
  assert.equal(statusPatch.body.status.currentRepository, fixture.pkg.spec.image.repository);
  assert.equal(statusPatch.body.status.currentManifestPath, fixture.pkg.spec.manifest.path);
  assert.equal(statusPatch.body.status.currentSignaturePath, fixture.pkg.spec.manifest.signaturePath);
  assert.equal(statusPatch.body.status.currentStaticContractSha256, plan.staticContractSha256);
  assert.equal(statusPatch.body.status.currentRequestedRef, 'edge');
  assert.equal(statusPatch.body.status.currentBuildAuthority, 'localhost');
  assert.equal(statusPatch.body.status.currentRegistryCredentialsRequired, true);
  assert.deepEqual(statusPatch.body.status.verification, {
    manifest: 'Verified',
    signature: 'Verified',
    entryDigest: 'Verified',
    permissions: 'Approved',
  });
});
}

test('an unowned resource collision is never patched or deleted', async () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const calls = [];
  const first = plan.resources[0];

  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: parsed.pathname, method, body });
      if (parsed.pathname === registrations && method === 'GET') return json(200, { items: [registration()] });
      if (parsed.pathname === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
      if (parsed.pathname === first.basePath + '/' + first.manifest.metadata.name && method === 'GET') {
        return json(200, {
          ...structuredClone(first.manifest),
          metadata: {
            ...structuredClone(first.manifest.metadata),
            uid: 'foreign-uid',
            resourceVersion: '7',
            labels: { 'app.kubernetes.io/managed-by': 'foreign-controller' },
            ownerReferences: [],
          },
        });
      }
      if (parsed.pathname === registrations + '/workspace/status' && method === 'PATCH') {
        return json(200, statusPatched(registration(), body.status));
      }
      throw new Error('unexpected call ' + method + ' ' + parsed.pathname);
    },
  });

  const result = await lifecycle.reconcileOnce();
  assert.equal(result.state, 'Failed');
  assert.equal(result.reason, 'ResourceOwnershipMismatch');
  assert.equal(calls.filter((call) => ['POST', 'DELETE'].includes(call.method)).length, 0);
  assert.equal(calls.filter((call) => call.method === 'PATCH'
    && call.path !== registrations + '/workspace/status').length, 0);
});

test('existing owned resource update is fenced by its current resourceVersion', async () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const first = plan.resources[0];
  const calls = [];

  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: parsed.pathname, method, body });
      if (parsed.pathname === registrations && method === 'GET') return json(200, { items: [registration()] });
      if (parsed.pathname === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
      if (parsed.pathname === first.basePath + '/' + first.manifest.metadata.name && method === 'GET') {
        return json(200, {
          ...structuredClone(first.manifest),
          metadata: {
            ...structuredClone(first.manifest.metadata),
            uid: 'service-account-uid',
            resourceVersion: '41',
          },
          automountServiceAccountToken: true,
        });
      }
      if (parsed.pathname === first.basePath + '/' + first.manifest.metadata.name && method === 'PATCH') {
        assert.equal(body.metadata.resourceVersion, '41');
        return json(200, {
          ...body,
          metadata: { ...body.metadata, uid: 'service-account-uid', resourceVersion: '42' },
        });
      }
      if (parsed.pathname === registrations + '/workspace/status' && method === 'PATCH') {
        return json(200, statusPatched(registration(), body.status));
      }
      if (method === 'GET') return json(404, { reason: 'NotFound' });
      if (method === 'POST') return json(201, body);
      throw new Error('stop after resourceVersion assertion');
    },
  });

  await lifecycle.reconcileOnce();
  assert.ok(calls.some((call) => call.method === 'PATCH'
    && call.path === first.basePath + '/' + first.manifest.metadata.name));
});

test('malformed Package fails before any workload authority call', async () => {
  const fixture = makeReleaseFixture();
  fixture.pkg.spec.image.digest = 'latest';
  const calls = [];
  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: parsed.pathname, method, body });
      if (parsed.pathname === registrations && method === 'GET') return json(200, { items: [registration()] });
      if (parsed.pathname === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
      if (parsed.pathname === registrations + '/workspace/status' && method === 'PATCH') {
        return json(200, statusPatched(registration(), body.status));
      }
      throw new Error('unexpected workload call');
    },
  });
  const result = await lifecycle.reconcileOnce();
  assert.equal(result.state, 'Failed');
  assert.equal(result.reason, 'PackageContractViolation');
  assert.deepEqual(calls.map((call) => call.path), [
    registrations,
    packages + '/workspace',
    registrations + '/workspace/status',
  ]);
});

test('bounded round-robin prevents one Registration from starving its peers', async () => {
  const listed = ['beta', 'alpha'].map((name, index) => ({
    ...registration(),
    metadata: {
      ...registration().metadata,
      name,
      uid: name + '-uid',
      resourceVersion: String(20 + index),
    },
    spec: { packageRef: { name }, desiredState: 'Enabled' },
  }));
  const packageReads = [];
  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const method = options.method || 'GET';
      if (parsed.pathname === registrations && method === 'GET') return json(200, { items: listed });
      if (parsed.pathname.startsWith(packages + '/') && method === 'GET') {
        packageReads.push(parsed.pathname.slice((packages + '/').length));
        return json(404, { reason: 'NotFound' });
      }
      if (parsed.pathname.startsWith(registrations + '/') && parsed.pathname.endsWith('/status') && method === 'PATCH') {
        const name = parsed.pathname.slice((registrations + '/').length, -'/status'.length);
        const source = listed.find((item) => item.metadata.name === name);
        return json(200, statusPatched(source, JSON.parse(options.body).status));
      }
      throw new Error('unexpected round-robin call ' + method + ' ' + parsed.pathname);
    },
  });
  assert.equal((await lifecycle.reconcileOnce()).state, 'Pending');
  assert.equal((await lifecycle.reconcileOnce()).state, 'Pending');
  assert.equal((await lifecycle.reconcileOnce()).state, 'Pending');
  assert.deepEqual(packageReads, ['alpha', 'beta', 'alpha']);

  const oversized = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async () => json(200, { items: Array.from({ length: 257 }, () => registration()) }),
  });
  await assert.rejects(oversized.reconcileOnce(), { code: 'AuthorityContractViolation' });
});

test('same release keeps prior rollback evidence and malformed current evidence cannot be promoted', () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const same = {
    status: {
      currentDigest: plan.contract.imageDigest,
      currentManifestSha256: plan.contract.manifestSha256,
      previousDigest: 'sha256:' + 'c'.repeat(64),
    },
  };
  assert.deepEqual(projectPreviousVerifiedRelease(same, plan), {});

  const malformed = {
    status: {
      currentDigest: 'sha256:' + 'c'.repeat(64),
      currentManifestSha256: 'd'.repeat(64),
      verification: { manifest: 'Pending' },
    },
  };
  assert.deepEqual(projectPreviousVerifiedRelease(malformed, plan), {});
});

test('cross-namespace or wrong-kind Registration projection fails before Package access', async () => {
  for (const projected of [
    { ...registration(), metadata: { ...registration().metadata, namespace: 'other' } },
    { ...registration(), kind: 'UIPluginPackage' },
  ]) {
    const calls = [];
    const lifecycle = createKubernetesExtensionLifecycle({
      baseUrl: origin,
      token: 'service-account-token-value',
      fetchImpl: async (url) => {
        calls.push(new URL(url).pathname);
        return json(200, { items: [projected] });
      },
    });
    await assert.rejects(lifecycle.reconcileOnce(), { code: 'RegistrationContractViolation' });
    assert.deepEqual(calls, [registrations]);
  }
});

test('malformed Registration list never becomes an Idle lifecycle observation', async () => {
  for (const value of [null, {}, { items: 'not-an-array' }]) {
    const lifecycle = createKubernetesExtensionLifecycle({
      baseUrl: origin,
      token: 'service-account-token-value',
      fetchImpl: async () => json(200, value),
    });
    await assert.rejects(lifecycle.reconcileOnce(), { code: 'AuthorityContractViolation' });
  }
});

test('workload write response and complete post-write inventory are independently verified', async () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const first = plan.resources[0];
  const calls = [];
  const immediate = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path, method });
      if (path === registrations && method === 'GET') return json(200, { items: [registration()] });
      if (path === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
      if (path === first.basePath + '/' + first.manifest.metadata.name && method === 'GET') return json(404, {});
      if (path === first.basePath && method === 'POST') return json(201, {
        ...body,
        automountServiceAccountToken: true,
        metadata: { ...body.metadata, uid: 'created-uid', resourceVersion: '1' },
      });
      if (path === registrations + '/workspace/status' && method === 'PATCH') return json(200, statusPatched(registration(), body.status));
      throw new Error(`unexpected immediate evidence call ${method} ${path}`);
    },
  });
  const immediateResult = await immediate.reconcileOnce();
  assert.equal(immediateResult.state, 'Failed');
  assert.equal(immediateResult.reason, 'AuthorityContractViolation');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);

  const resources = new Map();
  let writes = 0;
  let artifactReads = 0;
  const reread = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      if (parsed.origin !== origin) {
        artifactReads += 1;
        return artifactFetch(fixture)(url, options);
      }
      if (path === registrations && method === 'GET') return json(200, { items: [registration()] });
      if (path === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
      if (path === registrations + '/workspace/status' && method === 'PATCH') return json(200, statusPatched(registration(), body.status));
      if (method === 'GET') {
        if (!resources.has(path)) return json(404, {});
        const observed = structuredClone(resources.get(path));
        if (writes === plan.resources.length && observed.kind === 'Service') observed.spec.selector['opensphere.io/extension-revision'] = 'f'.repeat(20);
        return json(200, observed);
      }
      if (method === 'POST') {
        writes += 1;
        const pathWithName = path + '/' + body.metadata.name;
        resources.set(pathWithName, { ...structuredClone(body), metadata: { ...structuredClone(body.metadata), uid: `${body.metadata.name}-uid`, resourceVersion: String(writes) } });
        return json(201, resources.get(pathWithName));
      }
      throw new Error(`unexpected reread evidence call ${method} ${path}`);
    },
  });
  const rereadResult = await reread.reconcileOnce();
  assert.equal(rereadResult.state, 'Failed');
  assert.equal(rereadResult.reason, 'AuthorityContractViolation');
  assert.equal(writes, plan.resources.length);
  assert.equal(artifactReads, 0);
});

test('Uninstalled workload deletion binds both UID and resourceVersion preconditions', async () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const targetRegistration = registration('Uninstalled');
  const storedByPath = new Map([...plan.resources, plan.activeService].map((item, index) => [
    item.basePath + '/' + item.manifest.metadata.name,
    { ...structuredClone(item.manifest), metadata: { ...structuredClone(item.manifest.metadata), uid: `resource-${index}-uid`, resourceVersion: String(index + 10) } },
  ]));
  const deletes = [];
  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      if (path === registrations && method === 'GET') return json(200, { items: [targetRegistration] });
      if (path === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
      if (path === registrations + '/workspace/status' && method === 'PATCH') return json(200, statusPatched(targetRegistration, body.status));
      if (path === registrations + '/workspace' && method === 'DELETE') {
        deletes.push({ path, body });
        return json(200, {});
      }
      if (method === 'GET' && plan.resources.some((item) => item.basePath === path)) {
        const kind = plan.resources.find((item) => item.basePath === path).manifest.kind;
        return json(200, {
          items: [...storedByPath.entries()]
            .filter(([resourcePath, resource]) => resourcePath.startsWith(path + '/') && resource.kind === kind)
            .map(([, resource]) => structuredClone(resource)),
        });
      }
      if (method === 'GET' && storedByPath.has(path)) return json(200, storedByPath.get(path));
      if (method === 'DELETE' && storedByPath.has(path)) {
        deletes.push({ path, body });
        storedByPath.delete(path);
        return json(200, {});
      }
      return json(404, {});
    },
  });
  assert.equal((await lifecycle.reconcileOnce()).state, 'Removed');
  assert.equal(deletes.length, plan.resources.length + 2);
  for (const deletion of deletes) {
    assert.match(deletion.body.preconditions.uid, /.+/u);
    assert.match(deletion.body.preconditions.resourceVersion, /^[0-9A-Za-z._:-]+$/u);
  }
});


test('changed Registration status rejects replacement, stale RV, and missing status', async () => {
  const fixture = makeReleaseFixture();
  for (const mutate of [
    (value) => { value.metadata.uid = 'replacement-registration-uid'; },
    (value) => { value.metadata.resourceVersion = '19'; },
    (value) => { value.status = {}; },
  ]) {
    const source = registration();
    const lifecycle = createKubernetesExtensionLifecycle({
      baseUrl: origin,
      token: 'service-account-token-value',
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url).pathname;
        const method = options.method || 'GET';
        if (path === registrations && method === 'GET') return json(200, { items: [source] });
        if (path === packages + '/workspace' && method === 'GET') return json(200, { ...fixture.pkg, kind: 'WrongKind' });
        if (path === registrations + '/workspace/status' && method === 'PATCH') {
          const value = statusPatched(source, JSON.parse(options.body).status);
          mutate(value);
          return json(200, value);
        }
        throw new Error(`unexpected status evidence call ${method} ${path}`);
      },
    });
    await assert.rejects(lifecycle.reconcileOnce(), { code: 'AuthorityContractViolation' });
  }
});

test('repeated identical failure status is idempotent without another Kubernetes write', async () => {
  const fixture = makeReleaseFixture();
  const source = registration();
  let writes = 0;
  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: origin, token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === registrations) return json(200, {items: [source]});
      if (path === packages + '/workspace') return json(200, {...fixture.pkg, kind: 'WrongKind'});
      if (path === registrations + '/workspace/status' && options.method === 'PATCH') {
        writes += 1;
        Object.assign(source, statusPatched(source, JSON.parse(options.body).status));
        return json(200, source);
      }
      throw new Error('unexpected request');
    },
  });
  const first = await lifecycle.reconcileOnce();
  assert.equal(first.state, 'Failed');
  assert.deepEqual(await lifecycle.reconcileOnce(), first);
  assert.equal(writes, 1, 'an unchanged status does not require a new resourceVersion');
});

test('typed inventory never inherits item authority from missing or conflicting List envelopes', async () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  for (const envelope of [{}, {apiVersion: 'wrong/v1', kind: 'ServiceAccountList'}, {apiVersion: 'v1', kind: 'SecretList'},
    {apiVersion: 'v1', kind: 'ServiceAccountList', metadata: {continue: 'incomplete-list'}}]) {
    const source = registration();
    let appliedStatus;
    const artifacts = artifactFetch(fixture);
    const lifecycle = createKubernetesExtensionLifecycle({
      baseUrl: origin, token: 'service-account-token-value',
      fetchImpl: async (url, options = {}) => {
        const parsed = new URL(url), path = parsed.pathname;
        if (parsed.origin !== origin) return artifacts(url, options);
        if (path === registrations) return json(200, {items: [source]});
        if (path === packages + '/workspace') return json(200, fixture.pkg);
        if (path.endsWith('/configmaps/opensphere-extension-trusted-keys')) return json(200, {data: {'trusted-keys.json': JSON.stringify({trustedKeys: fixture.trustedKeys})}});
        if (path === registrations + '/workspace/status' && options.method === 'PATCH') {
          appliedStatus = JSON.parse(options.body).status;
          return json(200, statusPatched(source, appliedStatus));
        }
        const item = [...plan.resources, plan.activeService].find(item => path === item.basePath + '/' + item.manifest.metadata.name);
        if (item && options.method === 'GET') {
          const value = structuredClone(item.manifest);
          Object.assign(value.metadata, {uid: 'owned-resource', resourceVersion: '22', generation: 1});
          if (value.kind === 'Deployment') value.status = {observedGeneration: 1, updatedReplicas: value.spec.replicas, availableReplicas: value.spec.replicas};
          return json(200, value);
        }
        if (plan.resources.some(item => path === item.basePath) && options.method === 'GET') return json(200, {...envelope, items: [{metadata: {name: 'untyped'}}]});
        throw new Error('unexpected request ' + path);
      },
    });
    assert.equal((await lifecycle.reconcileOnce()).reason, 'AuthorityContractViolation');
    assert.equal(appliedStatus.phase, 'Failed');
    assert.notEqual(appliedStatus.serving.phase, 'Current');
  }
});

test('changed workload PATCH requires a new RV and Uninstalled stays pending until same-UID absence', async () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const first = plan.resources[0];
  const source = registration();
  const stalePatch = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      if (path === registrations && method === 'GET') return json(200, { items: [source] });
      if (path === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
      if (path === first.basePath + '/' + first.manifest.metadata.name && method === 'GET') return json(200, {
        ...structuredClone(first.manifest),
        automountServiceAccountToken: true,
        metadata: { ...structuredClone(first.manifest.metadata), uid: 'workload-uid', resourceVersion: '7' },
      });
      if (path === first.basePath + '/' + first.manifest.metadata.name && method === 'PATCH') return json(200, {
        ...body,
        metadata: { ...body.metadata, uid: 'workload-uid', resourceVersion: '7' },
      });
      if (path === registrations + '/workspace/status' && method === 'PATCH') return json(200, statusPatched(source, body.status));
      throw new Error(`unexpected workload RV call ${method} ${path}`);
    },
  });
  assert.deepEqual(await stalePatch.reconcileOnce(), {
    state: 'Failed', extensionId: 'workspace', reason: 'AuthorityContractViolation',
  });

  const uninstall = registration('Uninstalled');
  const active = {
    ...structuredClone(plan.activeService.manifest),
    metadata: { ...structuredClone(plan.activeService.manifest.metadata), uid: 'active-uid', resourceVersion: '8' },
  };
  let registrationDelete = 0;
  const pendingDelete = createKubernetesExtensionLifecycle({
    baseUrl: origin,
    token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      if (path === registrations && method === 'GET') return json(200, { items: [uninstall] });
      if (path === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
      if (path === plan.activeService.basePath + '/workspace' && method === 'GET') return json(200, active);
      if (path === plan.activeService.basePath + '/workspace' && method === 'DELETE') return json(202, {});
      if (path === registrations + '/workspace' && method === 'DELETE') registrationDelete += 1;
      if (path === registrations + '/workspace/status' && method === 'PATCH') return json(200, statusPatched(uninstall, body.status));
      throw new Error(`unexpected pending deletion call ${method} ${path}`);
    },
  });
  assert.deepEqual(await pendingDelete.reconcileOnce(), {
    state: 'Pending', extensionId: 'workspace', reason: 'DeletionPending',
  });
  assert.equal(registrationDelete, 0);
});


test('permission verification evidence never reports approval for pre-approval failures', async () => {
  const scenarios = [
    {
      change: (fixture) => { fixture.pkg.spec.permissionProfile = 'namespace-write'; },
      reason: 'UnsupportedPermissionProfile',
      permissionEvidence: 'Failed',
    },
    {
      change: (fixture) => { fixture.pkg.spec.image.digest = 'latest'; },
      reason: 'PackageContractViolation',
      permissionEvidence: 'Pending',
    },
  ];
  for (const scenario of scenarios) {
    const fixture = makeReleaseFixture();
    scenario.change(fixture);
    let observedStatus;
    const lifecycle = createKubernetesExtensionLifecycle({
      baseUrl: origin,
      token: 'service-account-token-value',
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url).pathname;
        const method = options.method || 'GET';
        if (path === registrations && method === 'GET') return json(200, { items: [registration()] });
        if (path === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
        if (path === registrations + '/workspace/status' && method === 'PATCH') {
          observedStatus = JSON.parse(options.body).status;
          return json(200, statusPatched(registration(), observedStatus));
        }
        throw new Error('unexpected permission evidence call ' + method + ' ' + path);
      },
    });
    const result = await lifecycle.reconcileOnce();
    assert.equal(result.state, 'Failed');
    assert.equal(result.reason, scenario.reason);
    assert.equal(observedStatus.reason, scenario.reason);
    assert.equal(observedStatus.verification.permissions, scenario.permissionEvidence);
  }
});


test('inactive revision GC is UID/RV-bound and remains pending until absence is observed', async () => {
  async function scenario({ observeDeletion }) {
    const fixture = makeReleaseFixture();
    const current = buildExtensionWorkloadPlan(fixture.pkg);
    const oldPackage = structuredClone(fixture.pkg);
    oldPackage.spec.image.digest = 'sha256:' + 'c'.repeat(64);
    oldPackage.spec.resolution.resolvedDigest = oldPackage.spec.image.digest;
    oldPackage.spec.manifest.sha256 = 'd'.repeat(64);
    const previous = buildExtensionWorkloadPlan(oldPackage);
    const sourceRegistration = registration();
    const resources = new Map();
    let sequence = 1;
    const store = (item, ready = false) => {
      const value = {
        ...structuredClone(item.manifest),
        metadata: {
          ...structuredClone(item.manifest.metadata),
          uid: item.manifest.metadata.name + '-uid',
          resourceVersion: String(sequence++),
          ...(ready ? { generation: 1 } : {}),
        },
        ...(ready ? {
          status: {
            observedGeneration: 1,
            updatedReplicas: item.manifest.spec.replicas,
            availableReplicas: item.manifest.spec.replicas,
            unavailableReplicas: 0,
          },
        } : {}),
      };
      resources.set(item.basePath + '/' + item.manifest.metadata.name, value);
    };
    for (const item of current.resources) store(item, item.manifest.kind === 'Deployment');
    for (const item of previous.resources) store(item, item.manifest.kind === 'Deployment');
    store(current.activeService);
    const deletes = [];
    const artifacts = artifactFetch(fixture);
    const lifecycle = createKubernetesExtensionLifecycle({
      baseUrl: origin,
      token: 'service-account-token-value',
      fetchImpl: async (url, options = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname;
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        if (parsed.origin !== origin) return artifacts(url, options);
        if (path === registrations && method === 'GET') return json(200, { items: [sourceRegistration] });
        if (path === packages + '/workspace' && method === 'GET') return json(200, fixture.pkg);
        if (path.endsWith('/configmaps/opensphere-extension-trusted-keys') && method === 'GET') {
          return json(200, { data: { 'trusted-keys.json': JSON.stringify({ trustedKeys: fixture.trustedKeys }) } });
        }
        if (path === registrations + '/workspace/status' && method === 'PATCH') {
          return json(200, statusPatched(sourceRegistration, body.status));
        }
        if (method === 'GET' && current.resources.some((item) => item.basePath === path)) {
          const kind = current.resources.find((item) => item.basePath === path).manifest.kind;
          return json(200, {
            items: [...resources.entries()]
              .filter(([resourcePath, resource]) => resourcePath.startsWith(path + '/') && resource.kind === kind)
              .map(([, resource]) => structuredClone(resource)),
          });
        }
        if (method === 'GET') {
          return resources.has(path) ? json(200, structuredClone(resources.get(path))) : json(404, {});
        }
        if (method === 'DELETE') {
          const before = resources.get(path);
          deletes.push({ path, body, before: structuredClone(before) });
          if (observeDeletion) resources.delete(path);
          return json(202, {});
        }
        throw new Error('unexpected GC request ' + method + ' ' + path);
      },
    });
    return {
      result: await lifecycle.reconcileOnce(),
      deletes,
      current,
      previous,
    };
  }

  const completed = await scenario({ observeDeletion: true });
  assert.equal(completed.result.state, 'Activated');
  assert.equal(completed.deletes.length, completed.previous.resources.length);
  const previousNames = new Set(completed.previous.resources.map((item) => item.manifest.metadata.name));
  const currentNames = new Set(completed.current.resources.map((item) => item.manifest.metadata.name));
  for (const deletion of completed.deletes) {
    assert.ok(previousNames.has(deletion.before.metadata.name));
    assert.equal(currentNames.has(deletion.before.metadata.name), false);
    assert.deepEqual(deletion.body.preconditions, {
      uid: deletion.before.metadata.uid,
      resourceVersion: deletion.before.metadata.resourceVersion,
    });
    assert.equal(deletion.body.propagationPolicy, 'Foreground');
  }

  const pending = await scenario({ observeDeletion: false });
  assert.deepEqual(pending.result, {
    state: 'Pending', extensionId: 'workspace', reason: 'DeletionPending',
  });
  assert.equal(pending.deletes.length, 1);
});
