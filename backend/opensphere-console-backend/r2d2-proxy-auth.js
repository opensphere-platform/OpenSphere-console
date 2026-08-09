'use strict';

const SAFE_METHOD = /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/;

function originalR2d2Request(req) {
  const method = String(req.headers['x-os-original-method'] || 'GET').toUpperCase();
  if (!SAFE_METHOD.test(method)) throw { code: 405, msg: 'unsupported R2D2 proxy method' };
  return {
    method,
    url: String(req.headers['x-os-original-uri'] || '/api/oaa/'),
    headers: req.headers,
  };
}

/**
 * Resolve the Console-owned opaque browser session into a short-lived
 * Supabase bearer for one R2D2 Gateway request. The browser and Gateway never
 * receive each other's credentials: only the verified bearer crosses the
 * Console Backend authentication boundary.
 */
async function authorizeR2d2ProxyRequest(req, { authenticateBrowser, verifyBearer }) {
  if (req.headers['x-os-internal-authn-subrequest'] !== 'r2d2-proxy-v1') {
    throw { code: 403, msg: 'R2D2 proxy authentication is internal only' };
  }

  const forwarded = originalR2d2Request(req);
  const supplied = String(req.headers.authorization || '');
  if (supplied) {
    if (!/^Bearer\s+\S+$/i.test(supplied)) throw { code: 401, msg: 'invalid Console bearer credential' };
    await verifyBearer(forwarded);
    return { authorization: supplied, source: 'bearer' };
  }

  const session = await authenticateBrowser(forwarded);
  if (!session?.accessToken) throw { code: 401, msg: 'active Console browser session required' };
  return {
    authorization: `Bearer ${session.accessToken}`,
    source: 'browser-session',
  };
}

module.exports = {
  originalR2d2Request,
  authorizeR2d2ProxyRequest,
};
