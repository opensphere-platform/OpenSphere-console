'use strict';

const { createHash } = require('crypto');
const {
  CANONICAL_AGENT_COMPONENTS,
  legacyInstalledComponentMap,
  canonicalNameForInstalledComponent,
  installedNameForCanonicalComponent,
  isAgentIdentityCutover,
  hasLegacyInstalledAgentIdentity,
} = require('./platform-release-agent-identity-cutover');

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
  signerWorkflow: 'opensphere-platform/OpenSphere-console/.github/workflows/publish-candidate-images.yml',
  promoterWorkflow: 'opensphere-platform/OpenSphere-console/.github/workflows/promote-release.yml',
  oidcIssuer: 'https://token.actions.githubusercontent.com',
  sourceRef: 'refs/heads/main',
  provenancePredicate: 'https://slsa.dev/provenance/v1',
  sbomPredicate: 'https://spdx.dev/Document/v2.3',
  promotionPredicate: 'https://opensphere.io/attestations/channel-promotion/v1',
});
const COMPONENT_REPOSITORIES = Object.freeze({
  console: 'opensphere-console',
  backend: 'opensphere-console-backend',
  dupaController: 'opensphere-console-dupa-controller',
  registry: 'opensphere-registry',
  osaaGateway: 'opensphere-console-osaa-gateway',
  osdst: 'opensphere-osdst',
  osaaGovernedAdapter: 'opensphere-osaa-governed-adapter',
  notificationDispatcher: 'opensphere-console-notification-dispatcher',
  gitea: 'opensphere-console-gitea',
  supabasePostgres: 'opensphere-console-supabase-postgres',
  supabaseAuth: 'opensphere-console-supabase-auth',
  supabaseRest: 'opensphere-console-supabase-rest',
  supabaseStorage: 'opensphere-console-supabase-storage',
  giteaPostgres: 'opensphere-console-gitea-postgres',
  recovery: 'opensphere-console-recovery',
});
// Current C_API/C_EXT release profile. Keep the historical profile closed;
// accepting a union would let incomplete or mixed owner sets pass validation.
const TARGET_COMPONENT_REPOSITORIES = Object.freeze({
  console: 'opensphere-console',
  consoleApi: 'opensphere-console-api',
  extensionController: 'opensphere-extension-controller',
  registry: 'opensphere-registry',
  osaaGateway: 'opensphere-console-osaa-gateway',
  osdst: 'opensphere-osdst',
  osaaGovernedAdapter: 'opensphere-osaa-governed-adapter',
  notificationDispatcher: 'opensphere-console-notification-dispatcher',
  gitea: 'opensphere-console-gitea',
  supabasePostgres: 'opensphere-console-supabase-postgres',
  supabaseAuth: 'opensphere-console-supabase-auth',
  supabaseRest: 'opensphere-console-supabase-rest',
  supabaseStorage: 'opensphere-console-supabase-storage',
  giteaPostgres: 'opensphere-console-gitea-postgres',
  recovery: 'opensphere-console-recovery',
  beszelHub: 'opensphere-console-beszel-hub',
  beszelAgent: 'opensphere-console-beszel-agent',
  beszelBootstrap: 'opensphere-console-beszel-bootstrap',
});
const TARGET_AUXILIARY_ARTIFACT_REPOSITORIES = Object.freeze({
  cliArtifacts: 'opensphere-os-cli',
  osShellControl: 'opensphere-console-os-shell-control',
  osShellRuntime: 'opensphere-os-shell-runtime',
});
const AUXILIARY_ARTIFACT_REPOSITORIES = Object.freeze({
  cliArtifacts: 'opensphere-os-cli',
});
const REQUIRED_COMPONENTS = Object.freeze(Object.keys(COMPONENT_REPOSITORIES));
const PRE_REGISTRY_COMPONENT_REPOSITORIES = Object.freeze(Object.fromEntries(
  Object.entries(COMPONENT_REPOSITORIES).filter(([name]) => name !== 'registry'),
));
const PRE_OSDST_COMPONENT_REPOSITORIES = Object.freeze(Object.fromEntries(
  Object.entries(COMPONENT_REPOSITORIES).filter(([name]) => name !== 'osdst'),
));
const LEGACY_INSTALLED_COMPONENT_REPOSITORIES = legacyInstalledComponentMap(COMPONENT_REPOSITORIES);
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
    ...(lock.auxiliaryArtifacts ? { auxiliaryArtifacts: lock.auxiliaryArtifacts } : {}),
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

