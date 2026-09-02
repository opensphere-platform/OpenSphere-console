const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHODS = new Set([...SAFE_METHODS, 'POST', 'PUT', 'PATCH', 'DELETE']);

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

function originalOsaaRequest(request) {
  if (request?.headers?.['x-os-internal-authn-subrequest'] !== 'r2d2-proxy-v1') {
    fail('PermissionDenied', 'OSAA owner admission is internal only', 403);
  }
  if (String(request.headers.authorization || '').trim()) {
    fail('PermissionDenied', 'OSAA browser admission does not accept bearer input', 403);
  }
  const method = String(request.headers['x-os-original-method'] || '').toUpperCase();
  const uri = String(request.headers['x-os-original-uri'] || '');
  if (!METHODS.has(method) || uri.length < 1 || uri.length > 4096 || /[\r\n]/u.test(uri)) {
    fail('ValidationFailed', 'OSAA original request is invalid', 400);
  }
  let parsed;
  try { parsed = new URL(uri, 'http://console-owner.local'); }
  catch { fail('ValidationFailed', 'OSAA original URI is invalid', 400); }
  if (parsed.origin !== 'http://console-owner.local'
      || !(parsed.pathname === '/api/osaa' || parsed.pathname.startsWith('/api/osaa/')
        || parsed.pathname === '/api/manual' || parsed.pathname.startsWith('/api/manual/'))) {
    fail('PermissionDenied', 'OSAA original target is outside the admitted owner family', 403);
  }
  return Object.freeze({ method, url: parsed.pathname + parsed.search, headers: request.headers });
}

export function createOwnerAdmissionOperations({ identitySessionBroker }) {
  if (!identitySessionBroker?.exchangeOwnerAccessCredential) {
    throw new TypeError('browser owner credential exchanger is required');
  }
  return Object.freeze({
    async authorizeOsaa(request, { correlationId } = {}) {
      const original = originalOsaaRequest(request);
      return identitySessionBroker.exchangeOwnerAccessCredential(original, {
        requireCsrf: !SAFE_METHODS.has(original.method),
        correlationId,
      });
    },
  });
}
