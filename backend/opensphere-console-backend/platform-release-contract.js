'use strict';

const { createHash } = require('crypto');

const PLATFORM_RELEASE_CONSUMER = 'platform-release';
const PLATFORM_RELEASE_RECONCILER = 'platform-release-reconciler';
const PLATFORM_RELEASE_TARGET = 'opensphere-platform';
const PLATFORM_RELEASE_CONTRACT = 'opensphere.platform.release/v1';
const RELEASE_LOCK_API_VERSION = 'release.opensphere.io/v1alpha1';
const RELEASE_LOCK_KIND = 'OpenSphereReleaseLock';
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

function validateReleaseLock(lock) {
  assertClosedObject(lock, [
    'apiVersion', 'kind', 'channel', 'releaseDigest', 'resolvedAt', 'source',
    'sourceRevision', 'trust', 'releaseBom', 'components',
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
    if (component.sourceRevision !== lock.sourceRevision) {
      throw new Error(`targetLock component ${name} sourceRevision differs from the release`);
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
  };
}

module.exports = {
  PLATFORM_RELEASE_CONSUMER,
  PLATFORM_RELEASE_RECONCILER,
  PLATFORM_RELEASE_TARGET,
  PLATFORM_RELEASE_CONTRACT,
  COMPONENT_REPOSITORIES,
  REQUIRED_COMPONENTS,
  canonicalJson,
  calculateReleaseDigest,
  validateReleaseLock,
  validatePlatformReleaseDesiredState,
  releaseSummary,
};
