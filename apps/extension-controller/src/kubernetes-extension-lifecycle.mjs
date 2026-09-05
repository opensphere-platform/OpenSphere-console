import {
  buildExtensionWorkloadPlan,
  extensionReleaseContract,
  parseTrustedExtensionKeys,
  planInactiveExtensionRevisionCleanup,
  verifyExtensionRelease,
} from './extension-release.mjs';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RESOURCE_VERSION = /^[0-9A-Za-z._:-]{1,128}$/u;
const IMAGE_REPOSITORY = /^ghcr[.]io\/opensphere-platform\/[a-z0-9][a-z0-9._-]{0,127}$/u;
const FILE_PATH = /^\/plugins\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const MAX_REGISTRATIONS = 256;
const TERMINAL_VERIFICATION = new Set([
  'PackageContractViolation', 'UnsupportedPermissionProfile', 'UnsafeRuntimeContract', 'ModuleReleaseInvalid',
  'ManifestDigestMismatch', 'ManifestInvalid', 'UntrustedKey', 'ManifestSignatureInvalid',
  'ManifestContractMismatch', 'ApiNamespaceViolation', 'EntryDigestMismatch',
  'NonClosedModuleArtifact', 'AssetContractInvalid', 'AssetDigestMismatch', 'ArtifactTooLarge',
  'RegistrationContractViolation', 'ResourceOwnershipMismatch', 'ReleaseRevisionCollision', 'TrustedKeysInvalid',
  'AuthorityContractViolation',
]);

function fault(message, code, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
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
  if (Number.isFinite(declared) && declared > maximumBytes) throw fault('Kubernetes response is too large', 'AuthorityContractViolation');
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw fault('Kubernetes response is too large', 'AuthorityContractViolation');
    }
    chunks.push(Buffer.from(value));
  }
  try { return length ? JSON.parse(Buffer.concat(chunks, length).toString('utf8')) : null; }
  catch { throw fault('Kubernetes response is invalid JSON', 'AuthorityContractViolation'); }
}

