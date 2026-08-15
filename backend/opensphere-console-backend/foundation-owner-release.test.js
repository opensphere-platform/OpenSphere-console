'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DEPLOYMENT_PATH,
  REGISTRATION_PATH,
  deploymentReady,
  executeFoundationOwnerRelease,
  foundationManifestCapabilityDigest,
  parsePublication,
  verifyFoundationPublication,
} = require('./foundation-owner-release');

const previous = {
  image: 'ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:' + '1'.repeat(64),
  digest: 'sha256:' + '1'.repeat(64),
  sourceRevision: '2'.repeat(40),
  releaseTag: '202608140101',
};
const target = {
  image: 'ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:' + '3'.repeat(64),
  digest: 'sha256:' + '3'.repeat(64),
  sourceRevision: '4'.repeat(40),
  releaseTag: '202608151420',
};

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fixture(keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })) {
  const publication = {
    contract: 'opensphere-local-edge-module-publication/v1',
    channel: 'edge',
    releaseScope: 'component',
    buildAuthority: 'localhost',
    gaPromotionEligible: false,
    platform: 'linux/amd64',
    sourceRepository: 'https://github.com/opensphere-platform/OpenSphere-shell-foundation.git',
    sourceUpstreamRef: 'origin/main',
    requestIntent: 'Enable the canonical PostgreSQL Foundation owner in Web Shell',
    changedPaths: ['server.js', 'test/postgres-owner-contract.test.js'],
    affectedImages: ['foundation'],
    fullReleaseJustification: null,
    generatedAt: '2026-08-15T05:20:00.000Z',
    previous: {
      repository: 'ghcr.io/opensphere-platform/opensphere-shell-foundation', image: previous.image,
      digest: previous.image.split('@')[1], sourceRevision: previous.sourceRevision,
      buildAuthority: 'localhost', signatureIdentity: 'opensphere-edge-local-v1',
      source: 'https://github.com/opensphere-platform/OpenSphere-shell-foundation',
      phase: 'Activated', workloadPhase: 'Ready',
    },
    previousOwner: {
      image: previous.image, digest: previous.image.split('@')[1],
      sourceRevision: previous.sourceRevision, releaseTag: previous.releaseTag,
    },
    tooling: {
      platformSourceRevision: '7'.repeat(40), platformUpstreamRef: 'origin/main',
      consoleSourceRevision: '8'.repeat(40), consoleUpstreamRef: 'origin/main',
      sdkSourceRevision: '9'.repeat(40), sdkUpstreamRef: 'origin/main',
      sdkRepository: 'https://github.com/opensphere-platform/OpenSphere-SDK.git',
      sdkPackageLockSha256: 'sha256:' + '9'.repeat(64),
      inventory: { path: 'repository-inventory.json', sha256: 'sha256:' + 'd'.repeat(64), gitBlob: 'd'.repeat(40) },
      publisher: { path: 'tools/release/Publish-LocalEdgeModule.ps1', sha256: 'sha256:' + 'a'.repeat(64), gitBlob: 'a'.repeat(40) },
      deployer: { path: 'tools/release/Deploy-LocalEdgeFoundation.ps1', sha256: 'sha256:' + 'b'.repeat(64), gitBlob: 'b'.repeat(40) },
      signingHelper: { path: 'scripts/os-shell-edge-signing.ps1', sha256: 'sha256:' + 'c'.repeat(64), gitBlob: 'c'.repeat(40) },
      initializer: { path: 'scripts/Initialize-FoundationOwnerInstallationLock.ps1', sha256: 'sha256:' + 'e'.repeat(64), gitBlob: 'e'.repeat(40) },
      cliVerifier: { path: 'tools/release/verify-canonical-cli-artifact.mjs', sha256: 'sha256:' + '7'.repeat(64), gitBlob: '7'.repeat(40) },
      cliArtifact: {
        contract: 'opensphere-cli-image-artifact-evidence/v1',
        path: 'C:\\Users\\fixture\\AppData\\Local\\OpenSphere\\bin\\os.exe',
        sha256: 'sha256:' + 'f'.repeat(64), version: '0.8.2',
        manifestUrl: 'https://localhost:1114/api/cli/index.json',
        manifestImagePath: '/srv/index.json', artifactImagePath: '/srv/opensphere-cli-windows-amd64.exe',
        artifactSize: 123456,
        manifestSha256: 'sha256:' + '1'.repeat(64), manifestSignatureAlgorithm: 'Ed25519',
        manifestSignatureKeyId: 'opensphere-cli-local-dev-v1',
        manifestSignaturePublicKeySpkiSha256: 'sha256:76982788c0736b5f8dd759b88a6b6bf7de6e34650c7b37f329f26d8efe1d6768',
        deploymentImage: 'ghcr.io/opensphere-platform/opensphere-os-cli@sha256:' + '2'.repeat(64),
        deploymentDigest: 'sha256:' + '2'.repeat(64), sourceRevision: '3'.repeat(40),
        runtimeImageId: 'docker-pullable://ghcr.io/opensphere-platform/opensphere-os-cli@sha256:' + '2'.repeat(64),
        localImageId: 'sha256:' + '4'.repeat(64),
        deploymentUid: '11111111-2222-4333-8444-555555555555', deploymentGeneration: 9,
        deploymentResourceVersion: '17',
      },
    },
    module: {
      id: 'foundation', kind: 'subShell',
      repository: 'ghcr.io/opensphere-platform/opensphere-shell-foundation',
      image: target.image, digest: target.digest, sourceRevision: target.sourceRevision,
      releaseTag: target.releaseTag, compatibilityVersion: '0.2.1',
      descriptorSha256: 'sha256:' + '5'.repeat(64),
      descriptorSignatureSha256: 'sha256:' + '6'.repeat(64),
      moduleKeyId: 'opensphere-edge-local-v1',
    },
  };
  const document = Buffer.from(JSON.stringify(publication));
  const spki = keyPair.publicKey.export({ format: 'der', type: 'spki' });
  const signature = crypto.sign('sha256', document,
    { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' });
  return {
    publication,
    publicationDocumentBase64: document.toString('base64'),
    trustedPublicKeySpkiBase64: spki.toString('base64'),
    publicationSignature: {
      contract: 'opensphere-edge-detached-signature/v1', algorithm: 'ES256-P1363',
      keyId: 'opensphere-edge-local-v1',
      trustReference: 'configmap://opensphere-console/dupa-trusted-keys#opensphere-edge-local-v1',
      documentSha256: sha256(document), publicKeySpkiSha256: sha256(spki),
      signature: signature.toString('base64url'), releaseClass: 'pre-ga', gaPromotionEligible: false,
    },
  };
}

function deployment(state = previous, ready = true) {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'foundation-oaa-owner', namespace: 'opensphere-console',
      uid: '11111111-2222-4333-8444-555555555555', resourceVersion: '17', generation: 9 },
    spec: {
      replicas: 2,
      template: {
        metadata: { annotations: {
          'io.opensphere.source-revision': state.sourceRevision,
          'io.opensphere.release-tag': state.releaseTag,
        } },
        spec: { containers: [{ name: 'owner', image: state.image,
          env: [{ name: 'APP_VERSION', value: state.releaseTag }] }] },
      },
    },
    status: ready ? { observedGeneration: 9, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 } : {},
  };
}

