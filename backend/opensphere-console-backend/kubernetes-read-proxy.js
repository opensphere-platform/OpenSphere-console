'use strict';

const fs = require('fs');

const READ_METHODS = new Set(['GET', 'HEAD']);
const BLOCKED_SEGMENTS = new Set(['secrets', 'exec', 'attach', 'portforward', 'proxy']);
const CONTROL_CENTER_ID_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function parseKubernetesReadRequest(rawUrl, allowedControlCenters) {
  const url = new URL(rawUrl, 'http://polyon-rcc.local');
  const match = url.pathname.match(/^\/api\/control-centers\/([^/]+)\/k8s(\/.*)$/);
  if (!match) throw { code: 404, msg: 'Kubernetes read route not found' };

  const controlCenterId = match[1];
  if (!CONTROL_CENTER_ID_RE.test(controlCenterId)) throw { code: 400, msg: 'invalid control center id' };
  if (!allowedControlCenters.has(controlCenterId)) throw { code: 404, msg: 'control center is not configured' };

  let path;
  try { path = decodeURIComponent(match[2]); }
  catch { throw { code: 400, msg: 'bad Kubernetes path encoding' }; }
  const segments = path.split('/').filter(Boolean);
  if (!/^\/(api|apis)\//.test(path)) throw { code: 400, msg: 'only Kubernetes /api and /apis paths are allowed' };
  if (segments.some((segment) => segment.includes('%'))) throw { code: 400, msg: 'encoded path segments are not allowed' };

  const normalized = segments.map((segment) => segment.toLowerCase());
  if (normalized.some((segment) => BLOCKED_SEGMENTS.has(segment))) {
    throw { code: 403, msg: 'sensitive Kubernetes resource or subresource is blocked' };
  }
  if (normalized.includes('serviceaccounts') && normalized.at(-1) === 'token') {
    throw { code: 403, msg: 'ServiceAccount token subresource is blocked' };
  }
  if (['1', 'true'].includes(String(url.searchParams.get('watch') || '').toLowerCase())) {
    throw { code: 400, msg: 'Kubernetes watch streams are not available through the RCC read API' };
  }

  return { controlCenterId, path, search: url.search };
}

function createKubernetesReadProxy(options = {}) {
  const apiServer = String(options.apiServer || 'https://kubernetes.default.svc').replace(/\/$/, '');
  const allowedControlCenters = new Set(options.allowedControlCenters || ['cc2']);
  const tokenPath = options.tokenPath || '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 10_000));
  const maxBytes = Math.max(1024, Number(options.maxBytes || 8 * 1024 * 1024));
  const upstreamFetch = options.fetch || globalThis.fetch;
  const readToken = options.readToken || (() => fs.readFileSync(tokenPath, 'utf8').trim());
  const verify = options.verify;
  const audit = options.audit;

  if (typeof verify !== 'function') throw new Error('Kubernetes read proxy verify callback is required');
  if (typeof audit !== 'function') throw new Error('Kubernetes read proxy audit callback is required');

  return async function kubernetesReadProxy(req, res) {
    if (!READ_METHODS.has(String(req.method || '').toUpperCase())) {
      return sendJson(res, 405, { error: 'RCC Kubernetes access is read-only' }, { allow: 'GET, HEAD' });
    }

    let parsed;
    let actor;
    try {
      parsed = parseKubernetesReadRequest(req.url, allowedControlCenters);
      actor = await verify(req, parsed.controlCenterId);
    } catch (error) {
      return sendJson(res, error?.code || 401, { error: error?.msg || 'Kubernetes read authorization failed' });
    }

    let response;
    let payload;
    try {
      response = await upstreamFetch(`${apiServer}${parsed.path}${parsed.search}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${readToken()}`,
          accept: req.headers.accept || 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > maxBytes) throw { code: 413, msg: 'Kubernetes response exceeds the RCC read limit' };
      payload = req.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
      if (payload.length > maxBytes) throw { code: 413, msg: 'Kubernetes response exceeds the RCC read limit' };

      await audit(actor, {
        controlCenterId: parsed.controlCenterId,
        path: parsed.path,
        status: response.status,
      });
    } catch (error) {
      return sendJson(res, error?.code || 502, { error: error?.msg || 'Kubernetes API is unavailable' });
    }

    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-polyon-control-center': parsed.controlCenterId,
    });
    res.end(payload);
  };
}

module.exports = {
  createKubernetesReadProxy,
  parseKubernetesReadRequest,
};
