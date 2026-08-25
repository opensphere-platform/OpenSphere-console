'use strict';

const OCI_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

function registryError(reason, code, message, retryAfter = '') {
  const error = Object.assign(new Error(message), { reason, code });
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

function registryResponseError(response, context = 'registry request') {
  const status = Number(response?.status) || 503;
  const retryAfter = String(response?.headers?.get?.('retry-after') || '').trim();
  if (status === 401 || status === 403) {
    return registryError('RegistryUnauthorized', 401, `${context} was not authorized`);
  }
  if (status === 404) {
    return registryError('ArtifactNotFound', 404, `${context} did not find the requested artifact`);
  }
  if (status === 429) {
    return registryError('RegistryRateLimited', 429, `${context} was rate limited`, retryAfter);
  }
  if (status >= 500) {
    return registryError('RegistryUnavailable', 503, `${context} is unavailable`);
  }
  return registryError('RegistryRequestFailed', 422, `${context} failed with HTTP ${status}`);
}

async function registryFetch(url, options = {}, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: options.signal || AbortSignal.timeout(15_000) });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw registryError('RegistryTimeout', 504, 'registry request timed out');
    }
    throw registryError('RegistryUnavailable', 503, 'registry request failed');
  }
  return response;
}

async function requestGhcrToken(scope, credentials = null, fetchImpl = globalThis.fetch) {
  const headers = credentials
    ? { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` }
    : {};
  const response = await registryFetch(
    `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`,
    { headers },
    fetchImpl,
  );
  if (!response.ok) throw registryResponseError(response, 'GHCR token request');
  const token = String((await response.json().catch(() => ({})))?.token || '');
  if (!token) throw registryError('RegistryUnauthorized', 401, 'GHCR token response was empty');
  return token;
}

async function verifyGhcrCandidateCredentials(username, password, fetchImpl = globalThis.fetch) {
  const scope = 'repository:opensphere-platform/opensphere-console:pull';
  const token = await requestGhcrToken(scope, { username, password }, fetchImpl);
  const response = await registryFetch('https://ghcr.io/v2/opensphere-platform/opensphere-console/manifests/edge', {
    headers: { Accept: OCI_ACCEPT, Authorization: `Bearer ${token}` },
  }, fetchImpl);
  if (!response.ok) throw registryResponseError(response, 'OpenSphere GHCR verification');
  return {
    registry: 'ghcr.io',
    allowedNamespace: 'opensphere-platform',
    verifiedAt: new Date().toISOString(),
  };
}

module.exports = {
  OCI_ACCEPT,
  registryError,
  registryResponseError,
  registryFetch,
  requestGhcrToken,
  verifyGhcrCandidateCredentials,
};