function validUid(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactRegistration(registration, namespace) {
  const metadata = registration?.metadata || {};
  const spec = registration?.spec || {};
  const name = String(metadata.name || '');
  if (registration?.apiVersion !== 'plugins.opensphere.io/v1alpha1' || registration?.kind !== 'UIPluginRegistration'
      || metadata.namespace !== namespace || !DNS_LABEL.test(name)
      || !RESOURCE_VERSION.test(String(metadata.resourceVersion || ''))
      || !validUid(metadata.uid)
      || !Number.isSafeInteger(Number(metadata.generation)) || Number(metadata.generation) < 1
      || spec.packageRef?.name !== name
      || !['Installed', 'Enabled', 'Disabled', 'Uninstalled'].includes(spec.desiredState)) {
    throw fault('UIPluginRegistration contract is invalid', 'RegistrationContractViolation');
  }
  return Object.freeze({
    name, uid: String(metadata.uid), resourceVersion: String(metadata.resourceVersion),
    generation: Number(metadata.generation), desiredState: spec.desiredState,
  });
}

function ownedByPackage(resource, plan) {
  const metadata = resource?.metadata || {};
  const labels = metadata.labels || {};
  const owners = Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences : [];
  return labels['app.kubernetes.io/managed-by'] === extensionReleaseContract.managedBy
    && labels[extensionReleaseContract.extensionLabel] === plan.contract.name
    && owners.some((owner) => owner.apiVersion === 'plugins.opensphere.io/v1alpha1'
      && owner.kind === 'UIPluginPackage' && owner.name === plan.contract.name
      && owner.uid === plan.contract.uid);
}

function exactRevisionResource(resource, item, plan, allowRevisionChange = false) {
  if (resource?.kind !== item.manifest.kind || resource?.metadata?.name !== item.manifest.metadata.name
      || resource?.metadata?.namespace !== plan.contract.namespace
      || !validUid(resource?.metadata?.uid)
      || !RESOURCE_VERSION.test(String(resource?.metadata?.resourceVersion || '')) || !ownedByPackage(resource, plan)) {
    throw fault('refusing to replace an unowned Extension resource', 'ResourceOwnershipMismatch');
  }
  const annotations = resource.metadata?.annotations || {};
  if (!allowRevisionChange) {
    if (annotations[extensionReleaseContract.imageAnnotation] !== plan.contract.imageDigest
        || annotations[extensionReleaseContract.manifestAnnotation] !== plan.contract.manifestSha256) {
      throw fault('immutable Extension revision identity collided', 'ReleaseRevisionCollision');
    }
  }
}

function includesDesired(actual, desired) {
  if (Array.isArray(desired)) {
    return Array.isArray(actual) && actual.length === desired.length
      && desired.every((value, index) => includesDesired(actual[index], value));
  }
  if (desired && typeof desired === 'object') {
    return actual && typeof actual === 'object' && !Array.isArray(actual)
      && Object.entries(desired).every(([key, value]) => includesDesired(actual[key], value));
  }
  return Object.is(actual, desired);
}

function exactAppliedResource(resource, item, plan, { allowRevisionChange = false, previousResourceVersion = '' } = {}) {
  exactRevisionResource(resource, item, plan, allowRevisionChange);
  if (!includesDesired(resource, item.manifest)
      || (previousResourceVersion && String(resource.metadata.resourceVersion) === previousResourceVersion)) {
    throw fault('Kubernetes returned mismatched Extension workload evidence', 'AuthorityContractViolation');
  }
  return resource;
}

function rolloutReady(deployment, plan) {
  const annotations = deployment?.metadata?.annotations || {};
  const container = deployment?.spec?.template?.spec?.containers?.[0] || {};
  const desired = Number(deployment?.spec?.replicas || plan.contract.replicas);
  return deployment?.metadata?.name === plan.revisionResourceName
    && ownedByPackage(deployment, plan)
    && annotations[extensionReleaseContract.imageAnnotation] === plan.contract.imageDigest
    && annotations[extensionReleaseContract.manifestAnnotation] === plan.contract.manifestSha256
    && container.image === `${plan.contract.repository}@${plan.contract.imageDigest}`
    && Number(deployment?.status?.observedGeneration) >= Number(deployment?.metadata?.generation)
    && Number(deployment?.status?.updatedReplicas || 0) >= desired
    && Number(deployment?.status?.availableReplicas || 0) >= desired
    && Number(deployment?.status?.unavailableReplicas || 0) === 0;
}

export function projectPreviousVerifiedRelease(registration, plan) {
  const status = registration?.status || {};
  const digest = String(status.currentDigest || '');
  const manifestSha256 = String(status.currentManifestSha256 || '');
  if (!digest && !manifestSha256) return Object.freeze({});
  if (digest === plan.contract.imageDigest && manifestSha256 === plan.contract.manifestSha256) {
    return Object.freeze({});
  }
  const evidenceRefs = status.currentEvidenceRefs;
  const serving = status.serving || {};
  const verification = status.verification || {};
  const valid = /^sha256:[a-f0-9]{64}$/u.test(digest)
    && /^[a-f0-9]{64}$/u.test(manifestSha256)
    && /^[0-9]+[.][0-9]+[.][0-9]+$/u.test(String(status.currentVersion || ''))
    && /^[0-9]{12}$/u.test(String(status.currentArtifactVersion || ''))
    && IMAGE_REPOSITORY.test(String(status.currentRepository || ''))
    && FILE_PATH.test(String(status.currentManifestPath || '')) && String(status.currentManifestPath).endsWith('.json')
    && FILE_PATH.test(String(status.currentSignaturePath || '')) && String(status.currentSignaturePath).endsWith('.sig')
    && HEX_DIGEST.test(String(status.currentStaticContractSha256 || ''))
    && /^[0-9]+[.][0-9]+[.][0-9]+$/u.test(String(status.currentCompatibilityVersion || ''))
    && ['localhost', 'github-actions'].includes(status.currentBuildAuthority)
    && typeof status.currentRequestedRef === 'string' && status.currentRequestedRef.length >= 1
    && status.currentRequestedRef.length <= 512
    && ['', 'edge', 'candidate', 'stable', 'ga'].includes(status.currentRequestedChannel)
    && typeof status.currentResolvedAt === 'string' && Number.isFinite(Date.parse(status.currentResolvedAt))
    && typeof status.currentSource === 'string' && status.currentSource.length >= 1 && status.currentSource.length <= 256
    && /^[a-f0-9]{40}$/u.test(String(status.currentRevision || ''))
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(String(status.currentSignatureIdentity || ''))
    && Array.isArray(evidenceRefs) && evidenceRefs.length >= 1 && evidenceRefs.length <= 32
    && evidenceRefs.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(item))
    && new Set(evidenceRefs).size === evidenceRefs.length
    && typeof status.currentRegistryCredentialsRequired === 'boolean'
    && verification.manifest === 'Verified' && verification.signature === 'Verified'
    && verification.entryDigest === 'Verified' && verification.permissions === 'Approved'
    && ['Current', 'Disabled'].includes(serving.phase)
    && serving.digest === digest && serving.manifestSha256 === manifestSha256;
  if (!valid) {
    throw fault('previous Extension release evidence is incomplete or unverified', 'RegistrationContractViolation');
  }
  return Object.freeze({
    previousDigest: digest,
    previousManifestSha256: manifestSha256,
    previousVersion: status.currentVersion,
    previousArtifactVersion: status.currentArtifactVersion,
    previousRepository: status.currentRepository,
    previousManifestPath: status.currentManifestPath,
    previousSignaturePath: status.currentSignaturePath,
    previousStaticContractSha256: status.currentStaticContractSha256,
    previousCompatibilityVersion: status.currentCompatibilityVersion,
    previousBuildAuthority: status.currentBuildAuthority,
    previousRequestedRef: status.currentRequestedRef,
    previousRequestedChannel: status.currentRequestedChannel,
    previousResolvedAt: status.currentResolvedAt,
    previousSource: status.currentSource,
    previousRevision: status.currentRevision,
    previousSignatureIdentity: status.currentSignatureIdentity,
    previousEvidenceRefs: [...evidenceRefs],
    previousRegistryCredentialsRequired: status.currentRegistryCredentialsRequired,
  });
}

