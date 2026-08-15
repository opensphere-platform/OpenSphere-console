'use strict';

const crypto = require('node:crypto');

const CONTRACT = 'opensphere-foundation-owner-release/v1';
const DESIRED_STATE_CONTRACT = 'opensphere.foundation.owner.release/v1';
const FOUNDATION_OWNER_RELEASE_CONSUMER = 'foundation-owner-release';
const FOUNDATION_OWNER_RELEASE_RECONCILER = 'foundation-owner-release-reconciler';
const FOUNDATION_OWNER_RELEASE_TARGET = 'foundation-oaa-owner';
const PUBLICATION_CONTRACT = 'opensphere-local-edge-module-publication/v1';
const SIGNATURE_CONTRACT = 'opensphere-edge-detached-signature/v1';
const KEY_ID = 'opensphere-edge-local-v1';
const TRUST_REFERENCE = 'configmap://opensphere-console/dupa-trusted-keys#opensphere-edge-local-v1';
const REPOSITORY = 'ghcr.io/opensphere-platform/opensphere-shell-foundation';
const SOURCE_REPOSITORY = 'https://github.com/opensphere-platform/OpenSphere-shell-foundation.git';
const DEPLOYMENT_PATH = '/apis/apps/v1/namespaces/opensphere-console/deployments/foundation-oaa-owner';
const REGISTRATION_PATH = '/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginregistrations/foundation';
const MANIFEST_URL = 'http://foundation-oaa-owner.opensphere-console.svc.cluster.local:8080/cli/manifest';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const IMAGE_RE = /^ghcr\.io\/opensphere-platform\/opensphere-shell-foundation@sha256:[a-f0-9]{64}$/;
const SHA_RE = /^sha256:[a-f0-9]{64}$/;
const BLOB_RE = /^[a-f0-9]{40,64}$/;
const CANONICAL_ACTIONS = [
  'capability.read', 'readiness.read', 'catalog.read', 'cluster.plan',
  'cluster.create', 'cluster.status', 'operation.watch',
];
const CANONICAL_BINDINGS = Object.freeze({
  'capability.read': { toolId: 'foundation.capabilities', method: 'GET', path: '/api/foundation/oaa/postgres/capabilities' },
  'readiness.read': { toolId: 'foundation.readiness', method: 'GET', path: '/api/foundation/oaa/postgres/readiness' },
  'catalog.read': { toolId: 'foundation.postgres.catalog', method: 'GET', path: '/api/foundation/oaa/postgres/catalog' },
  'cluster.plan': { toolId: 'foundation.postgres.plan.create', method: 'POST', path: '/api/foundation/oaa/postgres/durable-plan' },
  'cluster.create': { toolId: 'foundation.postgres.apply', method: 'POST', path: '/api/foundation/oaa/postgres/durable-apply/{planId}', pathParams: ['planId'], approval: 'exact-confirmation' },
  'cluster.status': { toolId: 'foundation.postgres.status', method: 'GET', path: '/api/foundation/oaa/postgres/claims/{namespace}/{name}', pathParams: ['namespace', 'name'] },
  'operation.watch': { toolId: 'foundation.operation.watch', method: 'GET', path: '/api/foundation/oaa/operations/{operationId}', pathParams: ['operationId'] },
});

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} is outside the closed contract`);
  }
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

function canonicalBase64Url(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} is not canonical base64url`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error(`${label} is not canonical base64url`);
  return bytes;
}

