'use strict';

const ROLE_MARKERS = Object.freeze({
  'console.role.admin': 'console-admins',
  'console.role.operator': 'console-operators',
  'console.role.viewer': 'console-viewers',
});
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERMISSION = /^[a-z][a-z0-9._:-]{0,127}$/u;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;

function fail(code, msg) { throw { code, status: code, msg, message: msg }; }

function configuredOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Console owner authority URL must be absolute'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new TypeError('Console owner authority URL must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function bearerCredential(req) {
  const match = String(req?.headers?.authorization || '')
    .match(/^Bearer\s+([A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+)$/u);
  if (!match || match[1].length > 16384) fail(401, 'valid exchanged Owner bearer credential is required');
  return match[1];
}

function credentialCoordinates(token) {
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { fail(401, 'Owner bearer credential payload is invalid'); }
  const authSessionRef = String(claims?.session_id || '');
  if (!UUID.test(String(claims?.sub || '')) || authSessionRef.length < 1 || authSessionRef.length > 256
      || /[\u0000-\u001f\u007f]/u.test(authSessionRef)
      || !['aal1', 'aal2'].includes(String(claims?.aal || ''))) {
    fail(401, 'Owner bearer credential coordinates are incomplete');
  }
  return { subjectId: String(claims.sub), authSessionRef, aal: String(claims.aal) };
}

function mappedAuthorityStatus(status) {
  if (status === 401 || status === 403) return status;
  if (status >= 500) return 503;
  return 401;
}

function createConsoleOwnerAdmission({
  baseUrl,
  marker,
  familyPrefix,
  allowRequest,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const origin = configuredOrigin(baseUrl);
  if (!/^[a-z][a-z0-9-]+-v1$/u.test(String(marker || ''))) throw new TypeError('closed Owner marker is required');
  if (!/^\/api\/[a-z][a-z0-9-]+$/u.test(String(familyPrefix || ''))) throw new TypeError('closed Owner family prefix is required');
  if (typeof allowRequest !== 'function') throw new TypeError('closed Owner route allowlist is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('owner authority timeout is invalid');

  return async function verifyOwnerRequest(req) {
    const method = String(req?.method || '').toUpperCase();
    let path;
    try { path = new URL(String(req?.url || ''), 'http://owner.local').pathname; }
    catch { fail(400, 'Owner request URI is invalid'); }
    if ((path !== familyPrefix && !path.startsWith(familyPrefix + '/')) || !allowRequest(method, path)) {
      fail(403, 'request is outside the exact admitted Owner routes');
    }
    if (req?.headers?.cookie || req?.headers?.['x-os-csrf-token']) fail(403, 'raw browser credentials reached an Owner');
    if (req?.headers?.['x-os-owner-admission'] !== marker) fail(403, 'Owner admission marker is invalid');
    if (!SAFE_METHODS.has(method) && req?.headers?.['x-os-owner-csrf-verified'] !== 'true') {
      fail(403, 'Owner mutation requires verified browser CSRF');
    }
    const token = bearerCredential(req);
    const credential = credentialCoordinates(token);
    let response;
    try {
      response = await fetchImpl(origin + '/api/identity/me', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'x-os-owner-admission': marker,
          ...(req?.headers?.['x-os-correlation-id']
            ? { 'x-os-correlation-id': String(req.headers['x-os-correlation-id']).slice(0, 128) } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { fail(503, 'Console owner authority is unavailable'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) fail(mappedAuthorityStatus(response.status), body?.message || body?.error || 'Owner authority rejected');
    const projection = body?.data;
    const rawPermissions = projection?.permissions;
    const validPermissions = Array.isArray(rawPermissions) && rawPermissions.length <= 256
      && rawPermissions.every((permission) => typeof permission === 'string' && PERMISSION.test(permission))
      && Buffer.byteLength(JSON.stringify(rawPermissions)) <= 8192;
    if (body?.schemaVersion !== '1.0' || body?.authority !== 'SupabaseAuth' || body?.freshness !== 'fresh'
        || typeof body?.observedAt !== 'string' || !Number.isFinite(Date.parse(body.observedAt))
        || projection?.state !== 'Active' || !UUID.test(String(projection?.sessionId || ''))
        || projection?.subjectId !== credential.subjectId || projection?.aal !== credential.aal
        || typeof projection?.permissionRevision !== 'string' || !REVISION.test(projection.permissionRevision)
        || !Number.isSafeInteger(Number(projection.permissionRevision))
        || typeof projection?.revokeEpoch !== 'string' || !REVISION.test(projection.revokeEpoch)
        || !Number.isSafeInteger(Number(projection.revokeEpoch)) || !validPermissions) {
      fail(503, 'Console owner authority returned an invalid current projection');
    }
    const permissionRevision = Number(projection.permissionRevision);
    const revokeEpoch = Number(projection.revokeEpoch);
    const permissions = [...new Set(rawPermissions)].sort();
    return Object.freeze({
      sub: credential.subjectId,
      subject: credential.subjectId,
      browserSessionId: String(projection.sessionId),
      authSessionRef: credential.authSessionRef,
      permissions: Object.freeze(permissions),
      groups: Object.freeze([...new Set(permissions.map((permission) => ROLE_MARKERS[permission]).filter(Boolean))].sort()),
      assurance: credential.aal,
      permissionRevision,
      authzRevision: String(permissionRevision),
      revokeEpoch: String(revokeEpoch),
    });
  };
}

function requirePermission(actor, permission, { requireAal2 = false, allowAdmin = true } = {}) {
  const permissions = new Set(actor?.permissions || []);
  if (!permissions.has(permission) && !(allowAdmin && permissions.has('console.role.admin'))) {
    fail(403, `requires ${permission}`);
  }
  if (requireAal2 && actor?.assurance !== 'aal2') fail(403, 'Owner mutation requires MFA assurance aal2');
  return actor;
}

module.exports = { createConsoleOwnerAdmission, requirePermission };