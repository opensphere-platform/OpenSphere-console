import { exactExtensionPackageScope } from './extension-package-scope.mjs';

const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESOURCE_VERSION = /^[0-9A-Za-z._:-]{1,128}$/;

function fault(message, code, retryable = false, terminal = false, sideEffect = 'unknown') {
  return Object.assign(new Error(message), { code, retryable, terminal, sideEffect });
}

function origin(value) {
  const parsed = new URL(value);
  const loopbackTestOrigin = parsed.protocol === 'http:' && ['127.0.0.1', '::1'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !loopbackTestOrigin) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Kubernetes API URL must be a credential-free HTTPS origin or loopback test origin');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

async function responseJson(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw fault('Kubernetes response exceeds the configured limit', 'AuthorityContractViolation');
  }
  if (!response.body) throw fault('Kubernetes returned no response body', 'AuthorityContractViolation');
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
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw fault('Kubernetes returned invalid JSON', 'AuthorityContractViolation'); }
}

function packageCoordinates(candidate) {
  const split = candidate.image.lastIndexOf('@');
  return { repository: candidate.image.slice(0, split), digest: candidate.image.slice(split + 1) };
}

function assertCurrentPackage(pkg, candidate) {
  const packageScope = exactExtensionPackageScope(pkg);
  const coordinates = packageCoordinates(candidate);
  const actual = {
    name: pkg?.metadata?.name,
    resourceVersion: pkg?.metadata?.resourceVersion,
    generation: Number(pkg?.metadata?.generation),
    kind: pkg?.spec?.kind,
    repository: pkg?.spec?.image?.repository,
    digest: pkg?.spec?.image?.digest,
    resolvedDigest: pkg?.spec?.resolution?.resolvedDigest,
    channel: pkg?.spec?.resolution?.requestedChannel,
    sourceRevision: pkg?.spec?.resolution?.revision,
    compatibilityVersion: pkg?.spec?.resolution?.compatibilityVersion,
    signatureIdentity: pkg?.spec?.resolution?.signatureIdentity,
    manifestDigest: pkg?.spec?.manifest?.sha256,
    keyId: pkg?.spec?.trust?.keyId,
  };
  if (actual.name !== candidate.id || actual.resourceVersion !== candidate.packageResourceVersion
      || actual.generation !== candidate.packageGeneration || actual.repository !== coordinates.repository
      || actual.digest !== coordinates.digest || actual.resolvedDigest !== coordinates.digest
      || actual.channel !== candidate.channel || actual.sourceRevision !== candidate.sourceRevision
      || actual.compatibilityVersion !== candidate.compatibilityVersion
      || actual.signatureIdentity !== candidate.keyId || actual.keyId !== candidate.keyId
      || 'sha256:' + String(actual.manifestDigest || '') !== candidate.manifestDigest
      || !['plugin', 'subShell'].includes(actual.kind)) {
    throw fault('UIPluginPackage changed after Registry resolution', 'StaleAuthorityRevision');
  }
  return Object.freeze({ ...actual, ...packageScope });
}

function readyRegistration(registration, candidate, expectedUid) {
  const metadata = registration?.metadata || {};
  const spec = registration?.spec || {};
  const status = registration?.status || {};
  const manifest = candidate.manifestDigest.slice('sha256:'.length);
  if (metadata.name !== candidate.id || String(metadata.uid || '') !== expectedUid
      || !RESOURCE_VERSION.test(String(metadata.resourceVersion || ''))
      || !Number.isSafeInteger(Number(metadata.generation)) || Number(metadata.generation) < 1
      || spec.packageRef?.name !== candidate.id || !['Installed', 'Enabled'].includes(spec.desiredState)) {
    throw fault('UIPluginRegistration identity changed after application', 'ObservationMismatch', false, true, 'unknown');
  }
  if (['Failed', 'Removed'].includes(status.phase)) {
    throw fault('UIPluginRegistration reported a terminal installation failure', 'OwnerRejected', false, true, 'present');
  }
  const desiredReady = (spec.desiredState === 'Installed' && status.phase === 'Ready')
    || (spec.desiredState === 'Enabled' && status.phase === 'Activated');
  const complete = desiredReady
    && Number(status.observedGeneration) >= Number(metadata.generation)
    && status.workload?.phase === 'Ready'
    && status.verification?.manifest === 'Verified'
    && status.verification?.signature === 'Verified'
    && status.verification?.entryDigest === 'Verified'
    && status.verification?.permissions === 'Approved'
    && status.currentDigest === candidate.digest
    && status.currentManifestSha256 === manifest
    && status.currentRevision === candidate.sourceRevision
    && status.currentCompatibilityVersion === candidate.compatibilityVersion
    && status.currentSignatureIdentity === candidate.keyId
    && status.serving?.phase === 'Current'
    && status.serving?.digest === candidate.digest
    && status.serving?.manifestSha256 === manifest
    && status.revalidation?.phase === 'Passed';
  if (!complete) return Object.freeze({ state: 'Pending', reason: 'RegistrationNotReady' });
  return Object.freeze({
    state: 'Ready',
    observation: Object.freeze({
      package: Object.freeze({
        name: candidate.id, resourceVersion: candidate.packageResourceVersion,
        generation: candidate.packageGeneration, digest: candidate.digest,
        manifestDigest: candidate.manifestDigest, sourceRevision: candidate.sourceRevision,
        compatibilityVersion: candidate.compatibilityVersion, keyId: candidate.keyId,
      }),
      registration: Object.freeze({
        name: metadata.name, uid: String(metadata.uid), resourceVersion: String(metadata.resourceVersion),
        generation: Number(metadata.generation), observedGeneration: Number(status.observedGeneration),
        desiredState: spec.desiredState, phase: status.phase,
      }),
      workload: Object.freeze({ phase: status.workload.phase }),
      verification: Object.freeze({
        manifest: status.verification.manifest, signature: status.verification.signature,
        entryDigest: status.verification.entryDigest, permissions: status.verification.permissions,
      }),
      serving: Object.freeze({
        phase: status.serving.phase, digest: status.serving.digest,
        manifestDigest: 'sha256:' + status.serving.manifestSha256,
      }),
      revalidation: Object.freeze({ phase: status.revalidation.phase }),
    }),
  });
}

