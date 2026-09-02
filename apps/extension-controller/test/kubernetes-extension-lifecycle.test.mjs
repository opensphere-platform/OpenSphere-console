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

test('lifecycle materializes an exact revision and cuts over only after byte verification', async () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const currentRegistration = {
    ...registration(),
    status: {
      currentDigest: 'sha256:' + 'c'.repeat(64),
      currentManifestSha256: 'd'.repeat(64),
      currentVersion: '1.1.0',
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
      return json(200, { ...currentRegistration, status: body.status });
    }

    if (method === 'GET') {
      if (!resources.has(parsed.pathname)) return json(404, { reason: 'NotFound' });
      const value = structuredClone(resources.get(parsed.pathname));
      if (value.kind === 'Deployment') {
        value.metadata.generation = 1;
        value.status = {
          observedGeneration: 1,
          updatedReplicas: value.spec.replicas,
          availableReplicas: value.spec.replicas,
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
    && call.path === registrations + '/workspace/status');
  assert.equal(statusPatch.body.metadata.resourceVersion, '19');
  assert.equal(statusPatch.body.status.phase, 'Activated');
  assert.deepEqual({
    digest: statusPatch.body.status.previousDigest,
    manifestSha256: statusPatch.body.status.previousManifestSha256,
    version: statusPatch.body.status.previousVersion,
    revision: statusPatch.body.status.previousRevision,
    evidenceRefs: statusPatch.body.status.previousEvidenceRefs,
  }, {
    digest: 'sha256:' + 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    version: '1.1.0',
    revision: 'c'.repeat(40),
    evidenceRefs: ['release:previous'],
  });
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
        return json(200, { ...registration(), status: body.status });
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
        });
      }
      if (parsed.pathname === first.basePath + '/' + first.manifest.metadata.name && method === 'PATCH') {
        assert.equal(body.metadata.resourceVersion, '41');
        return json(200, body);
      }
      if (parsed.pathname === registrations + '/workspace/status' && method === 'PATCH') {
        return json(200, { ...registration(), status: body.status });
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
        return json(200, { ...registration(), status: body.status });
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
        return json(200, {});
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
  assert.throws(() => projectPreviousVerifiedRelease(malformed, plan), {
    code: 'RegistrationContractViolation',
  });
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