function parsePublication(documentBytes) {
  let value;
  try { value = JSON.parse(documentBytes.toString('utf8')); }
  catch { throw new Error('publication document is not valid UTF-8 JSON'); }
  exactKeys(value, [
    'affectedImages', 'buildAuthority', 'changedPaths', 'channel', 'contract', 'fullReleaseJustification',
    'gaPromotionEligible', 'generatedAt', 'module', 'platform', 'previous', 'releaseScope', 'requestIntent',
    'previousOwner', 'sourceRepository', 'sourceUpstreamRef', 'tooling',
  ], 'publication document');
  exactKeys(value.module, [
    'compatibilityVersion', 'descriptorSha256', 'descriptorSignatureSha256', 'digest', 'id',
    'image', 'kind', 'moduleKeyId', 'releaseTag', 'repository', 'sourceRevision',
  ], 'publication module');
  exactKeys(value.previous, [
    'buildAuthority', 'digest', 'image', 'phase', 'repository', 'signatureIdentity',
    'source', 'sourceRevision', 'workloadPhase',
  ], 'publication previous release');
  exactKeys(value.previousOwner, ['digest', 'image', 'releaseTag', 'sourceRevision'],
    'publication previous owner release');
  exactKeys(value.tooling, [
    'cliArtifact', 'cliVerifier', 'consoleSourceRevision', 'consoleUpstreamRef', 'deployer', 'initializer',
    'inventory', 'platformSourceRevision', 'platformUpstreamRef', 'publisher',
    'sdkPackageLockSha256', 'sdkRepository', 'sdkSourceRevision', 'sdkUpstreamRef', 'signingHelper',
  ], 'publication tooling');
  for (const key of ['publisher', 'deployer', 'signingHelper', 'initializer', 'inventory', 'cliVerifier']) {
    exactKeys(value.tooling[key], ['gitBlob', 'path', 'sha256'], `publication tooling ${key}`);
  }
  exactKeys(value.tooling.cliArtifact, [
    'artifactImagePath', 'artifactSize', 'contract', 'deploymentDigest', 'deploymentGeneration',
    'deploymentImage', 'deploymentResourceVersion', 'deploymentUid', 'localImageId', 'manifestImagePath',
    'manifestSha256', 'manifestSignatureAlgorithm', 'manifestSignatureKeyId',
    'manifestSignaturePublicKeySpkiSha256', 'manifestUrl', 'path', 'runtimeImageId', 'sha256',
    'sourceRevision', 'version',
  ], 'publication cli artifact');
  if (value.contract !== PUBLICATION_CONTRACT || value.channel !== 'edge'
    || value.releaseScope !== 'component' || value.buildAuthority !== 'localhost'
    || value.gaPromotionEligible !== false || value.platform !== 'linux/amd64'
    || value.sourceRepository !== SOURCE_REPOSITORY
    || value.sourceUpstreamRef !== 'origin/main'
    || typeof value.requestIntent !== 'string' || value.requestIntent.trim().length < 8
    || value.requestIntent.length > 500 || value.fullReleaseJustification !== null
    || !Array.isArray(value.changedPaths) || value.changedPaths.length < 1
    || value.changedPaths.some((entry) => typeof entry !== 'string' || !entry
      || /^(?:[A-Za-z]:|\/|\\)/.test(entry) || /(^|\/)\.\.(\/|$)/.test(entry))
    || [...value.changedPaths].sort().join('\n') !== value.changedPaths.join('\n')
    || new Set(value.changedPaths).size !== value.changedPaths.length
    || !Array.isArray(value.affectedImages) || value.affectedImages.length !== 1
    || value.affectedImages[0] !== 'foundation'
    || value.module.id !== 'foundation' || value.module.kind !== 'subShell'
    || value.module.repository !== REPOSITORY || !IMAGE_RE.test(value.module.image)
    || !DIGEST_RE.test(value.module.digest) || value.module.image !== `${REPOSITORY}@${value.module.digest}`
    || !REVISION_RE.test(value.module.sourceRevision)
    || !/^\d{12}$/.test(value.module.releaseTag)
    || !/^\d+\.\d+\.\d+$/.test(value.module.compatibilityVersion)
    || value.module.moduleKeyId !== KEY_ID
    || !DIGEST_RE.test(value.module.descriptorSha256)
    || !DIGEST_RE.test(value.module.descriptorSignatureSha256)
    || value.previous.repository !== REPOSITORY || !IMAGE_RE.test(value.previous.image)
    || !DIGEST_RE.test(value.previous.digest)
    || value.previous.image !== `${REPOSITORY}@${value.previous.digest}`
    || !REVISION_RE.test(value.previous.sourceRevision)
    || value.previous.buildAuthority !== 'localhost'
    || value.previous.signatureIdentity !== KEY_ID
    || value.previous.source !== SOURCE_REPOSITORY.replace(/\.git$/, '')
    || value.previous.phase !== 'Activated' || value.previous.workloadPhase !== 'Ready'
    || !IMAGE_RE.test(value.previousOwner.image) || !DIGEST_RE.test(value.previousOwner.digest)
    || value.previousOwner.image !== `${REPOSITORY}@${value.previousOwner.digest}`
    || !REVISION_RE.test(value.previousOwner.sourceRevision)
    || !/^\d{12}$/.test(value.previousOwner.releaseTag)
    || !REVISION_RE.test(value.tooling.platformSourceRevision)
    || !REVISION_RE.test(value.tooling.consoleSourceRevision)
    || !REVISION_RE.test(value.tooling.sdkSourceRevision)
    || value.tooling.platformUpstreamRef !== 'origin/main'
    || value.tooling.consoleUpstreamRef !== 'origin/main'
    || value.tooling.sdkUpstreamRef !== 'origin/main'
    || value.tooling.sdkRepository !== 'https://github.com/opensphere-platform/OpenSphere-SDK.git'
    || !SHA_RE.test(value.tooling.sdkPackageLockSha256)
    || ['publisher', 'deployer', 'signingHelper', 'initializer', 'inventory', 'cliVerifier'].some((key) => {
      const item = value.tooling[key];
      return typeof item.path !== 'string' || !item.path
        || /^(?:[A-Za-z]:|\/|\\)/.test(item.path) || /(^|\/)\.\.(\/|$)/.test(item.path)
        || !SHA_RE.test(item.sha256) || !BLOB_RE.test(item.gitBlob);
    })
    || value.tooling.publisher.path !== 'tools/release/Publish-LocalEdgeModule.ps1'
    || value.tooling.deployer.path !== 'tools/release/Deploy-LocalEdgeFoundation.ps1'
    || value.tooling.signingHelper.path !== 'scripts/os-shell-edge-signing.ps1'
    || value.tooling.initializer.path !== 'scripts/Initialize-FoundationOwnerInstallationLock.ps1'
    || value.tooling.inventory.path !== 'repository-inventory.json'
    || value.tooling.cliVerifier.path !== 'tools/release/verify-canonical-cli-artifact.mjs'
    || value.tooling.cliArtifact.contract !== 'opensphere-cli-image-artifact-evidence/v1'
    || typeof value.tooling.cliArtifact.path !== 'string'
    || !/^[A-Za-z]:\\.*\\OpenSphere\\bin\\os\.exe$/i.test(value.tooling.cliArtifact.path)
    || !SHA_RE.test(value.tooling.cliArtifact.sha256)
    || !/^\d+\.\d+\.\d+$/.test(value.tooling.cliArtifact.version)
    || value.tooling.cliArtifact.manifestUrl !== 'https://localhost:1114/api/cli/index.json'
    || !SHA_RE.test(value.tooling.cliArtifact.manifestSha256)
    || value.tooling.cliArtifact.manifestImagePath !== '/srv/index.json'
    || value.tooling.cliArtifact.artifactImagePath !== '/srv/opensphere-cli-windows-amd64.exe'
    || !Number.isSafeInteger(value.tooling.cliArtifact.artifactSize)
    || value.tooling.cliArtifact.artifactSize < 1 || value.tooling.cliArtifact.artifactSize > 100 * 1024 * 1024
    || value.tooling.cliArtifact.manifestSignatureAlgorithm !== 'Ed25519'
    || value.tooling.cliArtifact.manifestSignatureKeyId !== 'opensphere-cli-local-dev-v1'
    || value.tooling.cliArtifact.manifestSignaturePublicKeySpkiSha256
      !== 'sha256:76982788c0736b5f8dd759b88a6b6bf7de6e34650c7b37f329f26d8efe1d6768'
    || !/^ghcr\.io\/opensphere-platform\/opensphere-os-cli@sha256:[a-f0-9]{64}$/.test(value.tooling.cliArtifact.deploymentImage)
    || !DIGEST_RE.test(value.tooling.cliArtifact.deploymentDigest)
    || value.tooling.cliArtifact.deploymentImage
      !== `ghcr.io/opensphere-platform/opensphere-os-cli@${value.tooling.cliArtifact.deploymentDigest}`
    || !/^sha256:[a-f0-9]{64}$/.test(value.tooling.cliArtifact.localImageId)
    || !/^(?:docker-pullable:\/\/)?ghcr\.io\/opensphere-platform\/opensphere-os-cli@sha256:[a-f0-9]{64}$/.test(
      value.tooling.cliArtifact.runtimeImageId)
    || !value.tooling.cliArtifact.runtimeImageId.endsWith(`@${value.tooling.cliArtifact.deploymentDigest}`)
    || !REVISION_RE.test(value.tooling.cliArtifact.sourceRevision)
    || !/^[0-9a-f-]{36}$/.test(value.tooling.cliArtifact.deploymentUid)
    || !Number.isSafeInteger(value.tooling.cliArtifact.deploymentGeneration)
    || value.tooling.cliArtifact.deploymentGeneration < 1
    || !/^\d+$/.test(value.tooling.cliArtifact.deploymentResourceVersion)
    || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error('publication document is not a canonical Foundation local-edge component release');
  }
  return value;
}

