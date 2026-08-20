'use strict';

const { createHash, createPublicKey, verify: verifySignature } = require('crypto');

const PLATFORM_RELEASE_CONSUMER = 'platform-release';
const PLATFORM_RELEASE_RECONCILER = 'platform-release-reconciler';
const PLATFORM_RELEASE_TARGET = 'opensphere-platform';
const PLATFORM_RELEASE_CONTRACT = 'opensphere.platform.release/v1';
const RELEASE_LOCK_API_VERSION = 'release.opensphere.io/v1alpha1';
const RELEASE_LOCK_KIND = 'OpenSphereReleaseLock';
const RELEASE_SCOPE_INTEGRATED = 'integrated';
const RELEASE_SCOPE_COMPONENT = 'component';
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
const PFSS_COMPONENTS = Object.freeze(['backend', 'oaaGateway']);
const COMPONENT_PUBLICATION_PUBLISHER = 'scripts/Publish-LocalEdgeBackendComponent.ps1';
const PFSS_SIGNATURE_CONTRACT = 'opensphere-edge-detached-signature/v1';
const PFSS_CANONICAL_SOURCE = 'https://github.com/opensphere-platform/OpenSphere-console';

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

function assertExactObject(value, expected, label) {
  assertClosedObject(value, expected, label);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
}

// Keep this byte-for-byte compatible with the installer binding.  The Console
// does not create a second release ledger: the signed publisher statement is
// carried inside the digest-pinned Platform Release lock that Setup verifies.
function validateComponentPublicationBinding(value) {
  const expected = [
    'contract', 'publisher', 'publisherGitBlob', 'publisherSha256', 'documentSha256',
    'signatureSha256', 'keyId', 'setupSourceRevision', 'setupSourceLockSha256',
    'setupManifestProjectionGitBlob', 'setupManifestProjectionSha256', 'migrationSetDigest',
    'platformRevision', 'inventorySha256', 'verificationSetDigest',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== expected.sort().join(',')
      || value.contract !== 'opensphere-edge-component-publication-binding/v1'
      || value.publisher !== COMPONENT_PUBLICATION_PUBLISHER
      || !/^[a-f0-9]{40,64}$/.test(value.publisherGitBlob || '')
      || !['publisherSha256', 'documentSha256', 'signatureSha256', 'setupSourceLockSha256',
        'setupManifestProjectionSha256', 'migrationSetDigest', 'inventorySha256',
        'verificationSetDigest'].every((key) => SHA256_RE.test(String(value[key] || '')))
      || value.keyId !== 'opensphere-edge-local-v1'
      || !REVISION_RE.test(String(value.setupSourceRevision || ''))
      || !/^[a-f0-9]{40,64}$/.test(value.setupManifestProjectionGitBlob || '')
      || !REVISION_RE.test(String(value.platformRevision || ''))) {
    throw new Error('component release publication binding is invalid');
  }
  return value;
}

function pfssOperationId(documentSha256) {
  if (!SHA256_RE.test(String(documentSha256 || ''))) {
    throw new Error('PFSS publication document digest is invalid');
  }
  return `pfss:${documentSha256.slice('sha256:'.length)}`;
}