function mainRegistration(state = target) {
  return {
    metadata: { name: 'foundation', namespace: 'opensphere-console' },
    spec: { desiredState: 'Enabled', packageRef: { name: 'foundation' } },
    status: {
      currentDigest: state.digest, currentRevision: state.sourceRevision,
      currentRequestedRef: state.image, currentBuildAuthority: 'localhost',
      currentSignatureIdentity: 'opensphere-edge-local-v1',
      currentSource: 'https://github.com/opensphere-platform/OpenSphere-shell-foundation',
      phase: 'Activated', workload: { phase: 'Ready' }, verification: { signature: 'Verified' },
    },
  };
}

function manifestFixture(sourceRevision = target.sourceRevision, available = true) {
  const definitions = [
    ['capability.read','foundation.capabilities','GET','/api/foundation/oaa/postgres/capabilities'],
    ['readiness.read','foundation.readiness','GET','/api/foundation/oaa/postgres/readiness'],
    ['catalog.read','foundation.postgres.catalog','GET','/api/foundation/oaa/postgres/catalog'],
    ['cluster.plan','foundation.postgres.plan.create','POST','/api/foundation/oaa/postgres/durable-plan'],
    ['cluster.create','foundation.postgres.apply','POST','/api/foundation/oaa/postgres/durable-apply/{planId}',['planId'],'exact-confirmation'],
    ['cluster.status','foundation.postgres.status','GET','/api/foundation/oaa/postgres/claims/{namespace}/{name}',['namespace','name']],
    ['operation.watch','foundation.operation.watch','GET','/api/foundation/oaa/operations/{operationId}',['operationId']],
  ];
  return {
    kind: 'OpenSphereCLICommandManifest', schemaVersion: 'v1', contractVersion: 'v1',
    sourceRevision, capabilityId: 'data.sql.postgres',
    tools: definitions.map(([actionId, toolId, method, bindingPath, pathParams, approval]) => {
      return { id: toolId, actionId, contractVersion: 'v1', sourceRevision,
        capabilityId: 'data.sql.postgres', requestType: 'Instance', webShell: { available },
        semanticIdentity: { capabilityId: 'data.sql.postgres', requestType: 'Instance', actionId, toolId },
        actionBinding: { method, path: bindingPath, ...(pathParams ? { pathParams } : {}), ...(approval ? { approval } : {}) } };
    }),
  };
}