function installedComponentProfile(components, { allowInstalledAgentIdentityCutover = false } = {}) {
  const names = Object.keys(components ?? {});
  const targetNames = Object.keys(TARGET_COMPONENT_REPOSITORIES);
  if (names.length === targetNames.length && targetNames.every((name) => names.includes(name))) {
    return { names: targetNames, repositories: TARGET_COMPONENT_REPOSITORIES, agentIdentity: 'canonical' };
  }
  const canonicalNames = Object.keys(COMPONENT_REPOSITORIES);
  if (names.length === canonicalNames.length
    && canonicalNames.every((name) => names.includes(name))) {
    return { names: canonicalNames, repositories: COMPONENT_REPOSITORIES, agentIdentity: 'canonical' };
  }
  const preOsdstNames = Object.keys(PRE_OSDST_COMPONENT_REPOSITORIES);
  if (allowInstalledAgentIdentityCutover
    && names.length === preOsdstNames.length
    && preOsdstNames.every((name) => names.includes(name))) {
    return {
      names: preOsdstNames,
      repositories: PRE_OSDST_COMPONENT_REPOSITORIES,
      agentIdentity: 'installed-pre-osdst',
    };
  }
  const preRegistryNames = Object.keys(PRE_REGISTRY_COMPONENT_REPOSITORIES);
  if (allowInstalledAgentIdentityCutover
    && names.length === preRegistryNames.length
    && preRegistryNames.every((name) => names.includes(name))) {
    return {
      names: preRegistryNames,
      repositories: PRE_REGISTRY_COMPONENT_REPOSITORIES,
      agentIdentity: 'installed-pre-registry',
    };
  }
  const legacyNames = Object.keys(LEGACY_INSTALLED_COMPONENT_REPOSITORIES);
  if (allowInstalledAgentIdentityCutover
    && names.length === legacyNames.length
    && legacyNames.every((name) => names.includes(name))) {
    return {
      names: legacyNames,
      repositories: LEGACY_INSTALLED_COMPONENT_REPOSITORIES,
      agentIdentity: 'installed-pre-osaa',
    };
  }
  return null;
}

