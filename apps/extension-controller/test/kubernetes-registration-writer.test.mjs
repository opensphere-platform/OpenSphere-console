import assert from 'node:assert/strict';
import test from 'node:test';
import { createKubernetesRegistrationWriter } from '../src/kubernetes-registration-writer.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
const candidate = {
  id: 'workspace', descriptorId: 'extension.workspace', kind: 'extension',
  image: 'ghcr.io/opensphere-platform/opensphere-plugin-workspace@' + digest,
  digest, channel: 'edge', sourceRevision: 'b'.repeat(40), compatibilityVersion: '1.0.0',
  manifestDigest: 'sha256:' + 'c'.repeat(64), keyId: 'release-key',
  packageResourceVersion: '17', packageGeneration: 2,
};

function packageObject(patch = {}) {
  return {
    metadata: { name: 'workspace', resourceVersion: '17', generation: 2, labels: { 'opensphere.io/scope': 'workspace-extension' } },
    spec: {
      kind: 'plugin', image: { repository: 'ghcr.io/opensphere-platform/opensphere-plugin-workspace', digest },
      resolution: {
        resolvedDigest: digest, requestedChannel: 'edge', revision: 'b'.repeat(40),
        compatibilityVersion: '1.0.0', signatureIdentity: 'release-key',
      },
      manifest: { sha256: 'c'.repeat(64) }, trust: { keyId: 'release-key' },
    },
    ...patch,
  };
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function readyRegistration(patch = {}) {
  return {
    metadata: { name: 'workspace', uid: 'registration-uid', resourceVersion: '19', generation: 3 },
    spec: { packageRef: { name: 'workspace' }, desiredState: 'Installed' },
    status: {
      observedGeneration: 3, phase: 'Ready', currentDigest: digest,
      currentManifestSha256: 'c'.repeat(64), currentRevision: 'b'.repeat(40),
      currentCompatibilityVersion: '1.0.0', currentSignatureIdentity: 'release-key',
      workload: { phase: 'Ready' },
      verification: { manifest: 'Verified', signature: 'Verified', entryDigest: 'Verified', permissions: 'Approved' },
      serving: { phase: 'Current', digest, manifestSha256: 'c'.repeat(64) },
      revalidation: { phase: 'Passed' },
    },
    ...patch,
  };
}

test('Kubernetes writer verifies Package coordinates before creating one Registration', async () => {
  const calls = [];
  const writer = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/uipluginpackages/workspace')) return json(200, packageObject());
      if (options.method === 'GET') return json(404, { reason: 'NotFound' });
      return json(201, { metadata: { name: 'workspace', uid: 'registration-uid', resourceVersion: '18' } });
    },
  });
  const result = await writer.applyInstall({
    candidate, operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    requestedBy: '11111111-1111-4111-8111-111111111111', reason: 'install workspace extension',
  });
  assert.equal(result.created, true);
  assert.equal(result.registrationUid, 'registration-uid');
  assert.deepEqual(calls.map((call) => call.options.method), ['GET', 'GET', 'POST']);
  assert.equal(calls[2].body.spec.packageRef.name, 'workspace');
  assert.equal(calls[2].body.spec.desiredState, 'Installed');
  assert.equal(calls[2].body.spec.installation.operationId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(calls[0].options.headers.authorization, 'Bearer service-account-token-value');
});

test('existing compatible Registration is an idempotent success without mutation', async () => {
  const methods = [];
  const writer = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url, options) => {
      methods.push(options.method);
      if (url.endsWith('/uipluginpackages/workspace')) return json(200, packageObject());
      return json(200, {
        metadata: { name: 'workspace', uid: 'registration-uid', resourceVersion: '19' },
        spec: { packageRef: { name: 'workspace' }, desiredState: 'Enabled' },
      });
    },
  });
  const result = await writer.applyInstall({ candidate, operationId: 'op', requestedBy: 'actor', reason: 'reason' });
  assert.equal(result.created, false);
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('Package drift and conflicting Registration fail closed', async () => {
  const drifted = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async () => json(200, packageObject({ metadata: { name: 'workspace', resourceVersion: '18', generation: 2 } })),
  });
  await assert.rejects(drifted.applyInstall({ candidate, operationId: 'op', requestedBy: 'actor', reason: 'reason' }), { code: 'StaleAuthorityRevision' });

  const conflict = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url) => url.endsWith('/uipluginpackages/workspace') ? json(200, packageObject()) : json(200, {
      metadata: { uid: 'registration-uid', resourceVersion: '19' },
      spec: { packageRef: { name: 'workspace' }, desiredState: 'Uninstalled' },
    }),
  });
  await assert.rejects(conflict.applyInstall({ candidate, operationId: 'op', requestedBy: 'actor', reason: 'reason' }), { code: 'OwnerRejected' });
});

