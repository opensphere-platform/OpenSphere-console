import {
  buildExtensionWorkloadPlan,
  extensionReleaseContract,
  parseTrustedExtensionKeys,
  verifyExtensionRelease,
} from './extension-release.mjs';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RESOURCE_VERSION = /^[0-9A-Za-z._:-]{1,128}$/u;
const MAX_REGISTRATIONS = 256;
const TERMINAL_VERIFICATION = new Set([
  'PackageContractViolation', 'UnsupportedPermissionProfile', 'UnsafeRuntimeContract',
  'ManifestDigestMismatch', 'ManifestInvalid', 'UntrustedKey', 'ManifestSignatureInvalid',
  'ManifestContractMismatch', 'ApiNamespaceViolation', 'EntryDigestMismatch',
  'NonClosedModuleArtifact', 'AssetContractInvalid', 'AssetDigestMismatch',
  'RegistrationContractViolation', 'ResourceOwnershipMismatch', 'ReleaseRevisionCollision', 'TrustedKeysInvalid',
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

function exactRegistration(registration, namespace) {
  const metadata = registration?.metadata || {};
  const spec = registration?.spec || {};
  const name = String(metadata.name || '');
  if (registration?.apiVersion !== 'plugins.opensphere.io/v1alpha1' || registration?.kind !== 'UIPluginRegistration'
      || metadata.namespace !== namespace || !DNS_LABEL.test(name)
      || !RESOURCE_VERSION.test(String(metadata.resourceVersion || ''))
      || typeof metadata.uid !== 'string' || metadata.uid.length < 1 || metadata.uid.length > 128
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
      || typeof resource?.metadata?.uid !== 'string' || resource.metadata.uid.length < 1 || resource.metadata.uid.length > 128
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
    const result = await request('PATCH', `${registrations}/${current.name}/status`, {
      metadata: { resourceVersion: current.resourceVersion }, status,
    });
    return result.value;
  }

  async function upsert(item, plan, { allowRevisionChange = false } = {}) {
    const name = item.manifest.metadata.name;
    const existing = await request('GET', `${item.basePath}/${name}`, undefined, [200, 404]);
    if (existing.status === 404) {
      await request('POST', item.basePath, item.manifest, [200, 201]);
      return 'created';
    }
    exactRevisionResource(existing.value, item, plan, allowRevisionChange);
    await request('PATCH', `${item.basePath}/${name}`, {
      ...item.manifest,
      metadata: { ...item.manifest.metadata, resourceVersion: String(existing.value.metadata.resourceVersion) },
    });
    return 'patched';
  }

  async function remove(item, plan, { allowRevisionChange = false } = {}) {
    const name = item.manifest.metadata.name;
    const existing = await request('GET', `${item.basePath}/${name}`, undefined, [200, 404]);
    if (existing.status === 404) return false;
    exactRevisionResource(existing.value, item, plan, allowRevisionChange);
    await request('DELETE', `${item.basePath}/${name}`, {
      apiVersion: 'v1', kind: 'DeleteOptions',
      preconditions: existing.value?.metadata?.uid ? { uid: String(existing.value.metadata.uid) } : undefined,
      propagationPolicy: 'Foreground',
    }, [200, 202, 204, 404]);
    return true;
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
    const terminal = TERMINAL_VERIFICATION.has(String(error?.code || ''));
    await patchStatus(registration, {
      observedGeneration: current.generation,
      phase: terminal ? 'Failed' : 'DependencyPending',
      retryable: !terminal,
      reason: String(error?.code || 'AuthorityUnavailable').slice(0, 128),
      workload: { phase: 'NotReady' },
      verification: { manifest: 'Failed', signature: 'Failed', entryDigest: 'Failed', permissions: 'Approved' },
      serving: { phase: 'Unavailable' },
      revalidation: { phase: 'Failed' },
    });
    return Object.freeze({ state: terminal ? 'Failed' : 'Pending', extensionId: current.name, reason: String(error?.code || 'AuthorityUnavailable') });
  }

  let lastRegistrationName = '';
  return Object.freeze({
    async reconcileOnce() {
      const listed = await request('GET', registrations);
      const items = Array.isArray(listed.value?.items) ? listed.value.items : [];
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
        plan = buildExtensionWorkloadPlan(pkg, { namespace });
      } catch (error) {
        return markFailure(registration, error);
      }
      if (pkg?.metadata?.name !== current.name) return markFailure(registration, fault('Package identity changed', 'PackageContractViolation'));

      if (current.desiredState === 'Uninstalled') {
        try {
          await remove(plan.activeService, plan, { allowRevisionChange: true });
          for (const item of [...plan.resources].reverse()) await remove(item, plan);
          await request('DELETE', `${registrations}/${current.name}`, {
            apiVersion: 'v1', kind: 'DeleteOptions',
            preconditions: { uid: current.uid, resourceVersion: current.resourceVersion },
            propagationPolicy: 'Foreground',
          }, [200, 202, 204, 404]);
          return Object.freeze({ state: 'Removed', extensionId: current.name, revision: plan.revision });
        } catch (error) { return markFailure(registration, error); }
      }

      try {
        for (const item of plan.resources) await upsert(item, plan);
        const deployment = (await request('GET', `${plan.resources[1].basePath}/${plan.revisionResourceName}`)).value;
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
        await patchStatus(registration, {
          observedGeneration: current.generation,
          ...previousRelease,
          phase: current.desiredState === 'Enabled' ? 'Activated' : current.desiredState === 'Disabled' ? 'Disabled' : 'Ready',
          retryable: false, reason: '', observedVersion: plan.contract.version,
          currentDigest: plan.contract.imageDigest,
          currentManifestSha256: plan.contract.manifestSha256,
          currentVersion: plan.contract.version,
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