function verifyEdgeSignedDocument({ publicationDocumentBase64, publicationSignature, trustedPublicKeySpkiBase64 }) {
  const documentBytes = canonicalBase64(publicationDocumentBase64, 'publicationDocumentBase64');
  exactKeys(publicationSignature, [
    'algorithm', 'contract', 'documentSha256', 'gaPromotionEligible', 'keyId',
    'publicKeySpkiSha256', 'releaseClass', 'signature', 'trustReference',
  ], 'publication signature');
  if (publicationSignature.contract !== SIGNATURE_CONTRACT
    || publicationSignature.algorithm !== 'ES256-P1363'
    || publicationSignature.keyId !== KEY_ID
    || publicationSignature.trustReference !== TRUST_REFERENCE
    || publicationSignature.releaseClass !== 'pre-ga'
    || publicationSignature.gaPromotionEligible !== false
    || publicationSignature.documentSha256 !== sha256(documentBytes)) {
    throw new Error('publication signature envelope is outside the Docker Desktop edge trust contract');
  }
  const spki = canonicalBase64(trustedPublicKeySpkiBase64, 'trusted public key');
  if (publicationSignature.publicKeySpkiSha256 !== sha256(spki)) {
    throw new Error('publication signature trusted key digest mismatch');
  }
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const curve = String(key.asymmetricKeyDetails?.namedCurve || '').toLowerCase();
  if (key.asymmetricKeyType !== 'ec' || !['prime256v1', 'p-256', 'secp256r1'].includes(curve)) {
    throw new Error('publication trust key is not P-256');
  }
  const signature = canonicalBase64Url(publicationSignature.signature, 'publication signature');
  if (signature.length !== 64 || !crypto.verify('sha256', documentBytes,
    { key, dsaEncoding: 'ieee-p1363' }, signature)) {
    throw new Error('publication signature verification failed');
  }
  let document;
  try { document = JSON.parse(documentBytes.toString('utf8')); }
  catch { throw new Error('publication document is not valid UTF-8 JSON'); }
  return {
    document,
    documentBytes,
    documentSha256: sha256(documentBytes),
    signatureSha256: sha256(Buffer.from(JSON.stringify(publicationSignature))),
    keyId: publicationSignature.keyId,
  };
}

