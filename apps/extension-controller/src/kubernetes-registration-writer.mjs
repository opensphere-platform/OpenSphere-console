const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESOURCE_VERSION = /^[0-9A-Za-z._:-]{1,128}$/;

function fault(message, code, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
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
  async function request(method, path, body, accepted = [200]) {
    let response;
    try {
      response = await fetchImpl(apiOrigin + path, {
        method,
        headers: {
          accept: 'application/json', authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
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
    return responseJson(response, maximumResponseBytes);
  }
  return Object.freeze({
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
        created,
      });
    },
  });
}
