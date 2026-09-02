const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'if-match', 'if-none-match', 'if-modified-since', 'range']);
const RESPONSE_HEADERS = new Set([
  'accept-ranges', 'cache-control', 'content-disposition', 'content-length', 'content-range',
  'content-type', 'etag', 'expires', 'last-modified', 'vary',
]);
const DEFAULT_RESPONSE_MAXIMUM_BYTES = 16 * 1024 * 1024;

function fault(status, message) {
  throw Object.assign(new Error(message), { status, code: status });
}

function namespace(value) {
  const candidate = String(value || '');
  if (!PLUGIN_ID.test(candidate)) throw new TypeError('plugin namespace is invalid');
  return candidate;
}

function boundedResponseBody(body, maximumBytes) {
  if (!body) return null;
  if (typeof body.getReader !== 'function') fault(502, 'verified plugin returned an unsupported response body');
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        const bytes = value?.byteLength;
        if (!Number.isInteger(bytes) || bytes < 0) {
          await reader.cancel().catch(() => undefined);
          return controller.error(Object.assign(new Error('verified plugin returned an invalid response chunk'), { status: 502, code: 502 }));
        }
        received += bytes;
        if (received > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          return controller.error(Object.assign(new Error('verified plugin response exceeds the configured limit'), { status: 502, code: 502 }));
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
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
  responseMaximumBytes = DEFAULT_RESPONSE_MAXIMUM_BYTES,
} = {}) {
  if (typeof resolveTarget !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('plugin target resolver and fetch implementation are required');
  }
  const targetNamespace = namespace(pluginNamespace);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new TypeError('plugin proxy timeout is invalid');
  }
  if (!Number.isInteger(responseMaximumBytes) || responseMaximumBytes < 1024 || responseMaximumBytes > 64 * 1024 * 1024) {
    throw new TypeError('plugin proxy response limit is invalid');
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
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
        await response.body?.cancel().catch(() => undefined);
        fault(502, 'verified plugin returned an invalid content length');
      }
      if (Number(declaredLength) > responseMaximumBytes) {
        await response.body?.cancel().catch(() => undefined);
        fault(502, 'verified plugin response exceeds the configured limit');
      }
    }
    const responseHeaders = {};
    for (const [name, value] of response.headers.entries()) {
      if (RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name.toLowerCase()] = value;
    }
    return Object.freeze({
      status: response.status,
      headers: Object.freeze(responseHeaders),
      body: boundedResponseBody(response.body, responseMaximumBytes),
    });
  };
}

export { PLUGIN_ID };