function verifyFoundationPublication(input) {
  const verified = verifyEdgeSignedDocument(input);
  return {
    publication: parsePublication(verified.documentBytes),
    documentSha256: verified.documentSha256,
  };
}

function validateFoundationOwnerRequest(body) {
  exactKeys(body, [
    'action', 'expectedCurrent', 'operationId', 'publicationDocumentBase64', 'publicationSignature', 'reason',
  ], 'Foundation owner request');
  exactKeys(body.expectedCurrent, ['image', 'sourceRevision'], 'Foundation owner precondition');
  if (!['Apply', 'Rollback'].includes(body.action) || !UUID_RE.test(String(body.operationId || ''))
    || String(body.reason || '').trim().length < 8 || String(body.reason).length > 500
    || !IMAGE_RE.test(String(body.expectedCurrent.image || ''))
    || !REVISION_RE.test(String(body.expectedCurrent.sourceRevision || ''))) {
    throw new Error('Foundation owner request identity, reason, or precondition is invalid');
  }
  return body;
}

function validateFoundationOwnerDesiredState(value) {
  exactKeys(value, [
    'action', 'contract', 'expectedCurrent', 'operationId',
    'publicationDocumentBase64', 'publicationSignature', 'reason',
  ], 'Foundation owner desired state');
  if (value.contract !== DESIRED_STATE_CONTRACT || !['Apply', 'Rollback'].includes(value.action)) {
    throw new Error('Foundation owner desired state contract or action is invalid');
  }
  validateFoundationOwnerRequest({
    action: value.action,
    expectedCurrent: value.expectedCurrent,
    operationId: value.operationId,
    publicationDocumentBase64: value.publicationDocumentBase64,
    publicationSignature: value.publicationSignature,
    reason: value.reason,
  });
  return value;
}

