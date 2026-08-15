'use strict';

const { createHash } = require('crypto');

const PLATFORM_RELEASE_CONSUMER = 'platform-release';
const PLATFORM_RELEASE_RECONCILER = 'platform-release-reconciler';
const PLATFORM_RELEASE_TARGET = 'opensphere-platform';
const PLATFORM_RELEASE_CONTRACT = 'opensphere.platform.release/v1';
const RELEASE_LOCK_API_VERSION = 'release.opensphere.io/v1alpha1';
const RELEASE_LOCK_KIND = 'OpenSphereReleaseLock';
const RELEASE_SCOPE_INTEGRATED = 'integrated';
const RELEASE_SCOPE_COMPONENT = 'component';
const COMPONENT_PUBLICATION_BINDING_CONTRACT = 'opensphere-edge-component-publication-binding/v1';
const COMPONENT_PUBLICATION_KIND = 'OpenSphereEdgeComponentPublication';
const BACKEND_BOOTSTRAP_A_PUBLICATION_KIND = 'OpenSphereBackendComponentBootstrapAPublication';
const BACKEND_BOOTSTRAP_A_PUBLICATION_CONTRACT =
  'opensphere-backend-component-bootstrap-a-publication/v1';
const COMPONENT_PUBLISHER = 'scripts/Publish-LocalEdgeBackendComponent.ps1';
const BACKEND_BOOTSTRAP_A_VALIDATOR =
  'backend/opensphere-console-backend/platform-release-contract.js';
