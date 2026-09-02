const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'if-match', 'if-none-match', 'if-modified-since', 'range']);
const RESPONSE_HEADERS = new Set([
  'accept-ranges', 'cache-control', 'content-disposition', 'content-length', 'content-range',
  'content-type', 'etag', 'expires', 'last-modified', 'vary',
]);

function fault(status, message) {
  throw Object.assign(new Error(message), { status, code: status });
}

function namespace(value) {
  const candidate = String(value || '');
  if (!PLUGIN_ID.test(candidate)) throw new TypeError('plugin namespace is invalid');
  return candidate;
}

export function pluginRoute(value) {
  const url = value instanceof URL ? value : new URL(String(value), 'http://extension.local');
  const match = url.pathname.match(/^\/api\/plugins\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\/.*)?$/u);
  if (!match || match[1] === 'os-cli' || match[2]?.includes('\\')) fault(404, 'plugin route is not allowlisted');
  return Object.freeze({ serviceId: match[1], upstreamPath: match[2] || '/', search: url.search });
}

export function createPluginProxy({
  resolveTarget,
  fetchImpl = globalThis.fetch,
  pluginNamespace = 'opensphere-console',
  timeoutMs = 30000,
} = {}) {
  if (typeof resolveTarget !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('plugin target resolver and fetch implementation are required');
  }
  const targetNamespace = namespace(pluginNamespace);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new TypeError('plugin proxy timeout is invalid');
  }

  return async function proxyPlugin({ method, url, headers = {}, body, actor }) {
    const verb = String(method || '').toUpperCase();
    if (!METHODS.has(verb)) fault(405, 'plugin proxy method is not allowlisted');
    const route = pluginRoute(url);
    const target = await resolveTarget({ serviceId: route.serviceId });
    if (!target || target.serviceId !== route.serviceId || !PLUGIN_ID.test(String(target.serviceId || ''))) {
      fault(403, 'plugin proxy target is not active and verified');
    }
    const upstreamHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (REQUEST_HEADERS.has(key) && value !== undefined) upstreamHeaders[key] = String(value).slice(0, 8192);
    }
    const correlationId = String(headers['x-os-correlation-id'] || '').slice(0, 128);
    Object.assign(upstreamHeaders, {
      'x-os-subject-id': actor.subjectId,
      'x-os-browser-session-id': actor.browserSessionId,
      'x-os-permission-revision': String(actor.permissionRevision),
      'x-os-revoke-epoch': String(actor.revokeEpoch),
      'x-os-aal': actor.assurance,
      'x-os-permissions': JSON.stringify(actor.permissions),
      ...(correlationId ? { 'x-os-correlation-id': correlationId } : {}),
    });
    const upstreamUrl = `http://${target.serviceId}.${targetNamespace}.svc.cluster.local:8080${route.upstreamPath}${route.search}`;
    let response;
    try {
      response = await fetchImpl(upstreamUrl, {
        method: verb,
        headers: upstreamHeaders,
        ...(!['GET', 'HEAD'].includes(verb) && body?.length ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { fault(502, 'verified plugin workload is unavailable'); }
    const responseHeaders = {};
    for (const [name, value] of response.headers.entries()) {
      if (RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name.toLowerCase()] = value;
    }
    return Object.freeze({ status: response.status, headers: Object.freeze(responseHeaders), body: response.body });
  };
}

export { PLUGIN_ID };