function deploymentProjection(deployment) {
  if (deployment?.metadata?.name !== 'foundation-oaa-owner'
    || deployment?.metadata?.namespace !== 'opensphere-console') {
    throw new Error('Foundation owner Deployment identity mismatch');
  }
  const containers = deployment?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1 || containers[0]?.name !== 'owner') {
    throw new Error('Foundation owner Deployment container contract mismatch');
  }
  const annotations = deployment?.spec?.template?.metadata?.annotations || {};
  const appVersionEntries = (containers[0].env || []).map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry?.name === 'APP_VERSION');
  if (appVersionEntries.length !== 1 || typeof appVersionEntries[0].entry.value !== 'string') {
    throw new Error('Foundation owner Deployment APP_VERSION contract mismatch');
  }
  return {
    resourceVersion: String(deployment?.metadata?.resourceVersion || ''),
    uid: String(deployment?.metadata?.uid || ''),
    generation: Number(deployment?.metadata?.generation || 0),
    replicas: Number(deployment?.spec?.replicas || 0),
    image: String(containers[0].image || ''),
    sourceRevision: String(annotations['io.opensphere.source-revision'] || ''),
    releaseTag: String(annotations['io.opensphere.release-tag'] || ''),
    appVersion: String(appVersionEntries[0].entry.value || ''),
    appVersionIndex: appVersionEntries[0].index,
  };
}

function deploymentReady(deployment, expected) {
  const current = deploymentProjection(deployment);
  const status = deployment?.status || {};
  return current.image === expected.image && current.sourceRevision === expected.sourceRevision
    && current.releaseTag === expected.releaseTag && current.appVersion === expected.releaseTag
    && current.replicas === 2 && Number(status.observedGeneration || 0) >= current.generation
    && Number(status.updatedReplicas || 0) === 2 && Number(status.readyReplicas || 0) === 2
    && Number(status.availableReplicas || 0) === 2;
}

function mainRegistrationReady(registration, expected) {
  const status = registration?.status || {};
  return registration?.metadata?.name === 'foundation'
    && registration?.metadata?.namespace === 'opensphere-console'
    && registration?.spec?.desiredState === 'Enabled'
    && registration?.spec?.packageRef?.name === 'foundation'
    && status.currentDigest === expected.digest
    && status.currentRevision === expected.sourceRevision
    && status.currentRequestedRef === expected.image
    && status.currentBuildAuthority === 'localhost'
    && status.currentSignatureIdentity === KEY_ID
    && status.currentSource === SOURCE_REPOSITORY.replace(/\.git$/, '')
    && status.phase === 'Activated' && status.workload?.phase === 'Ready'
    && status.verification?.signature === 'Verified';
}