export function createKubernetesRegistrationWriter({
  baseUrl,
  token,
  namespace = 'opensphere-console',
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  maximumResponseBytes = 128 * 1024,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (typeof token !== 'string' || token.length < 20 || /\s/.test(token)) throw new TypeError('Kubernetes bearer token is required');
  if (!EXTENSION_ID.test(namespace) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
      || !Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 1024 || maximumResponseBytes > 1024 * 1024) {
    throw new TypeError('Kubernetes writer configuration is invalid');
  }
  const apiOrigin = origin(baseUrl);
  const collection = `/apis/plugins.opensphere.io/v1alpha1/namespaces/${namespace}/uipluginregistrations`;
  const packages = `/apis/plugins.opensphere.io/v1alpha1/namespaces/${namespace}/uipluginpackages`;
  async function request(method, path, body, accepted = [200], { withStatus = false } = {}) {
    let response;
    try {
      response = await fetchImpl(apiOrigin + path, {
        method,
        headers: {
          accept: 'application/json', authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw fault('Kubernetes request timed out', 'DependencyTimeout', true);
      throw fault('Kubernetes API is unavailable', 'AuthorityUnavailable', true);
    }
    if (!accepted.includes(response.status)) {
      const code = response.status === 404 ? 'ResourceNotFound'
        : response.status === 409 ? 'WriteConflict'
          : response.status >= 500 ? 'AuthorityUnavailable' : 'OwnerRejected';
      throw fault(`Kubernetes request failed with HTTP ${response.status}`, code, response.status >= 500 || response.status === 409);
    }
    const value = await responseJson(response, maximumResponseBytes);
    return withStatus ? Object.freeze({ status: response.status, value }) : value;
  }
  return Object.freeze({
    async resolvePluginProxyTarget({ serviceId }) {
      if (!EXTENSION_ID.test(String(serviceId || '')) || serviceId === 'os-cli') {
        throw fault('plugin proxy target is invalid', 'OwnerRejected');
      }
      let registration;
      try {
        registration = await request('GET', `${collection}/${serviceId}`);
      } catch (error) {
        if (error?.code !== 'ResourceNotFound') throw error;
        const listed = await request('GET', collection);
        registration = Array.isArray(listed?.items)
          ? listed.items.find((item) => item?.status?.serving?.artifactServiceId === serviceId)
          : null;
      }
      const metadata = registration?.metadata || {};
      const spec = registration?.spec || {};
      const status = registration?.status || {};
      const serving = status.serving || {};
      const packageId = String(spec.packageRef?.name || '');
      if (!EXTENSION_ID.test(packageId) || metadata.name !== packageId || spec.desiredState !== 'Enabled'
          || status.phase !== 'Activated' || status.workload?.phase !== 'Ready'
          || status.verification?.manifest !== 'Verified' || status.verification?.signature !== 'Verified'
          || status.verification?.entryDigest !== 'Verified' || status.verification?.permissions !== 'Approved'
          || !['Current', 'LastKnownGood'].includes(serving.phase)
          || !/^sha256:[a-f0-9]{64}$/u.test(String(status.currentDigest || ''))
          || !/^[a-f0-9]{64}$/u.test(String(status.currentManifestSha256 || ''))
          || serving.digest !== status.currentDigest || serving.manifestSha256 !== status.currentManifestSha256
          || !EXTENSION_ID.test(String(serving.artifactServiceId || ''))
          || ![packageId, serving.artifactServiceId].includes(serviceId)) {
        throw fault('plugin proxy target is not active and verified', 'OwnerRejected');
      }
      const pkg = await request('GET', `${packages}/${packageId}`);
      if (pkg?.metadata?.name !== packageId) {
        throw fault('plugin package identity is inconsistent', 'AuthorityContractViolation');
      }
      if (serving.phase === 'Current'
          && (pkg?.spec?.image?.digest !== status.currentDigest
            || pkg?.spec?.manifest?.sha256 !== status.currentManifestSha256
            || status.revalidation?.phase !== 'Passed')) {
        throw fault('plugin current serving revision is stale', 'StaleAuthorityRevision');
      }
      if (serviceId === packageId
          && (pkg?.spec?.contributions?.api?.enabled !== true
            || String(pkg?.spec?.contributions?.api?.basePath || '') !== `/api/plugins/${packageId}`)) {
        throw fault('plugin does not publish a canonical runtime API', 'OwnerRejected');
      }
      return Object.freeze({
        serviceId,
        packageId,
        servingMode: serving.phase,
        digest: String(serving.digest),
        manifestSha256: String(serving.manifestSha256),
        ...(packageId === 'cluster-manager' && serving.phase === 'Current'
          ? { modulePackage: pkg } : {}),
      });
    },

    async applyInstall({ candidate, operationId, requestedBy, reason }) {
      if (!EXTENSION_ID.test(String(candidate?.id || '')) || !RESOURCE_VERSION.test(String(candidate?.packageResourceVersion || ''))
          || !Number.isSafeInteger(candidate?.packageGeneration) || candidate.packageGeneration < 1) {
        throw fault('Registry candidate lacks Package coordinates', 'ClaimBindingMismatch');
      }
      const id = candidate.id;
      const pkg = await request('GET', `${packages}/${id}`);
      assertCurrentPackage(pkg, candidate);
      let registration;
      let created = false;
      try {
        registration = await request('GET', `${collection}/${id}`);
        if (registration?.spec?.packageRef?.name !== id || registration?.spec?.desiredState === 'Uninstalled') {
          throw fault('existing registration conflicts with the install plan', 'OwnerRejected');
        }
      } catch (error) {
        if (error?.code !== 'ResourceNotFound') throw error;
        registration = await request('POST', collection, {
          apiVersion: 'plugins.opensphere.io/v1alpha1',
          kind: 'UIPluginRegistration',
          metadata: { name: id, namespace },
          spec: {
            packageRef: { name: id }, desiredState: 'Installed',
            installPolicy: { createWorkload: true, createProxyRoute: true, exposeInNavigation: true },
            approval: { requestedBy, reason },
            installation: {
              requestedAt: new Date().toISOString(), requestedBy, requestedById: requestedBy,
              client: 'console:web', operationId,
            },
          },
        }, [201]);
        created = true;
      }
      const uid = String(registration?.metadata?.uid || '');
      const resourceVersion = String(registration?.metadata?.resourceVersion || '');
      if (!uid || !RESOURCE_VERSION.test(resourceVersion)) throw fault('Kubernetes returned incomplete Registration evidence', 'AuthorityContractViolation');
      return Object.freeze({
        registrationName: id, registrationUid: uid, registrationResourceVersion: resourceVersion,
        packageResourceVersion: candidate.packageResourceVersion, packageGeneration: candidate.packageGeneration,
        manifestDigest: candidate.manifestDigest, sourceRevision: candidate.sourceRevision,
        compatibilityVersion: candidate.compatibilityVersion, keyId: candidate.keyId, created,
      });
    },

    async observeInstall({ candidate, registrationUid }) {
      if (!EXTENSION_ID.test(String(candidate?.id || '')) || !RESOURCE_VERSION.test(String(candidate?.packageResourceVersion || ''))
          || !Number.isSafeInteger(candidate?.packageGeneration) || candidate.packageGeneration < 1
          || typeof registrationUid !== 'string' || registrationUid.length < 1 || registrationUid.length > 128) {
        throw fault('install observation lacks immutable coordinates', 'ClaimBindingMismatch');
      }
      const pkg = await request('GET', `${packages}/${candidate.id}`);
      assertCurrentPackage(pkg, candidate);
      const registration = await request('GET', `${collection}/${candidate.id}`);
      return readyRegistration(registration, candidate, registrationUid);
    },

    async applyRemove({ descriptorId, operationId, requestedBy, reason }) {
      if (!/^extension\.[a-z0-9][a-z0-9-]{0,62}$/.test(String(descriptorId || ''))
          || typeof operationId !== 'string' || operationId.length < 1
          || typeof requestedBy !== 'string' || requestedBy.length < 1
          || typeof reason !== 'string' || reason.length < 3 || reason.length > 500) {
        throw fault('Extension removal request lacks canonical coordinates', 'ClaimBindingMismatch');
      }
      const id = descriptorId.slice('extension.'.length);
      let pkg;
      try { pkg = await request('GET', `${packages}/${id}`); }
      catch (error) {
        if (error?.code === 'ResourceNotFound') throw fault('UIPluginPackage is unavailable for removal policy evaluation', 'AuthorityUnavailable', true);
        throw error;
      }
      const { scope: packageScope, core } = exactExtensionPackageScope(pkg);
      const packageResourceVersion = String(pkg?.metadata?.resourceVersion || '');
      const packageGeneration = Number(pkg?.metadata?.generation);
      if (pkg?.metadata?.name !== id || !RESOURCE_VERSION.test(packageResourceVersion)
          || !Number.isSafeInteger(packageGeneration) || packageGeneration < 1) {
        throw fault('UIPluginPackage removal policy evidence is incomplete', 'AuthorityContractViolation');
      }
      if (core) {
        throw fault('shell-pinned core Extension cannot be removed', 'OwnerRejected', false, true);
      }

      let registration;
      try { registration = await request('GET', `${collection}/${id}`); }
      catch (error) {
        if (error?.code === 'ResourceNotFound') throw fault('Extension Registration does not exist', 'RegistrationNotFound', false, true);
        throw error;
      }
      const before = {
        name: registration?.metadata?.name,
        uid: String(registration?.metadata?.uid || ''),
        resourceVersion: String(registration?.metadata?.resourceVersion || ''),
        generation: Number(registration?.metadata?.generation),
        packageName: registration?.spec?.packageRef?.name,
        desiredState: registration?.spec?.desiredState,
      };
      if (before.name !== id || before.packageName !== id || !before.uid
          || !RESOURCE_VERSION.test(before.resourceVersion)
          || !Number.isSafeInteger(before.generation) || before.generation < 1
          || !['Installed', 'Enabled', 'Disabled', 'Uninstalled'].includes(before.desiredState)) {
        throw fault('UIPluginRegistration removal target is invalid', 'ObservationMismatch');
      }
      let applied = registration;
      let changed = false;
      if (before.desiredState !== 'Uninstalled') {
        applied = await request('PATCH', `${collection}/${id}`, {
          metadata: { resourceVersion: before.resourceVersion },
          spec: {
            desiredState: 'Uninstalled',
            approval: { requestedBy, reason },
          },
        });
        changed = true;
      }
      const after = {
        name: applied?.metadata?.name,
        uid: String(applied?.metadata?.uid || ''),
        resourceVersion: String(applied?.metadata?.resourceVersion || ''),
        generation: Number(applied?.metadata?.generation),
        packageName: applied?.spec?.packageRef?.name,
        desiredState: applied?.spec?.desiredState,
      };
      if (after.name !== id || after.uid !== before.uid || after.packageName !== id
          || after.desiredState !== 'Uninstalled' || !RESOURCE_VERSION.test(after.resourceVersion)
          || !Number.isSafeInteger(after.generation) || after.generation < before.generation) {
        throw fault('Kubernetes returned mismatched removal evidence', 'AuthorityContractViolation');
      }
      return Object.freeze({
        descriptorId, registrationName: id, registrationUid: before.uid,
        registrationResourceVersionBefore: before.resourceVersion,
        registrationResourceVersion: after.resourceVersion,
        registrationGeneration: after.generation,
        packageResourceVersion, packageGeneration, packageScope, changed,
      });
    },

    async observeRemove({ registrationName, registrationUid }) {
      if (!EXTENSION_ID.test(String(registrationName || ''))
          || typeof registrationUid !== 'string' || registrationUid.length < 1 || registrationUid.length > 128) {
        throw fault('removal observation lacks immutable Registration coordinates', 'ClaimBindingMismatch');
      }
      const result = await request('GET', `${collection}/${registrationName}`, undefined, [200, 404], { withStatus: true });
      if (result.status === 404) {
        return Object.freeze({
          state: 'Removed',
          observation: Object.freeze({
            registration: Object.freeze({ name: registrationName, uid: registrationUid, phase: 'Absent' }),
          }),
        });
      }
      const registration = result.value;
      if (registration?.metadata?.name !== registrationName
          || String(registration?.metadata?.uid || '') !== registrationUid) {
        throw fault('UIPluginRegistration was replaced during removal', 'ObservationMismatch', false, true, 'unknown');
      }
      if (registration?.status?.phase === 'Failed') {
        throw fault('UIPluginRegistration reported a terminal removal failure', 'OwnerRejected', false, true, 'present');
      }
      return Object.freeze({ state: 'Pending', reason: 'RegistrationStillPresent' });
    },
  });
}