const BACKEND_BOOTSTRAP_CONTRACT = 'opensphere-backend-component-bootstrap/v1';
const BACKEND_VERIFICATION_SET_CONTRACT = 'opensphere-backend-component-verification-set/v1';
const EDGE_KEY_ID = 'opensphere-edge-local-v1';
const REQUIRED_BACKEND_VERIFICATION_IDS = Object.freeze([
  'console-full-test',
  'console-test',
  'fresh-ledger-verifier',
  'rendered-manifest-client-dry-run',
  'rendered-manifest-server-dry-run',
  'setup-full-test',
  'setup-test',
]);
const REQUIRED_BACKEND_BOOTSTRAP_A_VERIFICATION_IDS = Object.freeze([
  ...REQUIRED_BACKEND_VERIFICATION_IDS,
  'bootstrap-a-invoke-fixture',
].sort());
const BACKEND_BOOTSTRAP_A_CHANGED_PATHS = Object.freeze(new Set([
  'backend/opensphere-console-backend/Dockerfile',
  'backend/opensphere-console-backend/deploy.yaml',
  'backend/opensphere-console-backend/local-edge-automation-token.js',
  'backend/opensphere-console-backend/local-edge-automation-token.test.js',
  'backend/opensphere-console-backend/platform-release-contract.js',
  'backend/opensphere-console-backend/platform-release-admission.test.js',
  'backend/opensphere-console-backend/platform-release-executor.mjs',
  'backend/opensphere-console-backend/platform-release-internal-transport.js',
  'backend/opensphere-console-backend/platform-release-internal-transport.test.js',
  'backend/opensphere-console-backend/platform-release-manifest-projection.js',
  'backend/opensphere-console-backend/platform-release-manifest-projection.test.js',
  'backend/opensphere-console-backend/platform-release-reconciler.js',
  'backend/opensphere-console-backend/platform-release-tls-initializer.mjs',
  'backend/opensphere-console-backend/platform-release-tls-initializer.test.mjs',
  'backend/opensphere-console-backend/platform-release.test.js',
  'backend/opensphere-console-backend/platform-release-bootstrap-cross-version.test.js',
  'backend/opensphere-console-backend/foundation-owner-release.test.js',
  'backend/opensphere-console-backend/server.js',
  'backend/opensphere-console-backend/setup-source.lock',
  'scripts/Invoke-LocalEdgePlatformRelease.ps1',
  'scripts/Publish-LocalEdgeBackendComponent.ps1',
  'scripts/backend-bootstrap-a-invoke-fixture.test.ps1',
  'scripts/backend-component-workflow.test.mjs',
  'package.json',
]));
const BACKEND_BOOTSTRAP_A_SETUP_PATHS = Object.freeze(new Set([
  'src/bootstrap.mjs', 'src/release.mjs', 'src/verify.mjs',
  'src/New-PlatformReleaseAuthorityCertificates.ps1', 'src/platform-release-authority-tls.mjs',
  'src/platform-release-bootstrap-cleanup.mjs',
  'src/platform-release-bootstrap-manifest.mjs',
  'test/base-runtime.test.mjs', 'test/release.test.mjs', 'test/upgrade.test.mjs',
  'test/platform-release-authority-tls.test.mjs',
  'test/platform-release-bootstrap-cleanup.test.mjs',
  'test/platform-release-bootstrap-manifest.test.mjs',
]));
const BACKEND_COMPONENT_SETUP_PATHS = BACKEND_BOOTSTRAP_A_SETUP_PATHS;
const APPROVAL_MODE_LOCAL_EDGE_AUTOMATION = 'local-edge-automation';
const APPROVAL_MODE_CROSS_OPERATOR = 'cross-operator';
// Setup is the installer authority. Its transactional bootstrap currently
// permits edge only; candidate/stable remain blocked until the integrated
// recovery drill is implemented. Accepting those locks here would expose a
// Console control that the executor can never carry to completion.
const RELEASE_CHANNELS = Object.freeze(['edge']);
const RELEASE_BOM_PREDICATE = 'https://opensphere.io/attestations/release-bom/v1';
const LOCAL_EDGE_TRUST = Object.freeze({
  type: 'localhost-edge/v1',
  repository: 'opensphere-platform/OpenSphere-console',
  publisher: 'scripts/Publish-LocalEdge.ps1',
  buildAuthority: 'localhost',
  releaseClass: 'pre-ga',
  gaEligible: false,
});
const RELEASE_TRUST = Object.freeze({
  type: 'github-actions-attestation/v2',
  repository: 'opensphere-platform/OpenSphere-console',
  signerWorkflow: 'opensphere-platform/OpenSphere-console/.github/workflows/publish-ga-images.yml',
  oidcIssuer: 'https://token.actions.githubusercontent.com',
  sourceRef: 'refs/heads/main',
  provenancePredicate: 'https://slsa.dev/provenance/v1',
  sbomPredicate: 'https://spdx.dev/Document/v2.3',
});
const COMPONENT_REPOSITORIES = Object.freeze({
  console: 'opensphere-console',
  backend: 'opensphere-console-backend',
  dupaController: 'opensphere-console-dupa-controller',
  oaaGateway: 'opensphere-console-oaa-gateway',
  oaaGovernedAdapter: 'opensphere-oaa-governed-adapter',
  notificationDispatcher: 'opensphere-console-notification-dispatcher',
  gitea: 'opensphere-console-gitea',
  supabasePostgres: 'opensphere-console-supabase-postgres',
  supabaseAuth: 'opensphere-console-supabase-auth',
  supabaseRest: 'opensphere-console-supabase-rest',
  supabaseStorage: 'opensphere-console-supabase-storage',
  giteaPostgres: 'opensphere-console-gitea-postgres',
  recovery: 'opensphere-console-recovery',
});
const REQUIRED_COMPONENTS = Object.freeze(Object.keys(COMPONENT_REPOSITORIES));
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const IMAGE_RE =
  /^ghcr\.io\/opensphere-platform\/([a-z0-9][a-z0-9-]*)@sha256:[a-f0-9]{64}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function calculateReleaseDigest(lock) {
  // This intentionally mirrors OpenSphere-Setup-CLI/src/release.mjs. The
  // executor repeats the authoritative validation before mutating the cluster.
  const payload = JSON.stringify({
    channel: lock.channel,
    components: lock.components,
    trust: lock.trust,
    ...(lock.releaseBom ? { releaseBom: lock.releaseBom } : {}),
    ...(lock.releaseScope ? { releaseScope: lock.releaseScope } : {}),
    ...(lock.baseReleaseDigest ? { baseReleaseDigest: lock.baseReleaseDigest } : {}),
    ...(lock.changedComponents ? { changedComponents: lock.changedComponents } : {}),
    ...(lock.componentPublication ? { componentPublication: lock.componentPublication } : {}),
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function assertClosedObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function validateReleaseLock(lock, { allowUnsignedComponentBootstrapBase = false } = {}) {
  assertClosedObject(lock, [
    'apiVersion', 'kind', 'channel', 'releaseDigest', 'resolvedAt', 'source',
    'sourceRevision', 'trust', 'releaseBom', 'components',
    'releaseScope', 'baseReleaseDigest', 'changedComponents', 'componentPublication',
    'provenanceVerifiedAt', 'sbomVerifiedAt',
  ], 'targetLock');
  if (lock.apiVersion !== RELEASE_LOCK_API_VERSION || lock.kind !== RELEASE_LOCK_KIND) {
    throw new Error('targetLock is not an OpenSphere release lock');
  }
  if (!RELEASE_CHANNELS.includes(lock.channel)) throw new Error('targetLock channel is unsupported');
  if (!SHA256_RE.test(String(lock.releaseDigest || ''))) throw new Error('targetLock releaseDigest is invalid');
  if (lock.source !== 'https://github.com/opensphere-platform/OpenSphere-console') {
    throw new Error('targetLock source is outside the canonical Console repository');
  }
  if (!REVISION_RE.test(String(lock.sourceRevision || ''))) throw new Error('targetLock sourceRevision is invalid');
  assertClosedObject(lock.trust, [
    'type', 'repository', 'publisher', 'buildAuthority', 'releaseClass', 'gaEligible',
    'signerWorkflow', 'oidcIssuer', 'sourceRef', 'provenancePredicate', 'sbomPredicate',
  ], 'targetLock.trust');
  const localEdge = canonicalJson(lock.trust) === canonicalJson(LOCAL_EDGE_TRUST);
  const signedRelease = canonicalJson(lock.trust) === canonicalJson(RELEASE_TRUST);
  if (!localEdge && !signedRelease) {
    throw new Error('targetLock trust root is not canonical');
  }
  if ((lock.channel === 'edge' && !localEdge)
    || (lock.channel !== 'edge' && !signedRelease)) {
    throw new Error('targetLock channel and build authority do not match');
  }
  if (lock.releaseBom !== undefined) {
    assertClosedObject(lock.releaseBom, ['subject', 'digest', 'predicateType'], 'targetLock.releaseBom');
    if (!IMAGE_RE.test(String(lock.releaseBom.subject || ''))
      || !SHA256_RE.test(String(lock.releaseBom.digest || ''))
      || lock.releaseBom.predicateType !== RELEASE_BOM_PREDICATE) {
      throw new Error('targetLock releaseBom pointer is invalid');
    }
  }
  if (localEdge && lock.releaseBom !== undefined) {
    throw new Error('local edge targetLock cannot claim a signed Release BOM');
  }
  if (signedRelease && lock.releaseBom === undefined) {
    throw new Error('candidate and stable targetLock require a signed Release BOM');
  }
  const releaseScope = lock.releaseScope || RELEASE_SCOPE_INTEGRATED;
  if (![RELEASE_SCOPE_INTEGRATED, RELEASE_SCOPE_COMPONENT].includes(releaseScope)) {
    throw new Error('targetLock releaseScope is unsupported');
  }
  if (releaseScope === RELEASE_SCOPE_INTEGRATED
    && (lock.baseReleaseDigest !== undefined || lock.changedComponents !== undefined
      || lock.componentPublication !== undefined)) {
    throw new Error('integrated targetLock cannot declare a component transition');
  }
  if (releaseScope === RELEASE_SCOPE_COMPONENT) {
    if (!localEdge || lock.channel !== 'edge') {
      throw new Error('component targetLock requires localhost edge trust');
    }
    if (!SHA256_RE.test(String(lock.baseReleaseDigest || ''))) {
      throw new Error('component targetLock baseReleaseDigest is invalid');
    }
    const changed = lock.changedComponents;
    const canonicalChanged = Array.isArray(changed) ? [...new Set(changed)].sort() : [];
    if (!Array.isArray(changed)
      || changed.length === 0
      || changed.length !== canonicalChanged.length
      || changed.some((name, index) => name !== canonicalChanged[index])
      || changed.some((name) => !REQUIRED_COMPONENTS.includes(name))) {
      throw new Error('component targetLock changedComponents must be a non-empty canonical sorted set');
    }
    if (lock.releaseBom !== undefined) {
      throw new Error('component targetLock cannot claim a signed Release BOM');
    }
    if (lock.componentPublication === undefined) {
      if (!allowUnsignedComponentBootstrapBase
        || canonicalJson(lock.changedComponents) !== canonicalJson(['backend'])) {
        throw new Error('component targetLock requires a signed component publication binding');
      }
    } else {
      validateComponentPublicationBinding(lock.componentPublication);
    }
  }
  assertClosedObject(lock.components, REQUIRED_COMPONENTS, 'targetLock.components');
  const names = Object.keys(lock.components).sort();
  if (names.length !== REQUIRED_COMPONENTS.length
    || names.some((name, index) => name !== [...REQUIRED_COMPONENTS].sort()[index])) {
    throw new Error('targetLock component set is incomplete or unsupported');
  }
  for (const name of REQUIRED_COMPONENTS) {
    const component = lock.components[name];
    assertClosedObject(component, [
      'repository', 'image', 'sourceRevision', 'registryCredentialsRequired',
    ], `targetLock.components.${name}`);
    const image = String(component.image || '');
    const match = image.match(IMAGE_RE);
    if (!match || component.repository !== match[1]
      || component.repository !== COMPONENT_REPOSITORIES[name]) {
      throw new Error(`targetLock component ${name} is not a canonical exact-digest image`);
    }
    if (!REVISION_RE.test(String(component.sourceRevision || ''))) {
      throw new Error(`targetLock component ${name} sourceRevision is invalid`);
    }
    if (releaseScope === RELEASE_SCOPE_INTEGRATED
      && component.sourceRevision !== lock.sourceRevision) {
      throw new Error(`targetLock component ${name} sourceRevision differs from the release`);
    }
    if (releaseScope === RELEASE_SCOPE_COMPONENT
      && lock.changedComponents.includes(name)
      && component.sourceRevision !== lock.sourceRevision) {
      throw new Error(`targetLock changed component ${name} sourceRevision differs from the component release`);
    }
    if (component.registryCredentialsRequired !== undefined
      && typeof component.registryCredentialsRequired !== 'boolean') {
      throw new Error(`targetLock component ${name} registry credential flag is invalid`);
    }
  }
  if (lock.releaseBom !== undefined
    && lock.releaseBom.subject !== lock.components.console.image) {
    throw new Error('targetLock releaseBom subject is not the Console anchor');
  }
  if (calculateReleaseDigest(lock) !== lock.releaseDigest) {
    throw new Error('targetLock releaseDigest does not match its component set and trust root');
  }
  return lock;
}

function validateComponentPublicationBinding(value) {
  assertClosedObject(value, [
    'contract', 'publisher', 'publisherGitBlob', 'publisherSha256', 'documentSha256',
    'signatureSha256', 'keyId', 'setupSourceRevision', 'setupSourceLockSha256',
    'setupManifestProjectionGitBlob', 'setupManifestProjectionSha256', 'migrationSetDigest',
    'platformRevision', 'inventorySha256', 'verificationSetDigest',
    'bootstrapFrom',
  ], 'targetLock.componentPublication');
  if (value.contract !== COMPONENT_PUBLICATION_BINDING_CONTRACT
    || value.publisher !== COMPONENT_PUBLISHER
    || !/^[a-f0-9]{40,64}$/.test(String(value.publisherGitBlob || ''))
    || !SHA256_RE.test(String(value.publisherSha256 || ''))
    || !SHA256_RE.test(String(value.documentSha256 || ''))
    || !SHA256_RE.test(String(value.signatureSha256 || ''))
    || value.keyId !== EDGE_KEY_ID
    || !REVISION_RE.test(String(value.setupSourceRevision || ''))
    || !SHA256_RE.test(String(value.setupSourceLockSha256 || ''))
    || !/^[a-f0-9]{40,64}$/.test(String(value.setupManifestProjectionGitBlob || ''))
    || !SHA256_RE.test(String(value.setupManifestProjectionSha256 || ''))
    || !SHA256_RE.test(String(value.migrationSetDigest || ''))
    || !REVISION_RE.test(String(value.platformRevision || ''))
    || !SHA256_RE.test(String(value.inventorySha256 || ''))
    || !SHA256_RE.test(String(value.verificationSetDigest || ''))) {
    throw new Error('targetLock component publication binding is invalid');
  }
  if (value.bootstrapFrom !== undefined) validateBackendBootstrapFrom(value.bootstrapFrom);
  return value;
}

function validateBackendBootstrapFrom(value) {
  assertClosedObject(value, [
    'contract', 'requestId', 'releaseDigest', 'sourceRevision', 'image', 'mergeRevision',
    'receiptOperationId', 'governedDocumentSha256', 'receiptSha256', 'handoffState',
    'convergenceState', 'foundationFeatureGate', 'trustConfigUid',
    'trustConfigResourceVersion', 'trustKeySpkiSha256',
  ], 'Backend component publication bootstrapFrom');
  if (value.contract !== BACKEND_BOOTSTRAP_CONTRACT
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(value.requestId || ''))
    || !SHA256_RE.test(String(value.releaseDigest || ''))
    || !REVISION_RE.test(String(value.sourceRevision || ''))
    || !IMAGE_RE.test(String(value.image || ''))
    || !value.image.includes('/opensphere-console-backend@')
    || !/^[a-f0-9]{40,64}$/.test(String(value.mergeRevision || ''))
    || !/^[A-Za-z0-9:._-]{8,255}$/.test(String(value.receiptOperationId || ''))
    || !SHA256_RE.test(String(value.governedDocumentSha256 || ''))
    || !SHA256_RE.test(String(value.receiptSha256 || ''))
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(String(value.trustConfigUid || ''))
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(value.trustConfigResourceVersion || ''))
    || !SHA256_RE.test(String(value.trustKeySpkiSha256 || ''))
    || value.handoffState !== 'BootstrapApplied'
    || value.convergenceState !== 'PendingConvergence'
    || value.foundationFeatureGate !== 'Closed') {
    throw new Error('Backend component publication bootstrapFrom is invalid');
  }
  return value;
}

function validateBootstrapAInitializerCleanup(value, { bootstrapFrom, targetReleaseDigest } = {}) {
  assertClosedObject(value, [
    'bootstrapRequestId', 'bootstrapSourceRevision', 'cleanupSetDigest', 'completedAt', 'contract',
    'deletedResources', 'journalCustody', 'journalResourceVersion', 'journalSha256', 'journalUid',
    'residueCount', 'retainedAuthority', 'targetReleaseDigest',
  ], 'Backend Bootstrap A initializer cleanup proof');
  if (!bootstrapFrom || value.contract !== 'opensphere-bootstrap-a-initializer-cleanup/v1'
    || value.bootstrapRequestId !== bootstrapFrom.requestId
    || value.bootstrapSourceRevision !== bootstrapFrom.sourceRevision
    || value.targetReleaseDigest !== targetReleaseDigest
    || !SHA256_RE.test(String(value.cleanupSetDigest || ''))
    || !SHA256_RE.test(String(value.journalSha256 || ''))
    || !/^[0-9a-f-]{36}$/i.test(String(value.journalUid || ''))
    || !/^\d+$/.test(String(value.journalResourceVersion || ''))
    || value.residueCount !== 0
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(value.completedAt || ''))
    || !Number.isFinite(Date.parse(value.completedAt))) {
    throw new Error('Backend Bootstrap A initializer cleanup transaction binding is invalid');
  }
  const sourceRevision = bootstrapFrom.sourceRevision;
  const expectedResources = [
    ['batch/v1', 'Job', 'opensphere-console', `opensphere-tls-init-${sourceRevision}`],
    ['v1', 'ServiceAccount', 'opensphere-console', 'platform-release-tls-initializer'],
    ['rbac.authorization.k8s.io/v1', 'Role', 'opensphere-console', 'platform-release-tls-initializer'],
    ['rbac.authorization.k8s.io/v1', 'RoleBinding', 'opensphere-console', 'platform-release-tls-initializer'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-custody'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-custody'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-job-boundary'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-job-boundary'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '',
      'platform-release-tls-initializer-pod-boundary'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '',
      'platform-release-tls-initializer-pod-boundary'],
    ['networking.k8s.io/v1', 'NetworkPolicy', 'opensphere-console',
      'platform-release-tls-initializer'],
  ].map(([apiVersion, kind, namespace, name]) => ({ apiVersion, kind, namespace, name }));
  if (!Array.isArray(value.deletedResources) || value.deletedResources.length !== expectedResources.length) {
    throw new Error('Backend Bootstrap A initializer cleanup resource set is incomplete');
  }
  const identities = value.deletedResources.map((entry) => {
    assertClosedObject(entry, ['apiVersion', 'kind', 'name', 'namespace', 'resourceVersion', 'uid'],
      'Backend Bootstrap A initializer cleanup resource identity');
    if (!/^[0-9a-f-]{36}$/i.test(String(entry.uid || ''))
      || !/^\d+$/.test(String(entry.resourceVersion || ''))) {
      throw new Error('Backend Bootstrap A initializer cleanup resource identity is invalid');
    }
    return { apiVersion: entry.apiVersion, kind: entry.kind, namespace: entry.namespace, name: entry.name };
  });
  const sortCanonical = (items) => [...items].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
  if (canonicalJson(identities) !== canonicalJson(sortCanonical(expectedResources))
    || canonicalJson(value.deletedResources) !== canonicalJson(sortCanonical(value.deletedResources))
    || value.cleanupSetDigest !== `sha256:${createHash('sha256')
      .update(canonicalJson(value.deletedResources)).digest('hex')}`) {
    throw new Error('Backend Bootstrap A initializer cleanup resource set or digest is invalid');
  }
  assertClosedObject(value.retainedAuthority, [
    'caCertSha256', 'caConfigMapResourceVersion', 'caConfigMapUid', 'contract',
    'secretResourceVersion', 'secretUid', 'serviceCustodyBindingResourceVersion',
    'serviceCustodyBindingUid', 'serviceCustodyPolicyResourceVersion', 'serviceCustodyPolicyUid',
    'serviceResourceVersion', 'serviceUid', 'tlsCertSha256',
  ], 'Backend Bootstrap A retained TLS authority proof');
  if (value.retainedAuthority.contract !== 'opensphere-platform-release-authority-retained/v1'
    || !SHA256_RE.test(String(value.retainedAuthority.caCertSha256 || ''))
    || !SHA256_RE.test(String(value.retainedAuthority.tlsCertSha256 || ''))) {
    throw new Error('Backend Bootstrap A retained TLS authority proof is invalid');
  }
  for (const key of ['secret', 'caConfigMap', 'service', 'serviceCustodyPolicy', 'serviceCustodyBinding']) {
    if (!/^[0-9a-f-]{36}$/i.test(String(value.retainedAuthority[`${key}Uid`] || ''))
      || !/^\d+$/.test(String(value.retainedAuthority[`${key}ResourceVersion`] || ''))) {
      throw new Error('Backend Bootstrap A retained TLS authority identity is invalid');
    }
  }
  assertClosedObject(value.journalCustody,
    ['bindingResourceVersion', 'bindingUid', 'policyResourceVersion', 'policyUid'],
    'Backend Bootstrap A cleanup journal custody proof');
  for (const key of ['policy', 'binding']) {
    if (!/^[0-9a-f-]{36}$/i.test(String(value.journalCustody[`${key}Uid`] || ''))
      || !/^\d+$/.test(String(value.journalCustody[`${key}ResourceVersion`] || ''))) {
      throw new Error('Backend Bootstrap A cleanup journal custody identity is invalid');
    }
  }
  return value;
}