function requestBody(signed = fixture()) {
  return {
    action: 'Apply',
    operationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    reason: 'Update Foundation owner to the exact signed local edge component',
    expectedCurrent: { image: previous.image, sourceRevision: previous.sourceRevision },
    publicationDocumentBase64: signed.publicationDocumentBase64,
    publicationSignature: signed.publicationSignature,
  };
}

test('signed Foundation publication is closed, P-256 verified, and tamper/wrong-key rejected', () => {
  const signed = fixture();
  assert.equal(verifyFoundationPublication(signed).publication.module.image, target.image);
  const tampered = { ...signed, publicationDocumentBase64: Buffer.from(
    signed.publicationDocumentBase64, 'base64').subarray(0, -1).toString('base64') };
  assert.throws(() => verifyFoundationPublication(tampered), /signature envelope|verification/);
  const wrong = fixture();
  assert.throws(() => verifyFoundationPublication({ ...signed,
    trustedPublicKeySpkiBase64: wrong.trustedPublicKeySpkiBase64 }), /digest mismatch/);
  assert.throws(() => verifyFoundationPublication({ ...signed,
    publicationDocumentBase64: `${signed.publicationDocumentBase64}\n` }), /canonical base64/);
});

test('publication rejects path escape, hidden affected images, and integrated-release claims', () => {
  const valid = fixture().publication;
  assert.throws(() => parsePublication(Buffer.from(JSON.stringify({ ...valid,
    changedPaths: ['../server.js'] }))), /canonical Foundation/);
  assert.throws(() => parsePublication(Buffer.from(JSON.stringify({ ...valid,
    affectedImages: ['backend', 'foundation'] }))), /canonical Foundation/);
  assert.throws(() => parsePublication(Buffer.from(JSON.stringify({ ...valid,
    fullReleaseJustification: 'rebuild everything' }))), /canonical Foundation/);
  for (const mutate of [
    (p) => { p.tooling.sdkRepository = 'https://attacker.invalid/OpenSphere-SDK.git'; },
    (p) => { p.tooling.sdkPackageLockSha256 = 'sha256:invalid'; },
    (p) => { p.tooling.inventory.path = '../repository-inventory.json'; },
    (p) => { p.tooling.initializer.path = 'scripts/attacker.ps1'; },
    (p) => { p.tooling.cliVerifier.path = 'tools/release/attacker.mjs'; },
    (p) => { p.tooling.cliArtifact.path = 'C:\\attacker\\os.exe'; },
    (p) => { p.tooling.cliArtifact.manifestSignaturePublicKeySpkiSha256 = 'sha256:' + '0'.repeat(64); },
    (p) => { p.tooling.cliArtifact.runtimeImageId = 'docker-pullable://attacker.invalid/os-cli@sha256:' + '2'.repeat(64); },
    (p) => { p.tooling.cliArtifact.deploymentImage =
      'ghcr.io/opensphere-platform/opensphere-os-cli@sha256:' + '0'.repeat(64); },
  ]) {
    const tampered = structuredClone(valid); mutate(tampered);
    assert.throws(() => parsePublication(Buffer.from(JSON.stringify(tampered))), /canonical Foundation/);
  }
});