function validateReleaseLock(lock, { allowInstalledAgentIdentityCutover = false } = {}) {
  assertClosedObject(lock, [
    'apiVersion', 'kind', 'channel', 'releaseDigest', 'resolvedAt', 'source',
    'sourceRevision', 'trust', 'releaseBom', 'components',
    'releaseScope', 'baseReleaseDigest', 'changedComponents',
    'provenanceVerifiedAt', 'sbomVerifiedAt',
    'auxiliaryArtifacts',
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
    'signerWorkflow', 'promoterWorkflow', 'oidcIssuer', 'sourceRef', 'provenancePredicate', 'sbomPredicate', 'promotionPredicate',
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
    && (lock.baseReleaseDigest !== undefined || lock.changedComponents !== undefined)) {
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
    const componentProfile = installedComponentProfile(lock.components, {
      allowInstalledAgentIdentityCutover,
    });
    const allowedChanged = componentProfile?.names ?? REQUIRED_COMPONENTS;
    const canonicalChanged = Array.isArray(changed) ? [...new Set(changed)].sort() : [];
    if (!Array.isArray(changed)
      || changed.length === 0
      || changed.length !== canonicalChanged.length
      || changed.some((name, index) => name !== canonicalChanged[index])
      || changed.some((name) => !allowedChanged.includes(name))) {
      throw new Error('component targetLock changedComponents must be a non-empty canonical sorted set');
    }
    if (lock.releaseBom !== undefined) {
      throw new Error('component targetLock cannot claim a signed Release BOM');
    }
  }
  const componentProfile = installedComponentProfile(lock.components, {
    allowInstalledAgentIdentityCutover,
  });
  if (!componentProfile) throw new Error('targetLock component set is incomplete or unsupported');
  const { names: expectedNames, repositories } = componentProfile;
  const auxiliaryRepositories = repositories === TARGET_COMPONENT_REPOSITORIES
    ? TARGET_AUXILIARY_ARTIFACT_REPOSITORIES : AUXILIARY_ARTIFACT_REPOSITORIES;
  if (repositories === TARGET_COMPONENT_REPOSITORIES && lock.auxiliaryArtifacts === undefined) {
    throw new Error('current targetLock requires the complete governed auxiliary artifact set');
  }
  assertClosedObject(lock.components, expectedNames, 'targetLock.components');
  const names = Object.keys(lock.components).sort();
  if (names.length !== expectedNames.length
    || names.some((name, index) => name !== [...expectedNames].sort()[index])) {
    throw new Error('targetLock component set is incomplete or unsupported');
  }
  for (const name of expectedNames) {
    const component = lock.components[name];
    assertClosedObject(component, [
      'repository', 'image', 'sourceRevision', 'registryCredentialsRequired',
    ], `targetLock.components.${name}`);
    const image = String(component.image || '');
    const match = image.match(IMAGE_RE);
    if (!match || component.repository !== match[1]
      || component.repository !== repositories[name]) {
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
  if (lock.auxiliaryArtifacts !== undefined) {
    if (!localEdge || lock.channel !== 'edge') {
      throw new Error('targetLock auxiliary artifacts require localhost edge trust');
    }
    const expectedAuxiliaryNames = Object.keys(auxiliaryRepositories);
    assertClosedObject(lock.auxiliaryArtifacts, expectedAuxiliaryNames, 'targetLock.auxiliaryArtifacts');
    const auxiliaryNames = Object.keys(lock.auxiliaryArtifacts);
    if (canonicalJson(auxiliaryNames) !== canonicalJson(expectedAuxiliaryNames)) {
      throw new Error('targetLock auxiliary artifact set is incomplete or unsupported');
    }
    for (const name of expectedAuxiliaryNames) {
      const artifact = lock.auxiliaryArtifacts[name];
      assertClosedObject(artifact, [
        'repository', 'image', 'sourceRevision', 'registryCredentialsRequired',
      ], `targetLock.auxiliaryArtifacts.${name}`);
      const image = String(artifact.image || '');
      const match = image.match(IMAGE_RE);
      if (!match || artifact.repository !== match[1]
        || artifact.repository !== auxiliaryRepositories[name]) {
        throw new Error(`targetLock auxiliary artifact ${name} is not a canonical exact-digest image`);
      }
      if (!REVISION_RE.test(String(artifact.sourceRevision || ''))) {
        throw new Error(`targetLock auxiliary artifact ${name} sourceRevision is invalid`);
      }
      if (releaseScope === RELEASE_SCOPE_INTEGRATED
        && artifact.sourceRevision !== lock.sourceRevision) {
        throw new Error(`targetLock auxiliary artifact ${name} sourceRevision differs from the release`);
      }
      if (artifact.registryCredentialsRequired !== undefined
        && typeof artifact.registryCredentialsRequired !== 'boolean') {
        throw new Error(`targetLock auxiliary artifact ${name} registry credential flag is invalid`);
      }
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
  const base = validateReleaseLock(baseLock, { allowInstalledAgentIdentityCutover: true });
  const target = validateReleaseLock(targetLock);
  const installedPreOsaa = hasLegacyInstalledAgentIdentity(base.components);
  if ((target.releaseScope || RELEASE_SCOPE_INTEGRATED) !== RELEASE_SCOPE_COMPONENT) {
    if (installedPreOsaa) {
      throw new Error('installed pre-OSAA lock requires the one-way OSAA component transition');
    }
    return target;
  }
  if (target.baseReleaseDigest !== base.releaseDigest) {
    throw new Error('component targetLock does not name the installed base release digest');
  }
  if (target.channel !== base.channel || canonicalJson(target.trust) !== canonicalJson(base.trust)) {
    throw new Error('component targetLock channel or trust differs from its base release');
  }
  if (!sameComponent(base.auxiliaryArtifacts, target.auxiliaryArtifacts)) {
    throw new Error('component targetLock cannot change auxiliary runtime artifacts');
  }
  const cutover = isAgentIdentityCutover(base.components, target.components);
  if (cutover) {
    const required = Object.keys(CANONICAL_AGENT_COMPONENTS);
    if (!required.every((name) => target.changedComponents.includes(name))) {
      throw new Error('OSAA identity cutover must change both canonical agent components together');
    }
  }
  const baseNames = Object.keys(base.components)
    .map((name) => cutover ? canonicalNameForInstalledComponent(name) : name)
    .sort();
  const targetNames = Object.keys(target.components).sort();
  const registryIntroduction = !baseNames.includes('registry')
    && targetNames.includes('registry')
    && canonicalJson([...baseNames, 'registry'].sort()) === canonicalJson(targetNames)
    && target.changedComponents.includes('registry');
  if (canonicalJson(baseNames) !== canonicalJson(targetNames) && !registryIntroduction) {
    throw new Error('component targetLock cannot change the installed component set');
  }
  const changed = new Set(target.changedComponents);
  for (const name of targetNames) {
    const installedName = cutover ? installedNameForCanonicalComponent(name) : name;
    const differs = registryIntroduction && name === 'registry'
      ? true : !sameComponent(base.components[installedName], target.components[name]);
    if (changed.has(name) && !differs) {
      throw new Error(`component targetLock changed component ${name} is identical to the base release`);
    }
    if (!changed.has(name) && differs) {
      throw new Error(`component targetLock unlisted component ${name} differs from the base release`);
    }
  }
  return target;
}

function normalizeComponentImage(name, value, repositories = COMPONENT_REPOSITORIES) {
  const repository = repositories[name];
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
  const base = validateReleaseLock(baseLock, { allowInstalledAgentIdentityCutover: true });
  if (base.channel !== 'edge' || canonicalJson(base.trust) !== canonicalJson(LOCAL_EDGE_TRUST)) {
    throw new Error('component target generation requires an installed localhost edge release');
  }
  assertClosedObject(evidence, ['sourceRevision', 'components'], 'componentEvidence');
  if (!REVISION_RE.test(String(evidence.sourceRevision || ''))) {
    throw new Error('componentEvidence sourceRevision is invalid');
  }
  const repositories = installedComponentProfile(base.components, { allowInstalledAgentIdentityCutover: true }).repositories === TARGET_COMPONENT_REPOSITORIES
    ? TARGET_COMPONENT_REPOSITORIES : COMPONENT_REPOSITORIES;
  const supportedNames = Object.keys(repositories);
  assertClosedObject(evidence.components, supportedNames, 'componentEvidence.components');
  const changedComponents = Object.keys(evidence.components).sort();
  if (changedComponents.length === 0) {
    throw new Error('componentEvidence must contain at least one changed component');
  }
  const cutover = hasLegacyInstalledAgentIdentity(base.components);
  if (cutover) {
    const required = Object.keys(CANONICAL_AGENT_COMPONENTS);
    if (!required.every((name) => changedComponents.includes(name))) {
      throw new Error('OSAA identity cutover must change both canonical agent components together');
    }
  }
  const components = Object.fromEntries(Object.entries(base.components)
    .map(([name, component]) => [
      cutover ? canonicalNameForInstalledComponent(name) : name,
      structuredClone(component),
    ]));
  for (const name of changedComponents) {
    if (!supportedNames.includes(name)) {
      throw new Error(`componentEvidence contains unsupported component ${name}`);
    }
    const item = evidence.components[name];
    assertClosedObject(item, ['image', 'registryCredentialsRequired'], `componentEvidence.components.${name}`);
    if (item.registryCredentialsRequired !== undefined
      && typeof item.registryCredentialsRequired !== 'boolean') {
      throw new Error(`componentEvidence component ${name} registry credential flag is invalid`);
    }
    components[name] = {
      repository: repositories[name],
      image: normalizeComponentImage(name, item.image, repositories),
      sourceRevision: evidence.sourceRevision,
      registryCredentialsRequired: item.registryCredentialsRequired
        ?? base.components[cutover ? installedNameForCanonicalComponent(name) : name]
          ?.registryCredentialsRequired
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
    ...(base.auxiliaryArtifacts
      ? { auxiliaryArtifacts: structuredClone(base.auxiliaryArtifacts) }
      : {}),
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

function releaseSummary(lock, options = {}) {
  const validated = validateReleaseLock(lock, options);
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
  canonicalJson,
  calculateReleaseDigest,
  buildComponentReleaseLock,
  validateReleaseLock,
  validateReleaseTransition,
  validatePlatformReleaseDesiredState,
  platformReleaseApprovalPolicy,
  releaseSummary,
};