function bootstrapReceiptProjection({ requestId, mergeRevision, receipt }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('Backend bootstrap A receipt is unavailable');
  }
  return {
    contract: 'opensphere-platform-bootstrap-a-receipt/v1',
    requestId,
    mergeRevision,
    receipt: {
      operationId: receipt.operationId,
      desiredRevision: receipt.desiredRevision,
      appliedRevision: receipt.appliedRevision,
      succeeded: receipt.succeeded,
      result: receipt.result,
      evidence: receipt.evidence,
    },
  };
}

function bootstrapEvidenceHashes({ requestId, mergeRevision, governedDocument, receipt }) {
  return {
    governedDocumentSha256: `sha256:${createHash('sha256')
      .update(canonicalJson(governedDocument)).digest('hex')}`,
    receiptSha256: `sha256:${createHash('sha256')
      .update(canonicalJson(bootstrapReceiptProjection({ requestId, mergeRevision, receipt }))).digest('hex')}`,
  };
}

function validateBackendBootstrapEvidence(value, {
  installedLock, governedDocument, mergeRevision, receipt,
}) {
  const bootstrap = validateBackendBootstrapFrom(value);
  const installed = validateReleaseLock(installedLock, { allowUnsignedComponentBootstrapBase: true });
  if (installed.componentPublication !== undefined
    || installed.releaseScope !== RELEASE_SCOPE_COMPONENT
    || canonicalJson(installed.changedComponents) !== canonicalJson(['backend'])) {
    throw new Error('Backend bootstrap A must be an unsigned historical Backend-only component lock');
  }
  if (bootstrap.releaseDigest !== installed.releaseDigest
    || bootstrap.sourceRevision !== installed.sourceRevision
    || bootstrap.image !== installed.components.backend.image) {
    throw new Error('Backend bootstrapFrom differs from the installed A release');
  }
  if (bootstrap.mergeRevision !== mergeRevision
    || governedDocument?.apiVersion !== 'platform.opensphere.io/v1alpha1'
    || governedDocument?.kind !== 'GovernedChange'
    || governedDocument?.metadata?.requestId !== bootstrap.requestId
    || governedDocument?.metadata?.consumerId !== PLATFORM_RELEASE_CONSUMER
    || governedDocument?.spec?.action !== 'apply'
    || governedDocument?.spec?.target !== PLATFORM_RELEASE_TARGET) {
    throw new Error('Backend bootstrap A governed document identity is invalid');
  }
  const desired = governedDocument.spec.desiredState;
  if (desired?.contract !== PLATFORM_RELEASE_CONTRACT
    || !SHA256_RE.test(String(desired.previousReleaseDigest || ''))) {
    throw new Error('Backend bootstrap A governed desired state is invalid');
  }
  const target = validateReleaseLock(desired.targetLock, { allowUnsignedComponentBootstrapBase: true });
  if (target.componentPublication !== undefined
    || target.releaseDigest !== installed.releaseDigest
    || target.sourceRevision !== bootstrap.sourceRevision
    || target.components.backend.image !== bootstrap.image) {
    throw new Error('Backend bootstrap A governed target differs from the installed release');
  }
  if (receipt.succeeded !== true
    || receipt.operationId !== bootstrap.receiptOperationId
    || receipt.desiredRevision !== mergeRevision
    || receipt.appliedRevision !== bootstrap.sourceRevision
    || receipt.evidence?.installedReleaseDigest !== bootstrap.releaseDigest
    || receipt.evidence?.sourceRevision !== bootstrap.sourceRevision) {
    throw new Error('Backend bootstrap A receipt does not prove the installed release');
  }
  const hashes = bootstrapEvidenceHashes({
    requestId: bootstrap.requestId,
    mergeRevision,
    governedDocument,
    receipt,
  });
  if (hashes.governedDocumentSha256 !== bootstrap.governedDocumentSha256
    || hashes.receiptSha256 !== bootstrap.receiptSha256) {
    throw new Error('Backend bootstrap A document or receipt hash differs from bootstrapFrom');
  }
  return bootstrap;
}

