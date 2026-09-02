import { extensionStaticContractSha256 } from './extension-release.mjs';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RESOURCE_VERSION = /^[0-9A-Za-z._:-]{1,128}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MANIFEST_DIGEST = /^[a-f0-9]{64}$/u;
const IMAGE_REPOSITORY = /^ghcr[.]io\/opensphere-platform\/[a-z0-9][a-z0-9._-]{0,127}$/u;
const FILE_PATH = /^\/plugins\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ARTIFACT_VERSION = /^[0-9]{12}$/u;
const COMPATIBILITY_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const SOURCE_REVISION = /^[a-f0-9]{40}$/u;
const PERMISSION = /^[a-z][a-z0-9._:-]{0,127}$/u;
const MAX_ITEMS = 256;
const NATIVE_BINDINGS = new Set(['os', 'os-cli', 'opensphere-os-cli']);

function fault(message, code, status = 503, sideEffect = 'none', retryable = false) {
  return Object.assign(new Error(message), { code, status, sideEffect, retryable });
}
function apiOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Kubernetes API URL must be absolute'); }
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', '::1'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !loopback) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Kubernetes API URL must be a credential-free HTTPS origin or loopback test origin');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed.toString().replace(/\/$/u, '');
}
async function boundedJson(response, maximumBytes) {
  if (response.status === 204 || !response.body) return null;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw fault('Kubernetes response exceeds the configured limit', 'AuthorityContractViolation');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw fault('Kubernetes response exceeds the configured limit', 'AuthorityContractViolation');
    }
    chunks.push(Buffer.from(value));
  }
  try { return length ? JSON.parse(Buffer.concat(chunks, length).toString('utf8')) : null; }
  catch { throw fault('Kubernetes response is invalid JSON', 'AuthorityContractViolation'); }
}
function safeText(value, maximum, fallback = '') {
  const result = typeof value === 'string' ? value : fallback;
  if (result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) throw fault('Kubernetes projection contains invalid text', 'AuthorityContractViolation');
  return result;
}
function exactMutationText(value, minimum, maximum) {
  return typeof value === 'string' && value.trim().length >= minimum && value.trim().length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function boundedList(value) {
  const items = Array.isArray(value?.items) ? value.items : null;
  if (!items || items.length > MAX_ITEMS) throw fault('Kubernetes inventory is invalid or unbounded', 'AuthorityContractViolation');
  return items;
}
function metadata(resource, { apiVersion, kind, namespace = null } = {}) {
  const source = resource?.metadata || {};
  const name = String(source.name || '');
  const uid = String(source.uid || '');
  const resourceVersion = String(source.resourceVersion || '');
  const namespaceMatches = namespace == null ? source.namespace == null : source.namespace === namespace;
  if (resource?.apiVersion !== apiVersion || resource?.kind !== kind || !namespaceMatches
      || !DNS_LABEL.test(name) || !RESOURCE_VERSION.test(resourceVersion)
      || uid.length < 1 || uid.length > 128 || /[\u0000-\u001f\u007f]/u.test(uid)) {
    throw fault('Kubernetes resource identity is invalid', 'AuthorityContractViolation');
  }
  return Object.freeze({
    name,
    uid,
    resourceVersion,
    generation: Number.isSafeInteger(Number(source.generation)) ? Number(source.generation) : null,
    scope: safeText(source.labels?.['opensphere.io/scope'], 128),
  });
}

function packageIdentity(pkg, expectedName, namespace) {
  const current = metadata(pkg, { apiVersion: 'plugins.opensphere.io/v1alpha1', kind: 'UIPluginPackage', namespace });
  if ((expectedName && current.name !== expectedName) || current.generation == null || current.generation < 1) {
    throw fault('UIPluginPackage identity changed', 'AuthorityContractViolation');
  }
  return current;
}
function boundedCopy(value, maximumBytes, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const copy = structuredClone(value);
  if (Buffer.byteLength(JSON.stringify(copy)) > maximumBytes) throw fault(label + ' projection is too large', 'AuthorityContractViolation');
  return copy;
}
function permissionProjection(value) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS
      || value.some((permission) => typeof permission !== 'string' || !PERMISSION.test(permission))
      || new Set(value).size !== value.length) {
    throw fault('Extension permission projection is invalid', 'AuthorityContractViolation');
  }
  return [...value];
}
function statusProjection(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = [
    'phase', 'reason', 'manifestUrl', 'lastTransitionTime', 'retryable', 'nextRetryAt',
    'observedGeneration', 'observedVersion', 'currentVersion', 'currentArtifactVersion', 'currentRepository',
    'currentManifestPath', 'currentSignaturePath', 'currentStaticContractSha256', 'currentCompatibilityVersion',
    'currentBuildAuthority', 'currentDigest', 'currentManifestSha256', 'currentRequestedRef',
    'currentRequestedChannel', 'currentResolvedAt', 'currentSource', 'currentRevision',
    'currentSignatureIdentity', 'currentEvidenceRefs', 'currentRegistryCredentialsRequired',
    'previousDigest', 'previousManifestSha256', 'previousVersion', 'previousArtifactVersion', 'previousRepository',
    'previousManifestPath', 'previousSignaturePath', 'previousStaticContractSha256', 'previousCompatibilityVersion',
    'previousBuildAuthority', 'previousRequestedRef', 'previousRequestedChannel', 'previousResolvedAt',
    'previousSource', 'previousRevision', 'previousSignatureIdentity', 'previousEvidenceRefs',
    'previousRegistryCredentialsRequired', 'currentChannelDigest', 'channelState', 'channelCheckedAt',
    'channelReason', 'host', 'workload', 'verification', 'serving', 'revalidation', 'admission', 'integrations',
  ];
  const result = {};
  for (const key of allowed) if (Object.hasOwn(source, key)) result[key] = structuredClone(source[key]);
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw fault('Extension status projection is too large', 'AuthorityContractViolation');
  return result;
}
function registrationIdentity(registration, expectedName, namespace) {
  const current = metadata(registration, {
    apiVersion: 'plugins.opensphere.io/v1alpha1', kind: 'UIPluginRegistration', namespace,
  });
  if (current.name !== expectedName || current.generation == null || current.generation < 1
      || registration?.spec?.packageRef?.name !== expectedName
      || !['Installed', 'Enabled', 'Disabled', 'Uninstalled'].includes(registration?.spec?.desiredState)) {
    throw fault('UIPluginRegistration contract is invalid', 'AuthorityContractViolation');
  }
  return current;
}
function projectRegistration(registration, namespace) {
  const current = registrationIdentity(registration, String(registration?.metadata?.name || ''), namespace);
  const status = statusProjection(registration.status);
  const installation = registration?.spec?.installation && typeof registration.spec.installation === 'object'
    ? boundedCopy(registration.spec.installation, 4096, 'Extension installation') : null;
  const approval = registration?.spec?.approval && typeof registration.spec.approval === 'object'
    ? { requestedBy: safeText(registration.spec.approval.requestedBy, 128), reason: safeText(registration.spec.approval.reason, 500) } : null;
  return Object.freeze({
    name: current.name,
    desiredState: registration.spec.desiredState,
    ...(installation ? { installation } : {}),
    status,
    ...(approval ? { approval } : {}),
    health: status?.workload?.phase === 'Ready' ? 'Ready' : status?.workload?.phase ? 'NotReady' : 'N/A',
  });
}
function projectPackage(pkg, registration, preference, namespace) {
  const current = packageIdentity(pkg, String(pkg?.metadata?.name || ''), namespace);
  const spec = pkg?.spec || {};
  if (!['plugin', 'subShell'].includes(spec.kind) || !DNS_LABEL.test(String(spec.hostRef || ''))
      || !COMPATIBILITY_VERSION.test(String(spec.hostCompat || ''))
      || !DIGEST.test(String(spec.image?.digest || '')) || spec.resolution?.resolvedDigest !== spec.image.digest) {
    throw fault('UIPluginPackage contract is invalid', 'AuthorityContractViolation');
  }
  const defaultNavigation = spec.nav && typeof spec.nav === 'object' && !Array.isArray(spec.nav)
    ? boundedCopy(spec.nav, 4096, 'Extension navigation') : null;
  const navigation = preference?.navigation && typeof preference.navigation === 'object' && !Array.isArray(preference.navigation)
    ? boundedCopy({ ...(defaultNavigation || {}), ...preference.navigation }, 4096, 'Extension navigation') : defaultNavigation;
  return Object.freeze({
    name: current.name,
    displayName: safeText(spec.displayName, 160, current.name),
    version: safeText(spec.version, 64),
    owner: safeText(spec.owner, 160),
    description: safeText(spec.description, 1000),
    ...(navigation ? { nav: navigation } : {}),
    shellCompat: safeText(spec.shellCompat, 128),
    permissions: permissionProjection(spec.permissions || []),
    kind: spec.kind,
    hostRef: spec.hostRef,
    ...(spec.hostApiVersion ? { hostApiVersion: safeText(spec.hostApiVersion, 64) } : {}),
    hostCompat: spec.hostCompat,
    contributions: boundedCopy(spec.contributions, 32768, 'Extension contribution'),
    scope: current.scope || undefined,
    core: current.scope.startsWith('main-shell'),
    requestedChannel: safeText(spec.resolution?.requestedChannel, 32),
    installedDigest: safeText(registration?.status?.currentDigest, 80),
    currentChannelDigest: safeText(registration?.status?.currentChannelDigest, 80),
    updateState: safeText(registration?.status?.channelState, 64) || undefined,
    channelCheckedAt: safeText(registration?.status?.channelCheckedAt, 64) || undefined,
    channelReason: safeText(registration?.status?.channelReason, 256) || undefined,
  });
}
function projectBinding(binding) {
  const current = metadata(binding, { apiVersion: 'console.opensphere.io/v1alpha1', kind: 'CLIDownload' });
  const spec = binding?.spec || {};
  if (!Array.isArray(spec.links) || spec.links.length > 32) throw fault('CLIDownload link inventory is invalid', 'AuthorityContractViolation');
  const links = spec.links.map((link) => {
    const href = safeText(link?.href, 2048);
    let parsed;
    try { parsed = new URL(href); } catch { throw fault('CLIDownload href is invalid', 'AuthorityContractViolation'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw fault('CLIDownload href is outside the HTTPS artifact boundary', 'AuthorityContractViolation');
    return Object.freeze({
      ...(link.os ? { os: safeText(link.os, 16) } : {}),
      ...(link.arch ? { arch: safeText(link.arch, 32) } : {}),
      text: safeText(link.text, 160),
      href,
    });
  });
  return Object.freeze({
    kind: 'CLIDownload',
    name: current.name,
    displayName: safeText(spec.displayName, 160, current.name),
    description: safeText(spec.description, 1000),
    enabled: spec.enabled !== false,
    links,
  });
}
function previousRelease(status) {
  const previous = {
    digest: String(status?.previousDigest || ''),
    manifestSha256: String(status?.previousManifestSha256 || ''),
    version: String(status?.previousVersion || ''),
    artifactVersion: String(status?.previousArtifactVersion || ''),
    repository: String(status?.previousRepository || ''),
    manifestPath: String(status?.previousManifestPath || ''),
    signaturePath: String(status?.previousSignaturePath || ''),
    staticContractSha256: String(status?.previousStaticContractSha256 || ''),
    compatibilityVersion: String(status?.previousCompatibilityVersion || ''),
    buildAuthority: String(status?.previousBuildAuthority || ''),
    requestedRef: String(status?.previousRequestedRef || ''),
    requestedChannel: String(status?.previousRequestedChannel || ''),
    resolvedAt: String(status?.previousResolvedAt || ''),
    source: String(status?.previousSource || ''),
    revision: String(status?.previousRevision || ''),
    signatureIdentity: String(status?.previousSignatureIdentity || ''),
    evidenceRefs: Array.isArray(status?.previousEvidenceRefs) ? status.previousEvidenceRefs.map(String) : [],
    registryCredentialsRequired: status?.previousRegistryCredentialsRequired,
  };
  if (!DIGEST.test(previous.digest) || !MANIFEST_DIGEST.test(previous.manifestSha256)
      || !COMPATIBILITY_VERSION.test(previous.version) || !ARTIFACT_VERSION.test(previous.artifactVersion)
      || !IMAGE_REPOSITORY.test(previous.repository)
      || !FILE_PATH.test(previous.manifestPath) || !previous.manifestPath.endsWith('.json')
      || !FILE_PATH.test(previous.signaturePath) || !previous.signaturePath.endsWith('.sig')
      || !MANIFEST_DIGEST.test(previous.staticContractSha256)
      || !COMPATIBILITY_VERSION.test(previous.compatibilityVersion)
      || !['localhost', 'github-actions'].includes(previous.buildAuthority)
      || !previous.requestedRef || previous.requestedRef.length > 512 || /[\u0000-\u001f\u007f]/u.test(previous.requestedRef)
      || !['', 'edge', 'candidate', 'stable', 'ga'].includes(previous.requestedChannel)
      || previous.resolvedAt.length < 20 || previous.resolvedAt.length > 64 || !Number.isFinite(Date.parse(previous.resolvedAt))
      || !previous.source || previous.source.length > 256 || /[\u0000-\u001f\u007f]/u.test(previous.source)
      || !SOURCE_REVISION.test(previous.revision)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(previous.signatureIdentity)
      || previous.evidenceRefs.length < 1 || previous.evidenceRefs.length > 32
      || previous.evidenceRefs.some((entry) => !entry || entry.length > 512 || /[\u0000-\u001f\u007f]/u.test(entry))
      || new Set(previous.evidenceRefs).size !== previous.evidenceRefs.length
      || typeof previous.registryCredentialsRequired !== 'boolean') {
    throw fault('verified previous Extension release evidence is unavailable', 'PreviousReleaseUnavailable', 409);
  }
  return Object.freeze(previous);
}

export function createKubernetesExtensionManagementAuthority({
  baseUrl,
  token,
  namespace = 'opensphere-console',
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  maximumResponseBytes = 1024 * 1024,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof token !== 'string' || token.length < 20 || /\s/u.test(token)
      || !DNS_LABEL.test(namespace) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
      || !Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 4096 || maximumResponseBytes > 4 * 1024 * 1024) {
    throw new TypeError('Kubernetes Extension management configuration is invalid');
  }
  const origin = apiOrigin(baseUrl);
  const packages = `/apis/plugins.opensphere.io/v1alpha1/namespaces/${namespace}/uipluginpackages`;
  const registrations = `/apis/plugins.opensphere.io/v1alpha1/namespaces/${namespace}/uipluginregistrations`;
  const bindings = '/apis/console.opensphere.io/v1alpha1/clidownloads';

  async function request(method, path, body, accepted = [200], sideEffect = 'none') {
    let response;
    try {
      response = await fetchImpl(origin + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/merge-patch+json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw fault('Kubernetes management authority is unavailable', 'AuthorityUnavailable', 503, sideEffect, true);
    }
    const value = await boundedJson(response, maximumResponseBytes);
    if (!accepted.includes(response.status)) {
      const code = response.status === 404 ? 'ResourceNotFound'
        : response.status === 409 ? 'WriteConflict' : response.status >= 500 ? 'AuthorityUnavailable' : 'OwnerRejected';
      throw fault(`Kubernetes management request failed with HTTP ${response.status}`, code,
        response.status === 404 ? 404 : response.status === 409 ? 409 : response.status >= 500 ? 503 : 403,
        sideEffect, response.status === 409 || response.status >= 500);
    }
    return value;
  }
  async function inventories() {
    const [packageList, registrationList] = await Promise.all([request('GET', packages), request('GET', registrations)]);
    const packageItems = boundedList(packageList);
    const registrationItems = boundedList(registrationList);
    const packagesByName = new Map();
    for (const item of packageItems) {
      const current = packageIdentity(item, String(item?.metadata?.name || ''), namespace);
      if (packagesByName.has(current.name)) throw fault('duplicate UIPluginPackage identity', 'AuthorityContractViolation');
      packagesByName.set(current.name, item);
    }
    const registrationsByName = new Map();
    for (const item of registrationItems) {
      const current = registrationIdentity(item, String(item?.metadata?.name || ''), namespace);
      if (registrationsByName.has(current.name)) throw fault('duplicate UIPluginRegistration identity', 'AuthorityContractViolation');
      registrationsByName.set(current.name, item);
    }
    return Object.freeze({ packageItems, registrationItems, packagesByName, registrationsByName });
  }
  return Object.freeze({
    async catalog(preferences = new Map()) {
      const inventory = await inventories();
      return Object.freeze(inventory.packageItems
        .map((pkg) => projectPackage(pkg, inventory.registrationsByName.get(pkg?.metadata?.name), preferences.get(pkg?.metadata?.name), namespace))
        .sort((left, right) => left.name.localeCompare(right.name)));
    },
    async registrations() {
      const inventory = await inventories();
      return Object.freeze(inventory.registrationItems.map((item) => projectRegistration(item, namespace)).sort((left, right) => left.name.localeCompare(right.name)));
    },
    async bindings() {
      const projected = boundedList(await request('GET', bindings)).map(projectBinding);
      if (new Set(projected.map((binding) => binding.name)).size !== projected.length) {
        throw fault('duplicate CLIDownload identity', 'AuthorityContractViolation');
      }
      return Object.freeze(projected.filter((binding) => !NATIVE_BINDINGS.has(binding.name))
        .sort((left, right) => left.name.localeCompare(right.name)));
    },
    async setDesiredState({ id, desiredState, actorRef, reason }) {
      if (!DNS_LABEL.test(String(id || '')) || !['Enabled', 'Disabled', 'Uninstalled'].includes(desiredState)
          || !exactMutationText(actorRef, 1, 128)
          || !exactMutationText(reason, 8, 500)) {
        throw fault('Extension desired-state request is invalid', 'ValidationFailed', 400);
      }
      const [pkg, registration] = await Promise.all([request('GET', `${packages}/${id}`), request('GET', `${registrations}/${id}`)]);
      const packageMetadata = packageIdentity(pkg, id, namespace);
      const current = registrationIdentity(registration, id, namespace);
      if (packageMetadata.name !== id) throw fault('UIPluginPackage identity changed', 'AuthorityContractViolation');
      if (packageMetadata.scope.startsWith('main-shell') && ['Disabled', 'Uninstalled'].includes(desiredState)) {
        throw fault('shell-pinned core Extension cannot be disabled or uninstalled', 'CoreExtensionImmutable', 409);
      }
      const patched = await request('PATCH', `${registrations}/${id}`, {
        metadata: { resourceVersion: current.resourceVersion },
        spec: { desiredState, approval: { requestedBy: actorRef, reason: reason.trim() } },
      }, [200], 'unknown');
      const observed = registrationIdentity(patched, id, namespace);
      if (patched?.spec?.desiredState !== desiredState || observed.uid !== current.uid
          || observed.resourceVersion === current.resourceVersion) {
        throw fault('Kubernetes returned mismatched desired-state evidence', 'AuthorityContractViolation', 503, 'present');
      }
      return Object.freeze({ id, desiredState, registrationResourceVersionBefore: current.resourceVersion, registrationResourceVersion: observed.resourceVersion });
    },
    async rollback({ id, actorRef, reason }) {
      if (!DNS_LABEL.test(String(id || '')) || !exactMutationText(actorRef, 1, 128)
          || !exactMutationText(reason, 8, 500)) {
        throw fault('Extension rollback request is invalid', 'ValidationFailed', 400);
      }
      const [pkg, registration] = await Promise.all([request('GET', `${packages}/${id}`), request('GET', `${registrations}/${id}`)]);
      const packageMetadata = packageIdentity(pkg, id, namespace);
      const current = registrationIdentity(registration, id, namespace);
      if (packageMetadata.name !== id || !DIGEST.test(String(pkg?.spec?.image?.digest || ''))) throw fault('UIPluginPackage rollback target is invalid', 'AuthorityContractViolation');
      const previous = previousRelease(registration.status);
      let currentStaticContractSha256;
      try { currentStaticContractSha256 = extensionStaticContractSha256(pkg, { namespace }); }
      catch { throw fault('current Extension static contract cannot be verified for rollback', 'PreviousReleaseUnavailable', 409); }
      if (currentStaticContractSha256 !== previous.staticContractSha256) {
        throw fault('previous Extension static contract differs from the current Package', 'PreviousReleaseUnavailable', 409);
      }
      if (previous.digest === pkg.spec.image.digest) throw fault('previous Extension release is already current', 'StaleAuthorityRevision', 409);
      const patchedPackage = await request('PATCH', `${packages}/${id}`, {
        metadata: { resourceVersion: packageMetadata.resourceVersion },
        spec: {
          version: previous.version,
          image: { repository: previous.repository, digest: previous.digest },
          manifest: { path: previous.manifestPath, sha256: previous.manifestSha256, signaturePath: previous.signaturePath },
          trust: { keyId: previous.signatureIdentity },
          resolution: {
            requestedRef: previous.requestedRef, requestedChannel: previous.requestedChannel,
            resolvedDigest: previous.digest, resolvedAt: previous.resolvedAt,
            artifactVersion: previous.artifactVersion, compatibilityVersion: previous.compatibilityVersion,
            buildAuthority: previous.buildAuthority, source: previous.source, revision: previous.revision,
            signatureIdentity: previous.signatureIdentity,
            registryCredentialsRequired: previous.registryCredentialsRequired, evidenceRefs: previous.evidenceRefs,
          },
        },
      }, [200], 'unknown');
      const appliedPackage = packageIdentity(patchedPackage, id, namespace);
      const appliedResolution = patchedPackage?.spec?.resolution || {};
      if (appliedPackage.name !== id || appliedPackage.uid !== packageMetadata.uid
          || appliedPackage.resourceVersion === packageMetadata.resourceVersion
          || patchedPackage?.spec?.version !== previous.version
          || patchedPackage?.spec?.image?.repository !== previous.repository
          || patchedPackage?.spec?.image?.digest !== previous.digest
          || patchedPackage?.spec?.manifest?.path !== previous.manifestPath
          || patchedPackage?.spec?.manifest?.sha256 !== previous.manifestSha256
          || patchedPackage?.spec?.manifest?.signaturePath !== previous.signaturePath
          || patchedPackage?.spec?.trust?.keyId !== previous.signatureIdentity
          || appliedResolution.requestedRef !== previous.requestedRef
          || appliedResolution.requestedChannel !== previous.requestedChannel
          || appliedResolution.resolvedDigest !== previous.digest || appliedResolution.resolvedAt !== previous.resolvedAt
          || appliedResolution.artifactVersion !== previous.artifactVersion
          || appliedResolution.compatibilityVersion !== previous.compatibilityVersion
          || appliedResolution.buildAuthority !== previous.buildAuthority || appliedResolution.source !== previous.source
          || appliedResolution.revision !== previous.revision || appliedResolution.signatureIdentity !== previous.signatureIdentity
          || appliedResolution.registryCredentialsRequired !== previous.registryCredentialsRequired
          || JSON.stringify(appliedResolution.evidenceRefs) !== JSON.stringify(previous.evidenceRefs)) {
        throw fault('Kubernetes returned mismatched rollback Package evidence', 'AuthorityContractViolation', 503, 'present');
      }
      let patchedRegistration;
      try {
        patchedRegistration = await request('PATCH', `${registrations}/${id}`, {
          metadata: { resourceVersion: current.resourceVersion },
          spec: { desiredState: 'Enabled', approval: { requestedBy: actorRef, reason: reason.trim() } },
        }, [200], 'present');
      } catch (error) {
        if (!error.sideEffect || error.sideEffect === 'none') error.sideEffect = 'present';
        throw error;
      }
      const observed = registrationIdentity(patchedRegistration, id, namespace);
      if (patchedRegistration?.spec?.desiredState !== 'Enabled' || observed.uid !== current.uid
          || observed.resourceVersion === current.resourceVersion) {
        throw fault('Kubernetes returned mismatched rollback Registration evidence', 'AuthorityContractViolation', 503, 'present');
      }
      return Object.freeze({
        id, desiredState: 'Enabled', digest: previous.digest, artifactVersion: previous.artifactVersion,
        packageResourceVersionBefore: packageMetadata.resourceVersion, packageResourceVersion: appliedPackage.resourceVersion,
        registrationResourceVersionBefore: current.resourceVersion, registrationResourceVersion: observed.resourceVersion,
      });
    },
    async setBindingEnabled({ name, enabled }) {
      if (!DNS_LABEL.test(String(name || '')) || NATIVE_BINDINGS.has(name) || typeof enabled !== 'boolean') {
        throw fault('CLIDownload binding mutation is invalid', 'ValidationFailed', 400);
      }
      const current = await request('GET', `${bindings}/${name}`);
      const before = metadata(current, { apiVersion: 'console.opensphere.io/v1alpha1', kind: 'CLIDownload' });
      if (before.name !== name || !Array.isArray(current?.spec?.links)) throw fault('CLIDownload binding target is invalid', 'AuthorityContractViolation');
      const patched = await request('PATCH', `${bindings}/${name}`, {
        metadata: { resourceVersion: before.resourceVersion }, spec: { enabled },
      }, [200], 'unknown');
      const after = metadata(patched, { apiVersion: 'console.opensphere.io/v1alpha1', kind: 'CLIDownload' });
      if (after.name !== name || after.uid !== before.uid
          || after.resourceVersion === before.resourceVersion || patched?.spec?.enabled !== enabled) {
        throw fault('Kubernetes returned mismatched CLIDownload evidence', 'AuthorityContractViolation', 503, 'present');
      }
      return Object.freeze({ name, enabled, resourceVersionBefore: before.resourceVersion, resourceVersion: after.resourceVersion });
    },
    async navigationInventory() {
      const inventory = await inventories();
      const registered = new Set(inventory.registrationItems.map((item) => registrationIdentity(item, item?.metadata?.name, namespace).name));
      return Object.freeze(inventory.packageItems
        .filter((pkg) => pkg?.spec?.kind === 'subShell' && pkg?.spec?.hostRef === 'main' && registered.has(pkg?.metadata?.name))
        .map((pkg) => packageIdentity(pkg, String(pkg?.metadata?.name || ''), namespace).name).sort());
    },
  });
}