test('manifest capability digest rejects method, path, request type, tool identity, and semantic extras', () => {
  assert.match(foundationManifestCapabilityDigest(manifestFixture(), target.sourceRevision), /^sha256:[a-f0-9]{64}$/);
  for (const mutate of [
    (m) => { m.tools[0].actionBinding.method = 'POST'; },
    (m) => { m.tools[1].actionBinding.path = '/api/attacker'; },
    (m) => { m.tools[2].requestType = 'Collection'; },
    (m) => { m.tools[3].id = 'attacker.tool'; },
    (m) => { m.tools[4].semanticIdentity.extra = 'downgrade'; },
  ]) {
    const manifest = structuredClone(manifestFixture()); mutate(manifest);
    assert.throws(() => foundationManifestCapabilityDigest(manifest, target.sourceRevision), /canonical|closed contract/);
  }
});

test('owner release applies exact CAS patch, observes rollout and Web Shell manifest', async () => {
  const signed = fixture();
  let current = deployment();
  const patches = [];
  const kubernetesRequest = async (method, requestPath, body, contentType) => {
    if (requestPath === REGISTRATION_PATH) return { ok: true, status: 200, body: mainRegistration() };
    assert.equal(requestPath, DEPLOYMENT_PATH);
    if (method === 'GET') return { ok: true, status: 200, body: current };
    assert.equal(method, 'PATCH'); assert.equal(contentType, 'application/json-patch+json');
    patches.push(body);
    assert.deepEqual(body.slice(0, 4).map((entry) => entry.op), ['test', 'test', 'test', 'test']);
    current = deployment(target);
    return { ok: true, status: 200, body: current };
  };
  const result = await executeFoundationOwnerRelease({
    body: requestBody(signed), trustedPublicKeySpkiBase64: signed.trustedPublicKeySpkiBase64,
    kubernetesRequest,
    fetchManifest: async () => manifestFixture(),
    sleep: async () => {}, timeoutMs: 1000,
  });
  assert.equal(result.state, 'Applied'); assert.equal(result.changed, true);
  assert.equal(result.manifest.tools[0].webShell.available, true);
  assert.equal(patches.length, 1); assert.equal(patches[0][4].value, target.image);
  assert.ok(deploymentReady(current, target));
});

test('exact repeated operation is idempotent and stale expected state is rejected', async () => {
  const signed = fixture();
  const fetchManifest = async () => manifestFixture();
  let patchCalls = 0;
  const already = await executeFoundationOwnerRelease({
    body: requestBody(signed), trustedPublicKeySpkiBase64: signed.trustedPublicKeySpkiBase64,
    kubernetesRequest: async (method, requestPath) => {
      if (requestPath === REGISTRATION_PATH) return { ok: true, status: 200, body: mainRegistration() };
      if (method === 'PATCH') patchCalls += 1;
      return { ok: true, status: 200, body: deployment(target) };
    }, fetchManifest, sleep: async () => {}, timeoutMs: 1000,
  });
  assert.equal(already.state, 'AlreadyCurrent'); assert.equal(patchCalls, 0);
  await assert.rejects(executeFoundationOwnerRelease({
    body: requestBody(signed), trustedPublicKeySpkiBase64: signed.trustedPublicKeySpkiBase64,
    kubernetesRequest: async (method, requestPath) => ({ ok: true, status: 200,
      body: requestPath === REGISTRATION_PATH ? mainRegistration()
        : deployment({ ...previous, sourceRevision: '9'.repeat(40) }) }),
    fetchManifest, sleep: async () => {}, timeoutMs: 1000,
  }), /PreconditionFailed/);
});

test('owner mutation is blocked until the DUPA-managed main release is exact and Ready', async () => {
  const signed = fixture();
  const stale = mainRegistration({ ...target, sourceRevision: '8'.repeat(40) });
  await assert.rejects(executeFoundationOwnerRelease({
    body: requestBody(signed), trustedPublicKeySpkiBase64: signed.trustedPublicKeySpkiBase64,
    kubernetesRequest: async (method, requestPath) => ({ ok: true, status: 200,
      body: requestPath === REGISTRATION_PATH ? stale : deployment() }),
    fetchManifest: async () => ({}), sleep: async () => {}, timeoutMs: 1000,
  }), /FoundationMainReleaseNotReady/);
});