function validateBackendComponentPublication(value, { bootstrapA = false } = {}) {
  assertClosedObject(value, [
    'apiVersion', 'kind', 'publicationScope', 'channel', 'status', 'releaseTag', 'immutableTag',
    'source', 'sourceRevision', 'buildAuthority', 'releaseClass', 'gaEligible',
    'supportedPlatforms', 'requestIntent', 'changedPaths', 'affectedImages', 'releaseScope',
    'fullReleaseJustification', 'previous', 'setupSource', 'platformAuthority', 'verification',
    'artifacts', 'components', 'tooling', 'bootstrapFrom', 'generatedAt',
    ...(bootstrapA ? ['contract', 'bootstrapPhase'] : []),
  ], 'Backend component publication');
  assertClosedObject(value.components, ['backend'], 'Backend component publication components');
  assertClosedObject(value.components.backend, [
    'image', 'sourceRevision', 'registryCredentialsRequired',
  ], 'Backend component publication backend');
  assertClosedObject(value.setupSource, [
    'repository', 'sourceRevision', 'changedPaths', 'lockSha256', 'manifestProjectionTool',
  ], 'Backend component publication Setup source');
  assertClosedObject(value.setupSource.manifestProjectionTool, ['path', 'gitBlob', 'sha256'],
    'Backend component publication Setup manifest projection tool');
  assertClosedObject(value.previous, [
    'image', 'sourceRevision', 'setupSourceRevision',
  ], 'Backend component publication previous release');
  assertClosedObject(value.platformAuthority, [
    'repository', 'sourceRevision', 'inventory',
  ], 'Backend component publication Platform authority');
  assertClosedObject(value.platformAuthority.inventory, [
    'path', 'gitBlob', 'sha256',
  ], 'Backend component publication Platform inventory');
  assertClosedObject(value.verification, [
    'contract', 'setDigest', 'results', 'renderedManifest',
  ], 'Backend component publication verification');
  assertClosedObject(value.verification.renderedManifest, [
    'artifactUri', 'sha256',
  ], 'Backend component publication rendered manifest');
  assertClosedObject(value.artifacts, ['supabaseMigrationManifest'],
    'Backend component publication artifacts');
  assertClosedObject(value.artifacts.supabaseMigrationManifest, [
    'path', 'sha256', 'setDigest', 'latestMigrationId', 'migrationCount',
  ], 'Backend component publication migration artifact');
  const expectedTooling = {
    publisher: COMPONENT_PUBLISHER,
    deployer: 'scripts/Invoke-LocalEdgePlatformRelease.ps1',
    signingHelper: 'scripts/os-shell-edge-signing.ps1',
    initializer: 'scripts/Initialize-FoundationOwnerInstallationLock.ps1',
    ...(bootstrapA ? { bootstrapAValidator: BACKEND_BOOTSTRAP_A_VALIDATOR } : {}),
  };
  assertClosedObject(value.tooling, Object.keys(expectedTooling),
    'Backend component publication tooling');
  for (const [name, expectedPath] of Object.entries(expectedTooling)) {
    assertClosedObject(value.tooling[name], ['path', 'gitBlob', 'sha256'],
      `Backend component publication tooling ${name}`);
    if (value.tooling[name].path !== expectedPath
      || !/^[a-f0-9]{40,64}$/.test(String(value.tooling[name].gitBlob || ''))
      || !SHA256_RE.test(String(value.tooling[name].sha256 || ''))) {
      throw new Error(`Backend component publication tooling ${name} is invalid`);
    }
  }
  const changed = value.changedPaths;
  const setupChanged = value.setupSource.changedPaths;
  const verificationResults = value.verification.results;
  const verificationIds = Array.isArray(verificationResults)
    ? verificationResults.map((result) => result?.id).sort() : [];
  const requiredVerificationIds = bootstrapA
    ? REQUIRED_BACKEND_BOOTSTRAP_A_VERIFICATION_IDS : REQUIRED_BACKEND_VERIFICATION_IDS;
  if (value.apiVersion !== RELEASE_LOCK_API_VERSION
    || value.kind !== (bootstrapA ? BACKEND_BOOTSTRAP_A_PUBLICATION_KIND : COMPONENT_PUBLICATION_KIND)
    || (bootstrapA && (value.contract !== BACKEND_BOOTSTRAP_A_PUBLICATION_CONTRACT
      || value.bootstrapPhase !== 'A' || value.bootstrapFrom !== undefined))
    || value.publicationScope !== 'ComponentSet'
    || value.channel !== 'edge' || value.status !== 'Active'
    || value.source !== 'https://github.com/opensphere-platform/OpenSphere-console'
    || !REVISION_RE.test(String(value.sourceRevision || ''))
    || value.buildAuthority !== 'localhost' || value.releaseClass !== 'pre-ga'
    || value.gaEligible !== false || canonicalJson(value.supportedPlatforms) !== canonicalJson(['linux/amd64'])
    || value.releaseScope !== RELEASE_SCOPE_COMPONENT || value.fullReleaseJustification !== null
    || !Array.isArray(value.affectedImages) || canonicalJson(value.affectedImages) !== canonicalJson(['backend'])
    || !Array.isArray(changed) || !changed.length || canonicalJson(changed) !== canonicalJson([...new Set(changed)].sort())
    || changed.some((path) => typeof path !== 'string' || !path || /^(?:[A-Za-z]:|\/|\\)/.test(path)
      || /(^|\/)\.\.(\/|$)/.test(path))
    || (bootstrapA && changed.some((path) => !BACKEND_BOOTSTRAP_A_CHANGED_PATHS.has(path)))
    || !Array.isArray(setupChanged)
    || canonicalJson(setupChanged) !== canonicalJson([...new Set(setupChanged)].sort())
    || setupChanged.some((path) => !(bootstrapA
      ? BACKEND_BOOTSTRAP_A_SETUP_PATHS : BACKEND_COMPONENT_SETUP_PATHS).has(path))
    || value.setupSource.repository !== 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git'
    || !REVISION_RE.test(String(value.setupSource.sourceRevision || ''))
    || !SHA256_RE.test(String(value.setupSource.lockSha256 || ''))
    || value.setupSource.manifestProjectionTool.path !== 'src/platform-release-bootstrap-manifest.mjs'
    || !/^[a-f0-9]{40,64}$/.test(String(value.setupSource.manifestProjectionTool.gitBlob || ''))
    || !SHA256_RE.test(String(value.setupSource.manifestProjectionTool.sha256 || ''))
    || value.platformAuthority.repository !== 'https://github.com/opensphere-platform/OpenSphere-Platform-V2.git'
    || !REVISION_RE.test(String(value.platformAuthority.sourceRevision || ''))
    || value.platformAuthority.inventory.path !== 'repository-inventory.json'
    || !/^[a-f0-9]{40,64}$/.test(String(value.platformAuthority.inventory.gitBlob || ''))
    || !SHA256_RE.test(String(value.platformAuthority.inventory.sha256 || ''))
    || value.verification.contract !== BACKEND_VERIFICATION_SET_CONTRACT
    || !SHA256_RE.test(String(value.verification.setDigest || ''))
    || !Array.isArray(verificationResults) || !verificationResults.length
    || canonicalJson(verificationIds) !== canonicalJson(requiredVerificationIds)
    || verificationResults.some((result) => {
      try {
        assertClosedObject(result, [
          'id', 'result', 'artifactUri', 'artifactSha256', 'startedAt', 'completedAt',
        ], 'Backend component publication verification result');
      } catch { return true; }
      return typeof result.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(result.id)
        || result.result !== 'PASS'
        || typeof result.artifactUri !== 'string'
        || !/^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(result.artifactUri)
        || !SHA256_RE.test(String(result.artifactSha256 || ''))
        || !Number.isFinite(Date.parse(result.startedAt))
        || !Number.isFinite(Date.parse(result.completedAt))
        || Date.parse(result.completedAt) < Date.parse(result.startedAt);
    })
    || typeof value.verification.renderedManifest.artifactUri !== 'string'
    || !/^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
      .test(value.verification.renderedManifest.artifactUri)
    || !SHA256_RE.test(String(value.verification.renderedManifest.sha256 || ''))
    || value.components.backend.sourceRevision !== value.sourceRevision
    || !IMAGE_RE.test(String(value.components.backend.image || ''))
    || !value.components.backend.image.includes('/opensphere-console-backend@')
    || value.components.backend.registryCredentialsRequired !== false
    || value.artifacts.supabaseMigrationManifest.path !== 'backend/supabase/migrations/manifest.json'
    || (bootstrapA
      ? !/^\d{4}$/.test(String(value.artifacts.supabaseMigrationManifest.latestMigrationId || ''))
      : value.artifacts.supabaseMigrationManifest.latestMigrationId !== '0063')
    || !SHA256_RE.test(String(value.artifacts.supabaseMigrationManifest.sha256 || ''))
    || !SHA256_RE.test(String(value.artifacts.supabaseMigrationManifest.setDigest || ''))
    || !Number.isInteger(value.artifacts.supabaseMigrationManifest.migrationCount)
    || value.artifacts.supabaseMigrationManifest.migrationCount < 1
    || typeof value.requestIntent !== 'string' || value.requestIntent.trim().length < 8
    || !/^\d{12}$/.test(String(value.releaseTag || ''))
    || !/^local-[a-f0-9]{12}$/.test(String(value.immutableTag || ''))
    || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error('Backend component publication is outside the canonical component release contract');
  }
  if (!IMAGE_RE.test(String(value.previous.image || ''))
    || !value.previous.image.includes('/opensphere-console-backend@')
    || !REVISION_RE.test(String(value.previous.sourceRevision || ''))
    || !REVISION_RE.test(String(value.previous.setupSourceRevision || ''))
    || value.previous.image === value.components.backend.image
    || value.previous.sourceRevision === value.sourceRevision) {
    throw new Error('Backend component publication previous release identity is invalid');
  }
  if ((value.setupSource.sourceRevision === value.previous.setupSourceRevision) !== (setupChanged.length === 0)) {
    throw new Error('Backend component publication Setup revision and changed paths are inconsistent');
  }
  const calculatedVerificationSetDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    contract: value.verification.contract,
    results: value.verification.results,
    renderedManifest: value.verification.renderedManifest,
  })).digest('hex')}`;
  if (calculatedVerificationSetDigest !== value.verification.setDigest) {
    throw new Error('Backend component publication verification set digest does not match its evidence');
  }
  if (value.bootstrapFrom !== undefined) {
    const bootstrap = validateBackendBootstrapFrom(value.bootstrapFrom);
    if (value.previous.image !== bootstrap.image
      || value.previous.sourceRevision !== bootstrap.sourceRevision) {
      throw new Error('Backend component publication previous release differs from bootstrapFrom');
    }
  }
  return value;
}

function validateBackendBootstrapAPublication(value) {
  return validateBackendComponentPublication(value, { bootstrapA: true });
}

function backendComponentPublicationBinding(publication, verified) {
  const value = validateBackendComponentPublication(publication);
  return validateComponentPublicationBinding({
    contract: COMPONENT_PUBLICATION_BINDING_CONTRACT,
    publisher: COMPONENT_PUBLISHER,
    publisherGitBlob: value.tooling.publisher.gitBlob,
    publisherSha256: value.tooling.publisher.sha256,
    documentSha256: verified.documentSha256,
    signatureSha256: verified.signatureSha256,
    keyId: verified.keyId,
    setupSourceRevision: value.setupSource.sourceRevision,
    setupSourceLockSha256: value.setupSource.lockSha256,
    setupManifestProjectionGitBlob: value.setupSource.manifestProjectionTool.gitBlob,
    setupManifestProjectionSha256: value.setupSource.manifestProjectionTool.sha256,
    migrationSetDigest: value.artifacts.supabaseMigrationManifest.setDigest,
    platformRevision: value.platformAuthority.sourceRevision,
    inventorySha256: value.platformAuthority.inventory.sha256,
    verificationSetDigest: value.verification.setDigest,
    ...(value.bootstrapFrom ? { bootstrapFrom: structuredClone(value.bootstrapFrom) } : {}),
  });
}

function sameComponent(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateReleaseTransition(baseLock, targetLock) {
  const base = validateReleaseLock(baseLock, { allowUnsignedComponentBootstrapBase: true });
  const target = validateReleaseLock(targetLock);
  if ((target.releaseScope || RELEASE_SCOPE_INTEGRATED) !== RELEASE_SCOPE_COMPONENT) {
    return target;
  }
  if (target.baseReleaseDigest !== base.releaseDigest) {
    throw new Error('component targetLock does not name the installed base release digest');
  }
  if (target.channel !== base.channel || canonicalJson(target.trust) !== canonicalJson(base.trust)) {
    throw new Error('component targetLock channel or trust differs from its base release');
  }
  const baseNames = Object.keys(base.components).sort();
  const targetNames = Object.keys(target.components).sort();
  if (canonicalJson(baseNames) !== canonicalJson(targetNames)) {
    throw new Error('component targetLock cannot change the installed component set');
  }
  const changed = new Set(target.changedComponents);
  for (const name of targetNames) {
    const differs = !sameComponent(base.components[name], target.components[name]);
    if (changed.has(name) && !differs) {
      throw new Error(`component targetLock changed component ${name} is identical to the base release`);
    }
    if (!changed.has(name) && differs) {
      throw new Error(`component targetLock unlisted component ${name} differs from the base release`);
    }
  }
  return target;
}

function normalizeComponentImage(name, value) {
  const repository = COMPONENT_REPOSITORIES[name];
  const raw = String(value || '').trim();
  const image = SHA256_RE.test(raw)
    ? `ghcr.io/opensphere-platform/${repository}@${raw}`
    : raw;
  const match = image.match(IMAGE_RE);
  if (!match || match[1] !== repository) {
    throw new Error(`component evidence ${name} is not the canonical exact-digest image`);
  }
  return image;
}

function buildComponentReleaseLock(baseLock, evidence, now = new Date()) {
  const base = validateReleaseLock(baseLock, { allowUnsignedComponentBootstrapBase: true });
  if (base.channel !== 'edge' || canonicalJson(base.trust) !== canonicalJson(LOCAL_EDGE_TRUST)) {
    throw new Error('component target generation requires an installed localhost edge release');
  }
  assertClosedObject(evidence, ['sourceRevision', 'components', 'componentPublication'], 'componentEvidence');
  if (!REVISION_RE.test(String(evidence.sourceRevision || ''))) {
    throw new Error('componentEvidence sourceRevision is invalid');
  }
  assertClosedObject(evidence.components, REQUIRED_COMPONENTS, 'componentEvidence.components');
  const changedComponents = Object.keys(evidence.components).sort();
  if (changedComponents.length === 0) {
    throw new Error('componentEvidence must contain at least one changed component');
  }
  const components = structuredClone(base.components);
  for (const name of changedComponents) {
    if (!REQUIRED_COMPONENTS.includes(name)) {
      throw new Error(`componentEvidence contains unsupported component ${name}`);
    }
    const item = evidence.components[name];
    assertClosedObject(item, ['image', 'registryCredentialsRequired'], `componentEvidence.components.${name}`);
    if (item.registryCredentialsRequired !== undefined
      && typeof item.registryCredentialsRequired !== 'boolean') {
      throw new Error(`componentEvidence component ${name} registry credential flag is invalid`);
    }
    components[name] = {
      repository: COMPONENT_REPOSITORIES[name],
      image: normalizeComponentImage(name, item.image),
      sourceRevision: evidence.sourceRevision,
      registryCredentialsRequired: item.registryCredentialsRequired
        ?? base.components[name].registryCredentialsRequired
        ?? false,
    };
  }
  const target = {
    apiVersion: RELEASE_LOCK_API_VERSION,
    kind: RELEASE_LOCK_KIND,
    channel: 'edge',
    releaseDigest: '',
    resolvedAt: now.toISOString(),
    source: 'https://github.com/opensphere-platform/OpenSphere-console',
    sourceRevision: evidence.sourceRevision,
    trust: structuredClone(LOCAL_EDGE_TRUST),
    releaseScope: RELEASE_SCOPE_COMPONENT,
    baseReleaseDigest: base.releaseDigest,
    changedComponents,
    componentPublication: validateComponentPublicationBinding(evidence.componentPublication),
    components,
  };
  target.releaseDigest = calculateReleaseDigest(target);
  validateReleaseTransition(base, target);
  return target;
}

function validatePlatformReleaseDesiredState(value) {
  assertClosedObject(value, ['contract', 'previousReleaseDigest', 'targetLock'], 'desiredState');
  if (value.contract !== PLATFORM_RELEASE_CONTRACT) {
    throw new Error('unsupported Platform Release contract');
  }
  if (!SHA256_RE.test(String(value.previousReleaseDigest || ''))) {
    throw new Error('previousReleaseDigest is invalid');
  }
  return {
    contract: PLATFORM_RELEASE_CONTRACT,
    previousReleaseDigest: value.previousReleaseDigest,
    targetLock: validateReleaseLock(value.targetLock),
  };
}

function platformReleaseApprovalPolicy(action, desiredState) {
  const validated = validatePlatformReleaseDesiredState(desiredState);
  const lock = validated.targetLock;
  const localEdgeAutomation = String(action || '').toLowerCase() === 'apply'
    && lock.channel === 'edge'
    && lock.releaseScope === RELEASE_SCOPE_COMPONENT
    && canonicalJson(lock.trust) === canonicalJson(LOCAL_EDGE_TRUST);
  return localEdgeAutomation
    ? {
      mode: APPROVAL_MODE_LOCAL_EDGE_AUTOMATION,
      requiredHumanApprovals: 0,
      autoMerge: true,
      rationale: 'localhost edge component apply is authorized by the docker-desktop local automation boundary',
    }
    : {
      mode: APPROVAL_MODE_CROSS_OPERATOR,
      requiredHumanApprovals: 1,
      autoMerge: false,
      rationale: 'integrated, rollback and promoted releases require an independent operator',
    };
}

function releaseSummary(lock, { allowUnsignedComponentBootstrapBase = false } = {}) {
  const validated = validateReleaseLock(lock, { allowUnsignedComponentBootstrapBase });
  return {
    channel: validated.channel,
    releaseDigest: validated.releaseDigest,
    sourceRevision: validated.sourceRevision,
    resolvedAt: validated.resolvedAt || null,
    componentCount: Object.keys(validated.components).length,
    buildAuthority: validated.trust.buildAuthority || null,
    releaseClass: validated.trust.releaseClass || null,
    releaseScope: validated.releaseScope || RELEASE_SCOPE_INTEGRATED,
    baseReleaseDigest: validated.baseReleaseDigest || null,
    changedComponents: validated.changedComponents || [],
  };
}

module.exports = {
  PLATFORM_RELEASE_CONSUMER,
  PLATFORM_RELEASE_RECONCILER,
  PLATFORM_RELEASE_TARGET,
  PLATFORM_RELEASE_CONTRACT,
  COMPONENT_REPOSITORIES,
  REQUIRED_COMPONENTS,
  RELEASE_SCOPE_INTEGRATED,
  RELEASE_SCOPE_COMPONENT,
  APPROVAL_MODE_LOCAL_EDGE_AUTOMATION,
  APPROVAL_MODE_CROSS_OPERATOR,
  COMPONENT_PUBLICATION_BINDING_CONTRACT,
  BACKEND_BOOTSTRAP_CONTRACT,
  canonicalJson,
  calculateReleaseDigest,
  buildComponentReleaseLock,
  backendComponentPublicationBinding,
  validateBackendComponentPublication,
  validateBackendBootstrapAPublication,
  validateBackendBootstrapFrom,
  validateBootstrapAInitializerCleanup,
  validateBackendBootstrapEvidence,
  bootstrapEvidenceHashes,
  validateComponentPublicationBinding,
  validateReleaseLock,
  validateReleaseTransition,
  validatePlatformReleaseDesiredState,
  platformReleaseApprovalPolicy,
  releaseSummary,
};
