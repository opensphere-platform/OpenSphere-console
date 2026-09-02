const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PATH = /^\/api\/plugins\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\/.*)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERMISSION = /^[a-z][a-z0-9._:-]{0,127}$/u;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;

function fault(status, message) {
  throw Object.assign(new Error(message), { status, code: status });
}

function origin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Console owner authority URL must be absolute'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new TypeError('Console owner authority URL must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function bearer(request) {
  const match = String(request?.headers?.authorization || '')
    .match(/^Bearer\s+([A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+)$/u);
  if (!match || match[1].length > 16384) fault(401, 'valid exchanged Owner bearer credential is required');
  return match[1];
}

function coordinates(token) {
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { fault(401, 'Owner bearer credential payload is invalid'); }
  const authSessionRef = String(claims?.session_id || '');
  if (!UUID.test(String(claims?.sub || '')) || authSessionRef.length < 1 || authSessionRef.length > 256
      || /[\u0000-\u001f\u007f]/u.test(authSessionRef)
      || !['aal1', 'aal2'].includes(String(claims?.aal || ''))) {
    fault(401, 'Owner bearer credential coordinates are incomplete');
  }
  return Object.freeze({
    subjectId: String(claims.sub), authSessionRef, aal: String(claims.aal),
  });
}

export function createConsoleOwnerAdmission({
  baseUrl,
  marker = 'extension-controller-v1',
  familyPrefix = '/api/plugins',
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const authorityOrigin = origin(baseUrl);
  if (marker !== 'extension-controller-v1' || familyPrefix !== '/api/plugins') {
    throw new TypeError('C_EXT Owner marker/family contract is closed');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new TypeError('owner authority timeout is invalid');
  }

  return async function verifyOwnerRequest(request) {
    const method = String(request?.method || '').toUpperCase();
    let path;
    try { path = new URL(String(request?.url || ''), 'http://owner.local').pathname; }
    catch { fault(400, 'Owner request URI is invalid'); }
    const route = path.match(PATH);
    if (!METHODS.has(method) || !route || route[1] === 'os-cli') fault(403, 'request is outside the exact admitted C_EXT routes');
    if (request?.headers?.cookie || request?.headers?.['x-os-csrf-token']) {
      fault(403, 'raw browser credentials reached C_EXT');
    }
    if (request?.headers?.['x-os-owner-admission'] !== marker) fault(403, 'C_EXT admission marker is invalid');
    if (!SAFE_METHODS.has(method) && request?.headers?.['x-os-owner-csrf-verified'] !== 'true') {
      fault(403, 'C_EXT mutation requires verified browser CSRF');
    }
    const token = bearer(request);
    const credential = coordinates(token);
    let response;
    try {
      response = await fetchImpl(authorityOrigin + '/api/identity/me', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'x-os-owner-admission': marker,
          ...(request?.headers?.['x-os-correlation-id']
            ? { 'x-os-correlation-id': String(request.headers['x-os-correlation-id']).slice(0, 128) } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { fault(503, 'Console owner authority is unavailable'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? response.status : response.status >= 500 ? 503 : 401;
      fault(status, body?.message || body?.error || 'Owner authority rejected');
    }
    const projection = body?.data;
    const rawPermissions = projection?.permissions;
    const validPermissions = Array.isArray(rawPermissions) && rawPermissions.length <= 256
      && rawPermissions.every((permission) => typeof permission === 'string' && PERMISSION.test(permission))
      && Buffer.byteLength(JSON.stringify(rawPermissions)) <= 8192;
    const observedAt = typeof body?.observedAt === 'string' ? Date.parse(body.observedAt) : NaN;
    const permissionRevision = Number(projection?.permissionRevision);
    const revokeEpoch = Number(projection?.revokeEpoch);
    if (body?.schemaVersion !== '1.0' || body?.authority !== 'SupabaseAuth' || body?.freshness !== 'fresh'
        || !Number.isFinite(observedAt) || projection?.state !== 'Active'
        || !UUID.test(String(projection?.sessionId || '')) || projection?.subjectId !== credential.subjectId
        || projection?.aal !== credential.aal || typeof projection?.permissionRevision !== 'string'
        || !REVISION.test(projection.permissionRevision) || !Number.isSafeInteger(permissionRevision)
        || typeof projection?.revokeEpoch !== 'string' || !REVISION.test(projection.revokeEpoch)
        || !Number.isSafeInteger(revokeEpoch) || !validPermissions) {
      fault(503, 'Console owner authority returned an invalid current projection');
    }
    const permissions = [...new Set(rawPermissions)].sort();    return Object.freeze({
      subjectId: credential.subjectId,
      browserSessionId: String(projection.sessionId),
      authSessionRef: credential.authSessionRef,
      permissions: Object.freeze(permissions),
      assurance: credential.aal,
      permissionRevision,
      revokeEpoch,
    });
  };
}
