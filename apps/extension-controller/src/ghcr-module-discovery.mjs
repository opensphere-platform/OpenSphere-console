import { MODULE_REPOSITORIES, MODULE_RELEASE_ANNOTATION, moduleReleaseFromIndex } from './module-release.mjs';

const MANAGED = 'opensphere-module-discovery';
const fault = code => Object.assign(new Error(code), {code});
async function boundedJson(response, maximum = 256 * 1024) {
  if (!response.ok) throw fault(`ModuleCatalogHttp${response.status}`);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); throw fault('ModuleCatalogTooLarge'); }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('ModuleCatalogInvalidJson'); }
}

/** Discovery imports metadata only. A Registration/approved operation is still needed to create a workload. */
export function createGhcrModuleDiscovery({ kubernetesBaseUrl, namespace, loadKubernetesToken, loadDockerConfig, loadTrustedKeys,
  fetchImpl = globalThis.fetch, now = Date.now, intervalMs = 60_000 }) {
  const base = new URL(kubernetesBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || !/^[a-z0-9-]+$/.test(namespace)) throw new TypeError('Invalid Kubernetes discovery authority');
  const path = `/apis/plugins.opensphere.io/v1alpha1/namespaces/${namespace}/uipluginpackages`;
  let next = 0;
  async function kube(method, suffix, body) {
    return fetchImpl(base.origin + path + suffix, {method, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {authorization: 'Bearer ' + await loadKubernetesToken(), accept: 'application/json', ...(body ? {'content-type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {})});
  }
  async function markUnavailable(id, code) {
    const response = await kube('GET', '/' + id);
    if (response.status === 404) return;
    const current = await boundedJson(response);
    if (current.metadata.labels?.['app.kubernetes.io/managed-by'] !== MANAGED) return;
    if (current.metadata.annotations?.['opensphere.io/discovery-state'] === code) return;
    current.metadata.annotations = {...current.metadata.annotations, 'opensphere.io/discovery-state': code};
    await boundedJson(await kube('PUT', '/' + id, current));
  }
  return {
    async reconcileOnce() {
      if (now() < next) return {state: 'Idle'};
      next = now() + intervalMs;
      const results = [];
      for (const [id, repository] of Object.entries(MODULE_REPOSITORIES)) {
        try {
          const config = await loadDockerConfig();
          const auth = config?.auths?.['ghcr.io']?.auth;
          if (auth && !/^[A-Za-z0-9+/]+={0,2}$/.test(auth)) throw fault('ModuleCatalogCredentialInvalid');
          const name = repository.slice('ghcr.io/'.length);
          const tokenResponse = await fetchImpl('https://ghcr.io/token?service=ghcr.io&scope=' + encodeURIComponent('repository:' + name + ':pull'), {
            headers: auth ? {authorization: 'Basic ' + auth} : {}, redirect: 'error', signal: AbortSignal.timeout(8000),
          });
          const token = await boundedJson(tokenResponse, 32 * 1024);
          if (typeof token.token !== 'string' || !token.token || token.token.length > 16384) throw fault('ModuleCatalogCredentialInvalid');
          const response = await fetchImpl('https://ghcr.io/v2/' + name + '/manifests/edge', {
            headers: {authorization: 'Bearer ' + token.token, accept: 'application/vnd.oci.image.index.v1+json'},
            redirect: 'error', signal: AbortSignal.timeout(8000),
          });
          const {release, envelope} = moduleReleaseFromIndex(await boundedJson(response), await loadTrustedKeys(), {now: now()});
          if (release.id !== id) throw fault('ModuleCatalogIdentityMismatch');
          const existingResponse = await kube('GET', '/' + id);
          const existing = existingResponse.status === 404 ? null : await boundedJson(existingResponse);
          if (existing && existing.metadata.labels?.['app.kubernetes.io/managed-by'] !== MANAGED) throw fault('ModuleCatalogOwnershipConflict');
          if (existing?.metadata.annotations?.[MODULE_RELEASE_ANNOTATION] === envelope
            && existing.metadata.annotations['opensphere.io/discovery-state'] === 'Verified') { results.push({id, state: 'Current'}); continue; }
          const pkg = {apiVersion: 'plugins.opensphere.io/v1alpha1', kind: 'UIPluginPackage',
            metadata: {name: id, namespace,
              ...(existing ? {resourceVersion: existing.metadata.resourceVersion, uid: existing.metadata.uid} : {}),
              labels: {'app.kubernetes.io/managed-by': MANAGED},
              annotations: {[MODULE_RELEASE_ANNOTATION]: envelope, 'opensphere.io/discovery-state': 'Verified',
                'opensphere.io/discovery-observed-at': new Date(now()).toISOString()}}, spec: release.spec};
          await boundedJson(await kube(existing ? 'PUT' : 'POST', existing ? '/' + id : '', pkg));
          results.push({id, state: 'Discovered'});
        } catch (error) {
          const code = /^Module[A-Za-z0-9]+$/.test(error?.code || '') ? error.code : 'ModuleCatalogUnavailable';
          await markUnavailable(id, code);
          results.push({id, state: 'Unavailable', code});
        }
      }
      return {state: 'Observed', results};
    },
  };
}