function foundationManifestProjection(manifest, expectedSourceRevision) {
  if (!manifest || manifest.kind !== 'OpenSphereCLICommandManifest' || manifest.schemaVersion !== 'v1'
    || manifest.capabilityId !== 'data.sql.postgres' || manifest.sourceRevision !== expectedSourceRevision
    || !REVISION_RE.test(String(manifest.sourceRevision || '')) || !Array.isArray(manifest.tools)
    || manifest.tools.length !== CANONICAL_ACTIONS.length) {
    throw new Error('Foundation manifest identity is outside the canonical contract');
  }
  const projection = manifest.tools.map((tool) => {
    const expected = CANONICAL_BINDINGS[tool?.actionId];
    if (!tool || !expected || tool.actionId !== tool.semanticIdentity?.actionId || tool.id !== expected.toolId
      || tool.id !== tool.semanticIdentity?.toolId
      || tool.capabilityId !== 'data.sql.postgres' || tool.semanticIdentity?.capabilityId !== 'data.sql.postgres'
      || tool.requestType !== 'Instance' || tool.semanticIdentity?.requestType !== 'Instance'
      || tool.contractVersion !== 'v1' || manifest.contractVersion !== 'v1'
      || tool.sourceRevision !== expectedSourceRevision || tool.webShell?.available !== true
      || typeof tool.actionBinding !== 'object') {
      throw new Error('Foundation manifest tool semantic identity is not canonical');
    }
    exactKeys(tool.semanticIdentity, ['actionId', 'capabilityId', 'requestType', 'toolId'], 'manifest semanticIdentity');
    const expectedBindingKeys = ['method', 'path', ...(expected.pathParams ? ['pathParams'] : []),
      ...(expected.approval ? ['approval'] : [])];
    exactKeys(tool.actionBinding, expectedBindingKeys, 'manifest actionBinding');
    if (tool.actionBinding.method !== expected.method || tool.actionBinding.path !== expected.path
      || JSON.stringify(tool.actionBinding.pathParams || []) !== JSON.stringify(expected.pathParams || [])
      || String(tool.actionBinding.approval || '') !== String(expected.approval || '')) {
      throw new Error('Foundation manifest action binding is not canonical');
    }
    return {
      actionId: tool.actionId, toolId: tool.id, capabilityId: tool.capabilityId,
      requestType: tool.requestType, contractVersion: tool.contractVersion,
      semanticIdentity: tool.semanticIdentity, actionBinding: tool.actionBinding,
    };
  });
  if (projection.map((entry) => entry.actionId).join(',') !== CANONICAL_ACTIONS.join(',')) {
    throw new Error('Foundation manifest action set or order is not canonical');
  }
  return projection;
}

function foundationManifestCapabilityDigest(manifest, expectedSourceRevision) {
  return sha256(Buffer.from(JSON.stringify(foundationManifestProjection(manifest, expectedSourceRevision))));
}