test('install observation accepts only generation-current exact release readiness', async () => {
  const writer = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url) => url.endsWith('/uipluginpackages/workspace')
      ? json(200, packageObject()) : json(200, readyRegistration()),
  });
  const result = await writer.observeInstall({ candidate, registrationUid: 'registration-uid' });
  assert.equal(result.state, 'Ready');
  assert.equal(result.observation.registration.observedGeneration, 3);
  assert.equal(result.observation.serving.digest, digest);

  const pending = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url) => url.endsWith('/uipluginpackages/workspace')
      ? json(200, packageObject())
      : json(200, readyRegistration({ status: { ...readyRegistration().status, observedGeneration: 2 } })),
  });
  assert.deepEqual(
    await pending.observeInstall({ candidate, registrationUid: 'registration-uid' }),
    { state: 'Pending', reason: 'RegistrationNotReady' },
  );
});

test('install observation rejects Package replacement and Registration UID substitution', async () => {
  const packageDrift = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async () => json(200, packageObject({ metadata: { name: 'workspace', resourceVersion: '20', generation: 3 } })),
  });
  await assert.rejects(packageDrift.observeInstall({ candidate, registrationUid: 'registration-uid' }), { code: 'StaleAuthorityRevision' });

  const uidDrift = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url) => url.endsWith('/uipluginpackages/workspace')
      ? json(200, packageObject()) : json(200, readyRegistration({ metadata: { name: 'workspace', uid: 'other-uid', resourceVersion: '19', generation: 3 } })),
  });
  await assert.rejects(uidDrift.observeInstall({ candidate, registrationUid: 'registration-uid' }), { code: 'ObservationMismatch' });
});

test('removal applies an Uninstalled merge patch with a resource-version precondition', async () => {
  const calls = [];
  const registration = {
    metadata: { name: 'workspace', uid: 'registration-uid', resourceVersion: '19', generation: 3 },
    spec: { packageRef: { name: 'workspace' }, desiredState: 'Enabled' },
  };
  const writer = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/uipluginpackages/workspace')) return json(200, packageObject());
      if (options.method === 'GET') return json(200, registration);
      return json(200, {
        metadata: { ...registration.metadata, resourceVersion: '20', generation: 4 },
        spec: { ...registration.spec, desiredState: 'Uninstalled' },
      });
    },
  });
  const result = await writer.applyRemove({
    descriptorId: 'extension.workspace', operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    requestedBy: '11111111-1111-4111-8111-111111111111', reason: 'remove retired workspace extension',
  });
  assert.deepEqual(calls.map((call) => call.options.method), ['GET', 'GET', 'PATCH']);
  assert.equal(calls[2].options.headers['content-type'], 'application/merge-patch+json');
  assert.equal(calls[2].body.metadata.resourceVersion, '19');
  assert.equal(calls[2].body.spec.desiredState, 'Uninstalled');
  assert.equal(result.registrationUid, 'registration-uid');
  assert.equal(result.changed, true);
});

test('removal rejects shell-pinned core before reading or mutating its Registration', async () => {
  const calls = [];
  const writer = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json(200, packageObject({
        metadata: { name: 'workspace', resourceVersion: '17', generation: 2, labels: { 'opensphere.io/scope': 'main-shell-core' } },
      }));
    },
  });
  await assert.rejects(writer.applyRemove({
    descriptorId: 'extension.workspace', operationId: 'operation', requestedBy: 'actor',
    reason: 'remove retired workspace extension',
  }), { code: 'OwnerRejected', terminal: true });
  assert.deepEqual(calls.map((call) => call.options.method), ['GET']);
});

test('removal observation succeeds only after the exact Registration is absent', async () => {
  const absent = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async () => json(404, { reason: 'NotFound' }),
  });
  const result = await absent.observeRemove({ registrationName: 'workspace', registrationUid: 'registration-uid' });
  assert.equal(result.state, 'Removed');
  assert.deepEqual(result.observation.registration, { name: 'workspace', uid: 'registration-uid', phase: 'Absent' });

  const present = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async () => json(200, {
      metadata: { name: 'workspace', uid: 'registration-uid' },
      spec: { desiredState: 'Uninstalled' }, status: { phase: 'Uninstalling' },
    }),
  });
  assert.deepEqual(
    await present.observeRemove({ registrationName: 'workspace', registrationUid: 'registration-uid' }),
    { state: 'Pending', reason: 'RegistrationStillPresent' },
  );

  const replaced = createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async () => json(200, { metadata: { name: 'workspace', uid: 'replacement-uid' } }),
  });
  await assert.rejects(
    replaced.observeRemove({ registrationName: 'workspace', registrationUid: 'registration-uid' }),
    { code: 'ObservationMismatch' },
  );
});

test('Kubernetes writer rejects remote cleartext and malformed credentials', () => {
  assert.throws(() => createKubernetesRegistrationWriter({
    baseUrl: 'http://kubernetes.example', token: 'service-account-token-value',
  }), /HTTPS origin or loopback/);
  assert.throws(() => createKubernetesRegistrationWriter({
    baseUrl: 'https://kubernetes.test', token: 'token with whitespace value',
  }), /bearer token/);
});