export function createKubernetesExtensionLifecycle({
  baseUrl,
  token,
  namespace = 'opensphere-console',
  trustedKeysConfigMap = 'opensphere-extension-trusted-keys',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  maximumResponseBytes = 1024 * 1024,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof token !== 'string' || token.length < 20 || /\s/u.test(token)
      || !DNS_LABEL.test(namespace) || !DNS_LABEL.test(trustedKeysConfigMap)
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
      || !Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 4096 || maximumResponseBytes > 4 * 1024 * 1024) {
    throw new TypeError('Kubernetes Extension lifecycle configuration is invalid');
  }
  const origin = apiOrigin(baseUrl);
  const registrations = `/apis/plugins.opensphere.io/v1alpha1/namespaces/${namespace}/uipluginregistrations`;
  const packages = `/apis/plugins.opensphere.io/v1alpha1/namespaces/${namespace}/uipluginpackages`;

  async function request(method, path, body, accepted = [200]) {
    let response;
    try {
      response = await fetchImpl(origin + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`, accept: 'application/json',
          ...(body ? { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw fault('Kubernetes authority is unavailable', 'AuthorityUnavailable', true); }
    const value = await boundedJson(response, maximumResponseBytes);
    if (!accepted.includes(response.status)) {
      const code = response.status === 404 ? 'ResourceNotFound'
        : response.status === 409 ? 'WriteConflict'
          : response.status >= 500 ? 'AuthorityUnavailable' : 'OwnerRejected';
      throw fault(`Kubernetes request failed with HTTP ${response.status}`, code, response.status >= 500 || response.status === 409);
    }
    return Object.freeze({ status: response.status, value });
  }

  async function patchStatus(registration, status) {
    const current = exactRegistration(registration, namespace);
    // A repeated reconciliation need not write an identical status. Kubernetes
    // legitimately retains resourceVersion for no-op writes; changed writes below
    // still require a new version and exact UID/generation/status evidence.
    if (includesDesired(registration.status, status)) return registration;
    const result = await request('PATCH', `${registrations}/${current.name}/status`, {
      metadata: { resourceVersion: current.resourceVersion }, status,
    });
    const observed = exactRegistration(result.value, namespace);
    if (observed.name !== current.name || observed.uid !== current.uid
        || observed.resourceVersion === current.resourceVersion || observed.generation !== current.generation
        || !includesDesired(result.value.status, status)) {
      throw fault('Kubernetes returned mismatched Registration status evidence', 'AuthorityContractViolation');
    }
    return result.value;
  }

  async function upsert(item, plan, { allowRevisionChange = false } = {}) {
    const name = item.manifest.metadata.name;
    const existing = await request('GET', `${item.basePath}/${name}`, undefined, [200, 404]);
    if (existing.status === 404) {
      const created = await request('POST', item.basePath, item.manifest, [200, 201]);
      exactAppliedResource(created.value, item, plan, { allowRevisionChange });
      return 'created';
    }
    exactRevisionResource(existing.value, item, plan, allowRevisionChange);
    if (includesDesired(existing.value, item.manifest)) return 'unchanged';
    const resourceVersion = String(existing.value.metadata.resourceVersion);
    const patched = await request('PATCH', `${item.basePath}/${name}`, {
      ...item.manifest,
      metadata: { ...item.manifest.metadata, resourceVersion },
    });
    exactAppliedResource(patched.value, item, plan, { allowRevisionChange, previousResourceVersion: resourceVersion });
    return 'patched';
  }

  async function remove(item, plan, { allowRevisionChange = false } = {}) {
    const name = item.manifest.metadata.name;
    const existing = await request('GET', `${item.basePath}/${name}`, undefined, [200, 404]);
    if (existing.status === 404) return false;
    exactRevisionResource(existing.value, item, plan, allowRevisionChange);
    const uid = String(existing.value.metadata.uid);
    await request('DELETE', `${item.basePath}/${name}`, {
      apiVersion: 'v1', kind: 'DeleteOptions',
      preconditions: {
        uid,
        resourceVersion: String(existing.value.metadata.resourceVersion),
      },
      propagationPolicy: 'Foreground',
    }, [200, 202, 204, 404]);
    const remaining = await request('GET', `${item.basePath}/${name}`, undefined, [200, 404]);
    if (remaining.status === 404) return true;
    exactRevisionResource(remaining.value, item, plan, allowRevisionChange);
    if (String(remaining.value.metadata.uid) !== uid) {
      throw fault('Extension resource was replaced while deletion was observed', 'ResourceOwnershipMismatch');
    }
    throw fault('Extension resource deletion is not yet observed', 'DeletionPending', true);
  }

  async function revisionInventories(plan) {
    const byPath = new Map();
    for (const item of plan.resources) {
      if (byPath.has(item.basePath)) continue;
      const result = await request('GET', item.basePath);
      if (!result.value || typeof result.value !== 'object' || !Array.isArray(result.value.items)) {
        throw fault('Extension revision inventory response is malformed', 'AuthorityContractViolation');
      }
      byPath.set(item.basePath, Object.freeze({
        basePath: item.basePath,
        kind: item.manifest.kind,
        // Typed Kubernetes lists omit TypeMeta on their items. Inherit only from
        // an exact collection envelope; never replace an explicit conflicting type.
        items: result.value.items.map((resource) => {
          if (resource?.apiVersion !== undefined && resource?.kind !== undefined) return resource;
          if (!resource || typeof resource !== 'object' || Array.isArray(resource)
              || result.value.apiVersion !== item.manifest.apiVersion
              || result.value.kind !== `${item.manifest.kind}List`) {
            throw fault('Extension revision inventory has no authoritative item type', 'AuthorityContractViolation');
          }
          return {
            ...resource,
            apiVersion: resource.apiVersion === undefined ? result.value.apiVersion : resource.apiVersion,
            kind: resource.kind === undefined ? item.manifest.kind : resource.kind,
          };
        }),
      }));
    }
    return [...byPath.values()];
  }

  function exactCleanupCandidate(resource, candidate, plan, { allowResourceVersionChange = false } = {}) {
    const metadata = resource?.metadata || {};
    const labels = metadata.labels || {};
    const annotations = metadata.annotations || {};
    const owners = Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences : [];
    const resourceVersion = String(metadata.resourceVersion || '');
    const exactOwner = owners.some((owner) => owner?.apiVersion === 'plugins.opensphere.io/v1alpha1'
      && owner?.kind === 'UIPluginPackage' && owner?.name === plan.contract.name
      && owner?.uid === plan.contract.uid && owner?.controller === true
      && owner?.blockOwnerDeletion === false);
    if (resource?.apiVersion !== candidate.apiVersion || resource?.kind !== candidate.kind
        || metadata.name !== candidate.name || metadata.namespace !== plan.contract.namespace
        || metadata.uid !== candidate.uid || !RESOURCE_VERSION.test(resourceVersion)
        || (!allowResourceVersionChange && resourceVersion !== candidate.resourceVersion)
        || labels['app.kubernetes.io/managed-by'] !== extensionReleaseContract.managedBy
        || labels[extensionReleaseContract.extensionLabel] !== plan.contract.name
        || labels[extensionReleaseContract.revisionLabel] !== candidate.revision
        || annotations[extensionReleaseContract.imageAnnotation] !== candidate.imageDigest
        || annotations[extensionReleaseContract.manifestAnnotation] !== candidate.manifestSha256
        || !exactOwner) {
      throw fault('refusing to delete changed or unowned Extension revision', 'ResourceOwnershipMismatch');
    }
    return resource;
  }

  async function removeCleanupCandidate(candidate, plan) {
    const existing = await request('GET', candidate.apiPath, undefined, [200, 404]);
    if (existing.status === 404) return false;
    exactCleanupCandidate(existing.value, candidate, plan);
    await request('DELETE', candidate.apiPath, {
      apiVersion: 'v1', kind: 'DeleteOptions',
      preconditions: { uid: candidate.uid, resourceVersion: candidate.resourceVersion },
      propagationPolicy: 'Foreground',
    }, [200, 202, 204, 404]);
    const remaining = await request('GET', candidate.apiPath, undefined, [200, 404]);
    if (remaining.status === 404) return true;
    exactCleanupCandidate(remaining.value, candidate, plan, { allowResourceVersionChange: true });
    throw fault('Extension revision deletion is not yet observed', 'DeletionPending', true);
  }

  async function cleanupRevisionResources(plan, retainRevision) {
    const candidates = planInactiveExtensionRevisionCleanup({
      plan,
      inventories: await revisionInventories(plan),
      retainRevision,
      maximumDeletes: 8,
    });
    for (const candidate of candidates) await removeCleanupCandidate(candidate, plan);
    return candidates.length;
  }

  async function loadTrustedKeys() {
    const result = await request('GET', `/api/v1/namespaces/${namespace}/configmaps/${trustedKeysConfigMap}`);
    const encoded = result.value?.data?.['trusted-keys.json'];
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 64 * 1024) {
      throw fault('Extension trusted key ConfigMap is invalid', 'TrustedKeysInvalid');
    }
    return parseTrustedExtensionKeys(encoded);
  }

  async function markFailure(registration, error) {
    const current = exactRegistration(registration, namespace);
    const reason = String(error?.code || 'AuthorityUnavailable');
    const terminal = TERMINAL_VERIFICATION.has(reason);
    const permissions = reason === 'UnsupportedPermissionProfile' ? 'Failed' : 'Pending';
    await patchStatus(registration, {
      observedGeneration: current.generation,
      phase: terminal ? 'Failed' : 'DependencyPending',
      retryable: !terminal,
      reason: reason.slice(0, 128),
      workload: { phase: 'NotReady' },
      verification: { manifest: 'Failed', signature: 'Failed', entryDigest: 'Failed', permissions },
      serving: { phase: 'Unavailable' },
      revalidation: { phase: 'Failed' },
    });
    return Object.freeze({ state: terminal ? 'Failed' : 'Pending', extensionId: current.name, reason });
  }

  let lastRegistrationName = '';
  return Object.freeze({
    async reconcileOnce() {
      const listed = await request('GET', registrations);
      if (!listed.value || typeof listed.value !== 'object' || !Array.isArray(listed.value.items)) {
        throw fault('UIPluginRegistration list contract is invalid', 'AuthorityContractViolation');
      }
      const items = listed.value.items;
      if (items.length > MAX_REGISTRATIONS) {
        throw fault('UIPluginRegistration list exceeds its bounded reconciliation set', 'AuthorityContractViolation');
      }
      const ordered = [...items].sort((left, right) => String(left?.metadata?.name || '').localeCompare(String(right?.metadata?.name || '')));
      const registration = ordered.find((item) => String(item?.metadata?.name || '').localeCompare(lastRegistrationName) > 0) || ordered[0];
      if (!registration) {
        lastRegistrationName = '';
        return Object.freeze({ state: 'Idle' });
      }
      const current = exactRegistration(registration, namespace);
      lastRegistrationName = current.name;
      let pkg;
      let plan;
      try {
        pkg = (await request('GET', `${packages}/${current.name}`)).value;
        plan = buildExtensionWorkloadPlan(pkg, { namespace,
          trustedKeys: pkg.spec?.permissionProfile === 'cluster-read' ? await loadTrustedKeys() : {},
        });
      } catch (error) {
        return markFailure(registration, error);
      }
      if (pkg?.metadata?.name !== current.name) return markFailure(registration, fault('Package identity changed', 'PackageContractViolation'));

      if (current.desiredState === 'Uninstalled') {
        try {
          await remove(plan.activeService, plan, { allowRevisionChange: true });
          await cleanupRevisionResources(plan, null);
          await request('DELETE', `${registrations}/${current.name}`, {
            apiVersion: 'v1', kind: 'DeleteOptions',
            preconditions: { uid: current.uid, resourceVersion: current.resourceVersion },
            propagationPolicy: 'Foreground',
          }, [200, 202, 204, 404]);
          const remaining = await request('GET', `${registrations}/${current.name}`, undefined, [200, 404]);
          if (remaining.status !== 404) {
            const observed = exactRegistration(remaining.value, namespace);
            if (observed.uid !== current.uid) {
              throw fault('Registration was replaced while deletion was observed', 'ResourceOwnershipMismatch');
            }
            throw fault('Registration deletion is not yet observed', 'DeletionPending', true);
          }
          return Object.freeze({ state: 'Removed', extensionId: current.name, revision: plan.revision });
        } catch (error) { return markFailure(registration, error); }
      }

      try {
        for (const item of plan.resources) await upsert(item, plan);
        let deployment;
        for (const item of plan.resources) {
          const observed = (await request('GET', `${item.basePath}/${item.manifest.metadata.name}`)).value;
          exactAppliedResource(observed, item, plan);
          if (item.manifest.kind === 'Deployment') deployment = observed;
        }
        if (!rolloutReady(deployment, plan)) {
          await patchStatus(registration, {
            observedGeneration: current.generation, phase: 'Installing', retryable: true,
            reason: 'WorkloadNotReady', workload: { phase: 'NotReady' },
            verification: { manifest: 'Pending', signature: 'Pending', entryDigest: 'Pending', permissions: 'Approved' },
            serving: { phase: 'Pending' }, revalidation: { phase: 'Pending' },
          });
          return Object.freeze({ state: 'Pending', extensionId: current.name, reason: 'WorkloadNotReady' });
        }
        const trustedKeys = await loadTrustedKeys();
        const verification = await verifyExtensionRelease({
          pkg, serviceName: plan.revisionResourceName, namespace, trustedKeys, fetchImpl, timeoutMs,
        });
        const previousRelease = projectPreviousVerifiedRelease(registration, plan);
        if (current.desiredState === 'Disabled') {
          await remove(plan.activeService, plan, { allowRevisionChange: true });
        } else {
          await upsert(plan.activeService, plan, { allowRevisionChange: true });
        }
        const active = current.desiredState !== 'Disabled';
        await cleanupRevisionResources(plan, plan.revision);
        await patchStatus(registration, {
          observedGeneration: current.generation,
          ...previousRelease,
          phase: current.desiredState === 'Enabled' ? 'Activated' : current.desiredState === 'Disabled' ? 'Disabled' : 'Ready',
          retryable: false, reason: '', observedVersion: plan.contract.version,
          currentDigest: plan.contract.imageDigest,
          currentManifestSha256: plan.contract.manifestSha256,
          currentVersion: plan.contract.version,
          currentArtifactVersion: plan.contract.artifactVersion,
          currentRepository: plan.contract.repository,
          currentManifestPath: plan.contract.manifestPath,
          currentSignaturePath: plan.contract.signaturePath,
          currentStaticContractSha256: plan.staticContractSha256,
          currentCompatibilityVersion: plan.contract.compatibilityVersion,
          currentBuildAuthority: plan.contract.buildAuthority,
          currentRequestedRef: plan.contract.requestedRef,
          currentRequestedChannel: plan.contract.requestedChannel,
          currentResolvedAt: plan.contract.resolvedAt,
          currentSource: plan.contract.source,
          currentRevision: plan.contract.sourceRevision,
          currentSignatureIdentity: plan.contract.keyId,
          currentEvidenceRefs: plan.contract.evidenceRefs,
          currentRegistryCredentialsRequired: plan.contract.registryCredentialsRequired,
          workload: { phase: 'Ready', deployment: plan.revisionResourceName },
          verification: { manifest: 'Verified', signature: verification.signature, entryDigest: 'Verified', permissions: 'Approved' },
          serving: {
            phase: active ? 'Current' : 'Disabled', digest: plan.contract.imageDigest,
            manifestSha256: plan.contract.manifestSha256,
            artifactServiceId: plan.revisionResourceName,
          },
          revalidation: { phase: 'Passed' },
        });
        return Object.freeze({
          state: active ? (current.desiredState === 'Enabled' ? 'Activated' : 'Ready') : 'Disabled',
          extensionId: current.name, revision: plan.revision,
          manifestSha256: verification.manifestSha256, entrySha256: verification.entrySha256,
        });
      } catch (error) {
        return markFailure(registration, error);
      }
    },
  });
}