function annotationPath(name) {
  return `/spec/template/metadata/annotations/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function ownerPatch(current, target, releaseRecord = null) {
  const patch = [
    { op: 'test', path: '/metadata/resourceVersion', value: current.resourceVersion },
    { op: 'test', path: '/metadata/uid', value: current.uid },
    { op: 'test', path: '/spec/template/spec/containers/0/image', value: current.image },
    { op: 'test', path: '/spec/template/metadata/annotations/io.opensphere.source-revision', value: current.sourceRevision },
    { op: 'replace', path: '/spec/template/spec/containers/0/image', value: target.image },
    { op: 'replace', path: '/spec/template/metadata/annotations/io.opensphere.source-revision', value: target.sourceRevision },
    { op: 'replace', path: '/spec/template/metadata/annotations/io.opensphere.release-tag', value: target.releaseTag },
    { op: 'replace', path: `/spec/template/spec/containers/0/env/${current.appVersionIndex}/value`, value: target.releaseTag },
  ];
  if (releaseRecord) {
    for (const [name, value] of Object.entries(releaseRecord)) {
      patch.push({ op: 'add', path: annotationPath(name), value });
    }
  }
  return patch;
}

async function checkedKubernetes(request, method, path, body, contentType = 'application/json') {
  const response = await request(method, path, body, contentType);
  if (!response?.ok) {
    const error = new Error(response?.body?.message || `Kubernetes HTTP ${response?.status || 500}`);
    error.status = response?.status || 500;
    error.code = error.status;
    throw error;
  }
  return response.body;
}

async function waitForOwner({ kubernetesRequest, fetchManifest, expected, timeoutMs, sleep, requireWebShell = true }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'rollout has not started';
  while (Date.now() < deadline) {
    try {
      const deployment = await checkedKubernetes(kubernetesRequest, 'GET', DEPLOYMENT_PATH);
      if (deploymentReady(deployment, expected)) {
        const manifest = await fetchManifest(MANIFEST_URL);
        if (!requireWebShell && manifest?.sourceRevision === expected.sourceRevision) {
          return { deployment, manifest };
        }
        foundationManifestProjection(manifest, expected.sourceRevision);
        if (requireWebShell) return { deployment, manifest };
        last = 'owner manifest does not project the target source and Web Shell binding';
      } else last = 'owner Deployment rollout is incomplete';
    } catch (error) { last = String(error?.message || error); }
    await sleep(1000);
  }
  throw new Error(`Foundation owner verification timed out: ${last}`);
}

async function executeFoundationOwnerRelease(options) {
  const {
    body, trustedPublicKeySpkiBase64, kubernetesRequest, fetchManifest,
    timeoutMs = 180000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  validateFoundationOwnerRequest(body);
  const verified = verifyFoundationPublication({
    publicationDocumentBase64: body.publicationDocumentBase64,
    publicationSignature: body.publicationSignature,
    trustedPublicKeySpkiBase64,
  });
  const signedBase = body.action === 'Rollback' ? verified.publication.module : verified.publication.previousOwner;
  if (body.expectedCurrent.image !== signedBase.image
    || body.expectedCurrent.sourceRevision !== signedBase.sourceRevision) {
    const error = new Error('FoundationOwnerSignedBaseMismatch'); error.status = 409; error.code = 409; throw error;
  }
  const target = {
    image: verified.publication.module.image,
    digest: verified.publication.module.digest,
    sourceRevision: verified.publication.module.sourceRevision,
    releaseTag: verified.publication.module.releaseTag,
  };
  const mainRegistration = await checkedKubernetes(kubernetesRequest, 'GET', REGISTRATION_PATH);
  if (!mainRegistrationReady(mainRegistration, target)) {
    const error = new Error('FoundationMainReleaseNotReady'); error.status = 409; error.code = 409; throw error;
  }
  let deployment = await checkedKubernetes(kubernetesRequest, 'GET', DEPLOYMENT_PATH);
  let current = deploymentProjection(deployment);
  if (body.action === 'Rollback') {
    const annotations = deployment?.spec?.template?.metadata?.annotations || {};
    if (body.expectedCurrent.image !== target.image || body.expectedCurrent.sourceRevision !== target.sourceRevision
      || current.image !== target.image || current.sourceRevision !== target.sourceRevision
      || annotations['opensphere.io/foundation-owner-operation-id'] !== body.operationId
      || annotations['opensphere.io/foundation-owner-publication-sha256'] !== verified.documentSha256) {
      const error = new Error('FoundationOwnerRollbackFenceLost'); error.status = 409; error.code = 409; throw error;
    }
    const rollback = {
      image: String(annotations['opensphere.io/foundation-owner-previous-image'] || ''),
      sourceRevision: String(annotations['opensphere.io/foundation-owner-previous-source-revision'] || ''),
      releaseTag: String(annotations['opensphere.io/foundation-owner-previous-release-tag'] || ''),
    };
    if (!IMAGE_RE.test(rollback.image) || !REVISION_RE.test(rollback.sourceRevision)
      || !/^\d{12}$/.test(rollback.releaseTag)
      || rollback.image !== verified.publication.previousOwner.image
      || rollback.sourceRevision !== verified.publication.previousOwner.sourceRevision
      || rollback.releaseTag !== verified.publication.previousOwner.releaseTag) {
      const error = new Error('FoundationOwnerRollbackEvidenceInvalid'); error.status = 409; error.code = 409; throw error;
    }
    await checkedKubernetes(kubernetesRequest, 'PATCH', DEPLOYMENT_PATH,
      ownerPatch(current, rollback), 'application/json-patch+json');
    const observed = await waitForOwner({ kubernetesRequest, fetchManifest, expected: rollback,
      timeoutMs, sleep, requireWebShell: false });
    return {
      contract: CONTRACT, operationId: body.operationId, state: 'RolledBack', changed: true,
      publicationSha256: verified.documentSha256, target: rollback,
      previous: { image: target.image, sourceRevision: target.sourceRevision, releaseTag: target.releaseTag },
      observedGeneration: Number(observed.deployment.status.observedGeneration),
      manifestSourceRevision: observed.manifest.sourceRevision,
      manifest: observed.manifest,
    };
  }
  if (current.image === target.image && current.sourceRevision === target.sourceRevision) {
    const observed = await waitForOwner({ kubernetesRequest, fetchManifest, expected: target, timeoutMs, sleep });
    return {
      contract: CONTRACT, operationId: body.operationId, state: 'AlreadyCurrent', changed: false,
      publicationSha256: verified.documentSha256, target, previous: target,
      observedGeneration: Number(observed.deployment.status.observedGeneration),
      manifestSourceRevision: observed.manifest.sourceRevision,
      manifest: observed.manifest,
    };
  }
  if (current.image !== body.expectedCurrent.image || current.sourceRevision !== body.expectedCurrent.sourceRevision) {
    const error = new Error('FoundationOwnerReleasePreconditionFailed'); error.status = 409; error.code = 409; throw error;
  }
  const previous = { image: current.image, sourceRevision: current.sourceRevision,
    releaseTag: current.releaseTag, appVersion: current.appVersion };
  try {
    deployment = await checkedKubernetes(kubernetesRequest, 'PATCH', DEPLOYMENT_PATH,
      ownerPatch(current, target, {
        'opensphere.io/foundation-owner-operation-id': body.operationId,
        'opensphere.io/foundation-owner-publication-sha256': verified.documentSha256,
        'opensphere.io/foundation-owner-previous-image': previous.image,
        'opensphere.io/foundation-owner-previous-source-revision': previous.sourceRevision,
        'opensphere.io/foundation-owner-previous-release-tag': previous.releaseTag || previous.appVersion,
      }), 'application/json-patch+json');
    const observed = await waitForOwner({ kubernetesRequest, fetchManifest, expected: target, timeoutMs, sleep });
    return {
      contract: CONTRACT, operationId: body.operationId, state: 'Applied', changed: true,
      publicationSha256: verified.documentSha256, target, previous,
      observedGeneration: Number(observed.deployment.status.observedGeneration),
      manifestSourceRevision: observed.manifest.sourceRevision,
      manifest: observed.manifest,
    };
  } catch (applyError) {
    try {
      deployment = await checkedKubernetes(kubernetesRequest, 'GET', DEPLOYMENT_PATH);
      current = deploymentProjection(deployment);
      if (current.image === target.image && current.sourceRevision === target.sourceRevision) {
        const rollback = { image: previous.image, sourceRevision: previous.sourceRevision,
          releaseTag: previous.releaseTag || previous.appVersion };
        await checkedKubernetes(kubernetesRequest, 'PATCH', DEPLOYMENT_PATH,
          ownerPatch(current, rollback), 'application/json-patch+json');
        await waitForOwner({ kubernetesRequest, fetchManifest, expected: rollback, timeoutMs, sleep, requireWebShell: false });
      }
    } catch (rollbackError) {
      const error = new Error(`Foundation owner apply failed and rollback did not converge: ${applyError.message}; ${rollbackError.message}`);
      error.status = 500; error.code = 500; throw error;
    }
    const error = new Error(`Foundation owner apply failed and was rolled back: ${applyError.message}`);
    error.status = 502; error.code = 502; throw error;
  }
}

module.exports = {
  CONTRACT,
  DESIRED_STATE_CONTRACT,
  FOUNDATION_OWNER_RELEASE_CONSUMER,
  FOUNDATION_OWNER_RELEASE_RECONCILER,
  FOUNDATION_OWNER_RELEASE_TARGET,
  DEPLOYMENT_PATH,
  REGISTRATION_PATH,
  MANIFEST_URL,
  deploymentProjection,
  deploymentReady,
  executeFoundationOwnerRelease,
  foundationManifestCapabilityDigest,
  foundationManifestProjection,
  mainRegistrationReady,
  ownerPatch,
  parsePublication,
  validateFoundationOwnerRequest,
  validateFoundationOwnerDesiredState,
  verifyFoundationPublication,
  verifyEdgeSignedDocument,
};
