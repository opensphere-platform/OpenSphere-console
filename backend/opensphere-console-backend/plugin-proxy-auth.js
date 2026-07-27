'use strict';

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SAFE_METHOD = /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/;

function originalPluginRequest(req) {
  const method = String(req.headers['x-os-original-method'] || 'GET').toUpperCase();
  if (!SAFE_METHOD.test(method)) throw { code: 405, msg: 'unsupported plugin proxy method' };
  return {
    method,
    url: String(req.headers['x-os-original-uri'] || '/'),
    headers: req.headers,
  };
}

/**
 * Resolve the Console-owned browser session into a short-lived Supabase
 * bearer for one verified plugin proxy request.
 *
 * The opaque browser cookie and CSRF token are validated here, inside the
 * Console Backend. Only the resulting bearer is returned to nginx; the
 * browser JavaScript and plugin workload never receive the browser cookie.
 */
async function authorizePluginProxyRequest(req, {
  allowPlugin,
  authenticateBrowser,
  verifyBearer,
}) {
  if (req.headers['x-os-internal-authz-subrequest'] !== 'plugin-proxy-v1') {
    throw { code: 403, msg: 'plugin proxy authorization is internal only' };
  }

  const pluginId = String(req.headers['x-plugin-id'] || '').trim();
  if (!PLUGIN_ID.test(pluginId)) throw { code: 403, msg: 'invalid plugin proxy target' };
  if (!await allowPlugin(pluginId)) throw { code: 403, msg: 'plugin proxy target is not active and verified' };

  const forwarded = originalPluginRequest(req);
  const supplied = String(req.headers.authorization || '');
  if (supplied) {
    if (!/^Bearer\s+\S+$/i.test(supplied)) throw { code: 401, msg: 'invalid Console bearer credential' };
    await verifyBearer(forwarded);
    return { pluginId, authorization: supplied, source: 'bearer' };
  }

  const session = await authenticateBrowser(forwarded);
  if (!session?.accessToken) throw { code: 401, msg: 'active Console browser session required' };
  return {
    pluginId,
    authorization: `Bearer ${session.accessToken}`,
    source: 'browser-session',
  };
}

module.exports = {
  PLUGIN_ID,
  originalPluginRequest,
  authorizePluginProxyRequest,
};