// This is deliberately separate from release-lock generation.  It verifies
// publisher evidence before any durable change request is opened, so a caller
// cannot substitute a binding hash for the signed publication itself.
function validatePfssPublicationSubmission(value, trustedPublicKeySpkiBase64) {
  assertExactObject(value, [
    'sourceRevision', 'components', 'componentPublication',
    'publicationDocument', 'publicationSignature',
  ], 'PFSS publication submission');
  if (!REVISION_RE.test(String(value.sourceRevision || ''))) {
    throw new Error('PFSS publication sourceRevision is invalid');
  }
  assertExactObject(value.components, PFSS_COMPONENTS, 'PFSS publication components');
  for (const name of PFSS_COMPONENTS) {
    if (typeof value.components[name] !== 'string') {
      throw new Error(`PFSS publication component ${name} image is invalid`);
    }
    normalizeComponentImage(name, value.components[name]);
  }
  const binding = validateComponentPublicationBinding(value.componentPublication);
  if (typeof value.publicationDocument !== 'string' || !value.publicationDocument.length) {
    throw new Error('PFSS publication document must be the original compact JSON string');
  }
  if (typeof value.publicationSignature !== 'string' || !value.publicationSignature.length) {
    throw new Error('PFSS publication signature must be the original compact JSON string');
  }

  let document;
  let signature;
  try {
    document = JSON.parse(value.publicationDocument);
    signature = JSON.parse(value.publicationSignature);
  } catch {
    throw new Error('PFSS publication evidence is not valid JSON');
  }
  if (JSON.stringify(document) !== value.publicationDocument
    || JSON.stringify(signature) !== value.publicationSignature) {
    throw new Error('PFSS publication evidence must retain its original compact JSON encoding');
  }
  const documentSha256 = sha256(value.publicationDocument);
  const signatureSha256 = sha256(value.publicationSignature);
  if (binding.documentSha256 !== documentSha256 || binding.signatureSha256 !== signatureSha256) {
    throw new Error('PFSS publication binding digest differs from the supplied signed evidence');
  }
  assertExactObject(signature, [
    'contract', 'algorithm', 'keyId', 'trustReference', 'publicKeySpkiSha256',
    'documentSha256', 'signature', 'releaseClass', 'gaPromotionEligible',
  ], 'PFSS detached signature');
  if (signature.contract !== PFSS_SIGNATURE_CONTRACT
    || signature.algorithm !== 'ES256-P1363'
    || signature.keyId !== binding.keyId
    || signature.documentSha256 !== documentSha256
    || signature.releaseClass !== 'pre-ga'
    || signature.gaPromotionEligible !== false
    || !/^[A-Za-z0-9_-]+$/.test(signature.signature || '')) {
    throw new Error('PFSS detached signature metadata is invalid');
  }
  if (typeof trustedPublicKeySpkiBase64 !== 'string' || !trustedPublicKeySpkiBase64.trim()) {
    throw new Error('PFSS trusted P-256 SPKI is not configured');
  }
  let publicKey;
  let spki;
  try {
    spki = Buffer.from(trustedPublicKeySpkiBase64, 'base64');
    publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw new Error('PFSS trusted P-256 SPKI is invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ec'
    || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || signature.publicKeySpkiSha256 !== sha256(spki)) {
    throw new Error('PFSS detached signature trust root is invalid');
  }
  let verified = false;
  try {
    verified = verifySignature('sha256', Buffer.from(value.publicationDocument), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature.signature, 'base64url'));
  } catch {
    verified = false;
  }
  if (!verified) throw new Error('PFSS detached signature verification failed');

  assertExactObject(document, [
    'apiVersion', 'kind', 'publicationScope', 'channel', 'status', 'source',
    'sourceRevision', 'releaseTag', 'immutableTag', 'buildAuthority', 'releaseClass',
    'gaEligible', 'supportedPlatforms', 'components', 'changedPaths', 'affectedImages',
    'releaseScope', 'fullReleaseJustification',
  ], 'PFSS publication document');
  if (document.apiVersion !== 'release.opensphere.io/v1alpha1'
    || document.kind !== 'OpenSphereEdgeComponentPublication'
    || document.publicationScope !== 'ComponentSet'
    || document.channel !== 'edge'
    || document.status !== 'Active'
    || document.source !== PFSS_CANONICAL_SOURCE
    || document.sourceRevision !== value.sourceRevision
    || document.buildAuthority !== 'localhost'
    || document.releaseClass !== 'pre-ga'
    || document.gaEligible !== false
    || document.releaseScope !== 'component'
    || document.fullReleaseJustification !== null
    || typeof document.releaseTag !== 'string'
    || typeof document.immutableTag !== 'string') {
    throw new Error('PFSS publication document root is invalid');
  }
  assertStringArray(document.supportedPlatforms, 'PFSS publication supportedPlatforms');
  assertStringArray(document.changedPaths, 'PFSS publication changedPaths');
  assertStringArray(document.affectedImages, 'PFSS publication affectedImages');
  if (document.supportedPlatforms.length !== 1 || document.supportedPlatforms[0] !== 'linux/amd64'
    || document.changedPaths.length === 0
    || document.affectedImages.join(',') !== PFSS_COMPONENTS.join(',')) {
    throw new Error('PFSS publication document component evidence is invalid');
  }
  assertExactObject(document.components, PFSS_COMPONENTS, 'PFSS publication document components');
  for (const name of PFSS_COMPONENTS) {
    const component = document.components[name];
    assertExactObject(component, ['repository', 'image', 'sourceRevision'], `PFSS publication document component ${name}`);
    if (component.repository !== COMPONENT_REPOSITORIES[name]
      || component.image !== normalizeComponentImage(name, value.components[name])
      || component.sourceRevision !== value.sourceRevision) {
      throw new Error(`PFSS publication document component ${name} differs from the request`);
    }
  }
  return {
    binding,
    documentSha256,
    signatureSha256,
    operationId: pfssOperationId(documentSha256),
  };
}

function validateReleaseLock(lock) {
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
    if (lock.componentPublication !== undefined) {
      if (canonicalChanged.join(',') !== PFSS_COMPONENTS.join(',')) {
        throw new Error('PFSS component targetLock must change exactly backend,oaaGateway');
      }
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

function sameComponent(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateReleaseTransition(baseLock, targetLock) {
  const base = validateReleaseLock(baseLock);
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
  const base = validateReleaseLock(baseLock);
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
  const componentPublication = evidence.componentPublication === undefined ? undefined :
    validateComponentPublicationBinding(evidence.componentPublication);
  if (componentPublication && changedComponents.join(',') !== PFSS_COMPONENTS.join(',')) {
    throw new Error('PFSS componentEvidence must change exactly backend,oaaGateway');
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
    ...(componentPublication ? { componentPublication } : {}),
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

function releaseSummary(lock) {
  const validated = validateReleaseLock(lock);
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
  PFSS_COMPONENTS,
  COMPONENT_PUBLICATION_PUBLISHER,
  RELEASE_SCOPE_INTEGRATED,
  RELEASE_SCOPE_COMPONENT,
  APPROVAL_MODE_LOCAL_EDGE_AUTOMATION,
  APPROVAL_MODE_CROSS_OPERATOR,
  canonicalJson,
  calculateReleaseDigest,
  buildComponentReleaseLock,
  validateComponentPublicationBinding,
  validatePfssPublicationSubmission,
  pfssOperationId,
  validateReleaseLock,
  validateReleaseTransition,
  validatePlatformReleaseDesiredState,
  platformReleaseApprovalPolicy,
  releaseSummary,
};
