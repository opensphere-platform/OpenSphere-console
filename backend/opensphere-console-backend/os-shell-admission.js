'use strict';

const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { canonicalPermissionRevision, normalizeOrigin } = require('./os-shell-contract');

const ADMISSION_AUDIENCE = 'opensphere-shell-control';
const ADMISSION_ISSUER = 'opensphere-console-backend';
const TYPE = 'OS-SHELL-ADMISSION';
const METHODS = new Set(['GET', 'POST', 'DELETE']);
const PATH = /^\/api\/os-shell\/(?:readiness|sessions(?:\/[0-9a-f-]{36}(?:\/attach-ticket|\/attach)?)?)$/i;

function fail(code, msg) { throw { code, msg }; }
function b64(value) { return Buffer.from(value).toString('base64url'); }

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) fail(503, `${label} is unavailable`);
  return new Date(parsed).toISOString();
}

function admissionSecret(value) {
  const text = String(value || '');
  let decoded;
  try { decoded = Buffer.from(text, 'base64url'); } catch { decoded = Buffer.alloc(0); }
  if (decoded.length < 32 || decoded.toString('base64url') !== text) {
    throw new Error('OS_SHELL_ADMISSION_SECRET must be canonical base64url with at least 256 bits');
  }
  return decoded;
}

function originalRequest(req, { allowLoopbackHttp = false } = {}) {
  if (req.headers['x-os-internal-authn-subrequest'] !== 'os-shell-v1') fail(403, 'OS Shell admission is internal only');
  if (req.headers.authorization) fail(403, 'bearer credentials are not admitted to OS Shell control');
  const method = String(req.headers['x-os-original-method'] || '').toUpperCase();
  const path = String(req.headers['x-os-original-uri'] || '').split('?', 1)[0];
  if (!METHODS.has(method) || !PATH.test(path)) fail(403, 'OS Shell request target is not admitted');
  const origin = normalizeOrigin(req.headers['x-os-original-origin'], { allowLoopbackHttp });
  return { method, path, origin, headers: req.headers, url: path };
}

function issue(payload, secret, nowMs, ttlSeconds) {
  const now = Math.floor(nowMs / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: TYPE }));
  const body = b64(JSON.stringify({
    iss: ADMISSION_ISSUER, aud: ADMISSION_AUDIENCE, jti: randomUUID(),
    iat: now, nbf: now - 1, exp: now + ttlSeconds, ...payload,
  }));
  const input = `${header}.${body}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function createOsShellAdmissionIssuer({ secret, now = () => Date.now(), ttlSeconds = 12, allowLoopbackHttp = false } = {}) {
  const key = admissionSecret(secret);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 15) throw new Error('OS Shell admission TTL must be 1..15 seconds');
  return async function authorize(req, authenticateBrowser) {
    const original = originalRequest(req, { allowLoopbackHttp });
    const session = await authenticateBrowser(original);
    if (!session?.actor || session.authorityDegraded) fail(503, 'current authorization authority is required');
    const actor = session.actor;
    const permissions = Array.isArray(actor.permissions) ? [...new Set(actor.permissions)].sort() : [];
    const roles = Array.isArray(actor.groups) ? [...new Set(actor.groups)].sort() : [];
    if (!permissions.includes('session:attach')) fail(403, 'session:attach permission is required');
    const credentialRevision = Number(actor.credentialRevision);
    const permissionRevision = canonicalPermissionRevision({ credentialRevision, roles, permissions });
    const csrfRequired = !['GET', 'HEAD', 'OPTIONS'].includes(original.method);
    return {
      assertion: issue({
        sub: String(actor.sub), browserSessionId: String(actor.browserSessionId),
        method: original.method, path: original.path, origin: original.origin,
        csrfRequired, csrfVerified: csrfRequired,
        aal: actor.assurance === 'aal2' ? 'aal2' : 'aal1',
        credentialRevision, roles, permissions, permissionRevision,
        // PostgREST serializes UTC timestamps with a `+00:00` suffix while the
        // verifier deliberately accepts one canonical representation. Convert
        // at the issuer boundary so equivalent database timestamps do not make
        // every otherwise-valid browser admission fail as non-canonical.
        browserIdleExpiresAt: canonicalTimestamp(session.row?.idle_expires_at, 'browser idle expiry'),
        browserAbsoluteExpiresAt: canonicalTimestamp(session.row?.absolute_expires_at, 'browser absolute expiry'),
      }, key, now(), ttlSeconds),
      permissionRevision,
    };
  };
}

function verifyOsShellAdmission(token, { secret, method, path, origin, now = () => Date.now(), allowLoopbackHttp = false } = {}) {
  const key = admissionSecret(secret);
  const parts = String(token || '').split('.');
  if (parts.length !== 3) fail(401, 'OS Shell admission assertion is malformed');
  const expected = createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { actual = Buffer.alloc(0); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(401, 'OS Shell admission signature rejected');
  let header; let claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
  catch { fail(401, 'OS Shell admission assertion is not canonical JSON'); }
  if (header.alg !== 'HS256' || header.typ !== TYPE || claims.iss !== ADMISSION_ISSUER || claims.aud !== ADMISSION_AUDIENCE) fail(401, 'OS Shell admission audience rejected');
  const current = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp - claims.iat > 15
      || claims.exp <= current || claims.nbf > current + 1 || claims.iat > current + 1) fail(401, 'OS Shell admission assertion expired');
  const exactMethod = String(method || '').toUpperCase();
  const exactPath = String(path || '').split('?', 1)[0];
  const exactOrigin = normalizeOrigin(origin, { allowLoopbackHttp });
  const csrfRequired = !['GET', 'HEAD', 'OPTIONS'].includes(exactMethod);
  if (claims.method !== exactMethod || claims.path !== exactPath || claims.origin !== exactOrigin
      || claims.csrfRequired !== csrfRequired || claims.csrfVerified !== csrfRequired) fail(403, 'OS Shell admission request projection changed');
  const revision = canonicalPermissionRevision(claims);
  if (claims.permissionRevision !== revision || !claims.permissions?.includes('session:attach')) fail(403, 'OS Shell admission authority projection changed');
  const idle = Date.parse(claims.browserIdleExpiresAt); const absolute = Date.parse(claims.browserAbsoluteExpiresAt);
  if (!Number.isFinite(idle) || !Number.isFinite(absolute) || idle <= now() || absolute < idle
      || new Date(idle).toISOString() !== claims.browserIdleExpiresAt
      || new Date(absolute).toISOString() !== claims.browserAbsoluteExpiresAt) fail(401, 'OS Shell browser expiry projection rejected');
  return Object.freeze(claims);
}

module.exports = {
  ADMISSION_AUDIENCE,
  ADMISSION_ISSUER,
  createOsShellAdmissionIssuer,
  originalRequest,
  verifyOsShellAdmission,
};
