'use strict';

const { normalizeOrigin } = require('./os-shell-contract');

const MARKER = 'os-shell-control-v1';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function admitted(method, path) {
  if (method === 'GET' && ['/api/os-shell/readiness', '/api/os-shell/sessions'].includes(path)) return true;
  if (method === 'POST' && path === '/api/os-shell/sessions') return true;
  if (/^\/api\/os-shell\/sessions\/[0-9a-f-]{36}$/i.test(path)) return ['GET', 'DELETE'].includes(method);
  if (/^\/api\/os-shell\/sessions\/[0-9a-f-]{36}\/attach-ticket$/i.test(path)) return method === 'POST';
  if (/^\/api\/os-shell\/sessions\/[0-9a-f-]{36}\/attach$/i.test(path)) return method === 'GET';
  return false;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const PERMISSION = /^[a-z][a-z0-9._:-]{0,127}$/u;
const AUTHORITY_REVISION = /^(?:0|[1-9][0-9]*)$/u;

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
function credential(req) {
  const match = String(req?.headers?.authorization || '')
    .match(/^Bearer\s+([A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+)$/u);
  if (!match || match[1].length > 16384) fail(401, 'valid exchanged Owner bearer credential is required');
  let claims;
  try { claims = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8')); }
  catch { fail(401, 'Owner bearer credential payload is invalid'); }
  const authSessionRef = String(claims?.session_id || '');
  if (!UUID.test(String(claims?.sub || '')) || authSessionRef.length < 1 || authSessionRef.length > 256
      || /[\u0000-\u001f\u007f]/u.test(authSessionRef) || !['aal1', 'aal2'].includes(String(claims?.aal || ''))
      || !Number.isSafeInteger(claims?.exp)) {
    fail(401, 'Owner bearer credential coordinates are incomplete');
  }
  return { token: match[1], subjectId: String(claims.sub), authSessionRef, aal: String(claims.aal), expiresAtMs: claims.exp * 1000 };
}

function createOsShellConsoleOwnerAdmission({
  baseUrl,
  publicOrigin,
  resolvePermissionRevision,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  now = () => Date.now(),
  allowLoopbackHttp = false,
} = {}) {
  const authorityOrigin = configuredOrigin(baseUrl);
  const exactOrigin = normalizeOrigin(publicOrigin, { allowLoopbackHttp });
  if (typeof resolvePermissionRevision !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('OS Shell permission authority and fetch implementation are required');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('owner authority timeout is invalid');

  return async function verify(req) {
    const method = String(req?.method || '').toUpperCase();
    const path = new URL(String(req?.url || ''), 'http://shell.local').pathname;
    if (!admitted(method, path)) fail(403, 'OS Shell request target is not admitted');
    if (req?.headers?.cookie || req?.headers?.['x-os-csrf-token']) fail(403, 'raw browser credentials reached OS Shell control');
    if (req?.headers?.['x-os-owner-admission'] !== MARKER) fail(403, 'OS Shell Owner admission marker is invalid');
    const mutation = !SAFE_METHODS.has(method);
    if (mutation && req?.headers?.['x-os-owner-csrf-verified'] !== 'true') fail(403, 'OS Shell mutation requires verified browser CSRF');
    const signed = credential(req);
    if (signed.expiresAtMs <= now() + 5000) fail(401, 'OS Shell Owner credential lifetime is insufficient');
    let response;
    try {
      response = await fetchImpl(authorityOrigin + '/api/identity/me', {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${signed.token}`, accept: 'application/json', 'x-os-owner-admission': MARKER,
          ...(req?.headers?.['x-os-correlation-id']
            ? { 'x-os-correlation-id': String(req.headers['x-os-correlation-id']).slice(0, 128) } : {}),
        },
      });
    } catch { fail(503, 'Console owner authority is unavailable'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? response.status : response.status >= 500 ? 503 : 401;
      fail(status, body?.message || body?.error || 'Owner authority rejected');
    }
    const projection = body?.data;
    const rawPermissions = projection?.permissions;
    const validPermissions = Array.isArray(rawPermissions) && rawPermissions.length <= 256
      && rawPermissions.every((permission) => typeof permission === 'string' && PERMISSION.test(permission))
      && Buffer.byteLength(JSON.stringify(rawPermissions)) <= 8192;
    const authorityPermissionRevision = Number(projection?.permissionRevision);
    const revokeEpoch = Number(projection?.revokeEpoch);
    if (body?.schemaVersion !== '1.0' || body?.authority !== 'SupabaseAuth' || body?.freshness !== 'fresh'
        || typeof body?.observedAt !== 'string' || !Number.isFinite(Date.parse(body.observedAt))
        || projection?.state !== 'Active' || !UUID.test(String(projection?.sessionId || ''))
        || projection?.subjectId !== signed.subjectId || projection?.aal !== signed.aal
        || typeof projection?.permissionRevision !== 'string' || !AUTHORITY_REVISION.test(projection.permissionRevision)
        || !Number.isSafeInteger(authorityPermissionRevision) || typeof projection?.revokeEpoch !== 'string'
        || !AUTHORITY_REVISION.test(projection.revokeEpoch) || !Number.isSafeInteger(revokeEpoch) || !validPermissions) {
      fail(503, 'Console owner authority returned an invalid current projection');
    }
    const permissions = [...new Set(rawPermissions)].sort();    if (!permissions.includes('session:attach')) fail(403, 'session:attach permission is required');
    let permissionRevision;
    try { permissionRevision = await resolvePermissionRevision(signed.subjectId); }
    catch { fail(503, 'OS Shell permission authority is unavailable'); }
    if (!REVISION.test(String(permissionRevision || ''))) fail(503, 'OS Shell permission authority returned an invalid revision');
    const absoluteMs = Math.min(signed.expiresAtMs, now() + 60 * 60_000);
    const idleMs = Math.min(absoluteMs, now() + 15 * 60_000);
    return Object.freeze({
      sub: signed.subjectId,
      browserSessionId: String(projection.sessionId),
      authSessionRef: signed.authSessionRef,
      method, path, origin: exactOrigin,
      csrfRequired: mutation, csrfVerified: mutation,
      aal: signed.aal,
      permissions: Object.freeze(permissions),
      permissionRevision: String(permissionRevision),
      authorityPermissionRevision,
      revokeEpoch,
      browserIdleExpiresAt: new Date(idleMs).toISOString(),
      browserAbsoluteExpiresAt: new Date(absoluteMs).toISOString(),
    });
  };
}

module.exports = { MARKER, admitted, createOsShellConsoleOwnerAdmission };