test('failed target manifest rolls the exact owner image and source back', async () => {
  const signed = fixture();
  let current = deployment();
  const patches = [];
  let targetManifestCalls = 0;
  const kubernetesRequest = async (method, requestPath, body) => {
    if (requestPath === REGISTRATION_PATH) return { ok: true, status: 200, body: mainRegistration() };
    if (method === 'GET') return { ok: true, status: 200, body: current };
    patches.push(body);
    const image = body.find((entry) => entry.path.endsWith('/image') && entry.op === 'replace').value;
    current = image === target.image ? deployment(target) : deployment(previous);
    return { ok: true, status: 200, body: current };
  };
  await assert.rejects(executeFoundationOwnerRelease({
    body: requestBody(signed), trustedPublicKeySpkiBase64: signed.trustedPublicKeySpkiBase64,
    kubernetesRequest,
    fetchManifest: async () => {
      if (current.spec.template.spec.containers[0].image === target.image) {
        targetManifestCalls += 1;
        return manifestFixture(target.sourceRevision, false);
      }
      return { sourceRevision: previous.sourceRevision, actions: [] };
    },
    sleep: async () => {}, timeoutMs: 5,
  }), /rolled back/);
  assert.ok(targetManifestCalls > 0); assert.equal(patches.length, 2);
  assert.equal(current.spec.template.spec.containers[0].image, previous.image);
});

test('signed operation can durably roll back only the recorded prior owner release', async () => {
  const signed = fixture();
  let current = deployment(target);
  Object.assign(current.spec.template.metadata.annotations, {
    'opensphere.io/foundation-owner-operation-id': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'opensphere.io/foundation-owner-publication-sha256': signed.publicationSignature.documentSha256,
    'opensphere.io/foundation-owner-previous-image': previous.image,
    'opensphere.io/foundation-owner-previous-source-revision': previous.sourceRevision,
    'opensphere.io/foundation-owner-previous-release-tag': previous.releaseTag,
  });
  const body = { ...requestBody(signed), action: 'Rollback',
    expectedCurrent: { image: target.image, sourceRevision: target.sourceRevision } };
  const result = await executeFoundationOwnerRelease({
    body, trustedPublicKeySpkiBase64: signed.trustedPublicKeySpkiBase64,
    kubernetesRequest: async (method, requestPath, patch) => {
      if (requestPath === REGISTRATION_PATH) return { ok: true, status: 200, body: mainRegistration() };
      if (method === 'PATCH') current = deployment(previous);
      return { ok: true, status: 200, body: current };
    },
    fetchManifest: async () => ({ sourceRevision: previous.sourceRevision, actions: [] }),
    sleep: async () => {}, timeoutMs: 1000,
  });
  assert.equal(result.state, 'RolledBack');
  const unfenced = deployment(target);
  await assert.rejects(executeFoundationOwnerRelease({
    body, trustedPublicKeySpkiBase64: signed.trustedPublicKeySpkiBase64,
    kubernetesRequest: async (method, requestPath) => ({ ok: true, status: 200,
      body: requestPath === REGISTRATION_PATH ? mainRegistration() : unfenced }),
    fetchManifest: async () => ({}), sleep: async () => {}, timeoutMs: 1000,
  }), /RollbackFenceLost/);
});

test('Backend submits Gitea intent while a closed reconciler Job owns workload mutation', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  const deployYaml = fs.readFileSync(path.join(__dirname, 'deploy.yaml'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(dockerfile, /COPY opensphere-console-backend\/foundation-owner-release\.js/);
  assert.match(dockerfile, /foundation-owner-release-reconciler\.js/);
  assert.match(dockerfile, /foundation-owner-release-executor\.mjs/);
  assert.match(server, /consumerId: FOUNDATION_OWNER_RELEASE_CONSUMER/);
  assert.match(server, /governedChange\(actor/);
  assert.match(deployYaml, /resourceNames:\s*\["foundation-oaa-owner"\]/);
  assert.match(deployYaml, /foundation-owner-installation-lock/);
  assert.match(deployYaml, /foundation-owner-release-executor\.mjs/);
  const backendBoundary = deployYaml.match(/name: opensphere-console-backend-foundation-owner-release[\s\S]*?---/)[0];
  assert.doesNotMatch(backendBoundary, /resources:\s*\["deployments"\]/);
});
