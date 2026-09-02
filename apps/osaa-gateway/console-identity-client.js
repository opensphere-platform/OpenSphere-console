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
const EXACT_ROUTES = new Map([
  ['GET', new Set([
    '/api/manual/document', '/api/manual/documents', '/api/manual/search', '/api/manual/sources',
    '/api/osaa/health', '/api/osaa/conversations', '/api/osaa/operational/status',
    '/api/osaa/graph/nodes', '/api/osaa/incidents', '/api/osaa/incidents/stream',
    '/api/osaa/context', '/api/osaa/metacognition', '/api/osaa/operations',
    '/api/osaa/remediations', '/api/osaa/remediations/', '/api/osaa/remediations/status',
    '/api/osaa/admin/dialogue-state', '/api/osaa/admin/evidence',
    '/api/osaa/admin/knowledge/stats', '/api/osaa/admin/llm-keys', '/api/osaa/admin/usage',
    '/api/osaa/tools/action-bindings', '/api/osaa/tools/manifest',
  ])],
  ['POST', new Set([
    '/api/osaa/actions/bindings/execute', '/api/osaa/admin/dialogue-state',
    '/api/osaa/admin/evidence/retention', '/api/osaa/admin/knowledge/manual-seed/bundled',
    '/api/osaa/admin/knowledge/reembed', '/api/osaa/admin/llm-keys', '/api/osaa/chat',
    '/api/osaa/tools/control-plane/status',
  ])],
]);

function fail(code, msg) { throw { code, status: code, msg, message: msg }; }

function configuredOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Console session authority URL must be absolute'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new TypeError('Console session authority URL must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function targetPathAllowed(method, path) {
  if (EXACT_ROUTES.get(method)?.has(path)) return true;
  if (/^\/api\/osaa\/(?:conversations|incidents|operations|remediations)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path)) {
    if (path.includes('/conversations/')) return ['GET', 'PATCH', 'DELETE'].includes(method);
    return method === 'GET';
  }
  if (method === 'POST' && /^\/api\/osaa\/operations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/approvals$/i.test(path)) return true;
  if (method === 'POST' && /^\/api\/osaa\/remediations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:approvals\/source|browser-verifications)$/i.test(path)) return true;
  if (method === 'DELETE' && /^\/api\/osaa\/admin\/llm-keys\/[a-z0-9-]{1,128}$/u.test(path)) return true;
  if (method === 'POST' && /^\/api\/osaa\/admin\/llm-keys\/[a-z0-9-]{1,128}\/test$/u.test(path)) return true;
  return false;
}

function targetCredential(req) {
  const match = String(req?.headers?.authorization || '')
    .match(/^Bearer\s+([A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+)$/u);
  if (!match || match[1].length > 16384) fail(401, 'valid exchanged Owner bearer credential is required');
  let claims;
  try { claims = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8')); }
  catch { fail(401, 'Owner bearer credential payload is invalid'); }
  const subjectId = String(claims?.sub || '');
  const authSessionRef = String(claims?.session_id || '');
  const aal = String(claims?.aal || '');
  if (!UUID.test(subjectId) || authSessionRef.length < 1 || authSessionRef.length > 256
      || /[\u0000-\u001f\u007f]/u.test(authSessionRef) || !['aal1', 'aal2'].includes(aal)) {
    fail(401, 'Owner bearer credential coordinates are incomplete');
  }
  return Object.freeze({ token: match[1], subjectId, authSessionRef, aal });
}

function targetProjection(body, credential) {
  const projection = body?.data;
  const rawPermissions = projection?.permissions;
  const validPermissions = Array.isArray(rawPermissions) && rawPermissions.length <= 256
    && rawPermissions.every((permission) => typeof permission === 'string' && PERMISSION.test(permission))
    && Buffer.byteLength(JSON.stringify(rawPermissions)) <= 8192;
  const observedAt = typeof body?.observedAt === 'string' ? Date.parse(body.observedAt) : NaN;
  if (body?.schemaVersion !== '1.0' || body?.authority !== 'SupabaseAuth' || body?.freshness !== 'fresh'
      || !Number.isFinite(observedAt) || projection?.state !== 'Active'
      || !UUID.test(String(projection?.sessionId || '')) || projection?.subjectId !== credential.subjectId
      || projection?.aal !== credential.aal || typeof projection?.permissionRevision !== 'string'
      || !REVISION.test(projection.permissionRevision) || !Number.isSafeInteger(Number(projection.permissionRevision))
      || typeof projection?.revokeEpoch !== 'string' || !REVISION.test(projection.revokeEpoch)
      || !Number.isSafeInteger(Number(projection.revokeEpoch)) || !validPermissions) {
    fail(503, 'Console session authority returned an invalid current projection');
  }
  const permissionRevision = Number(projection.permissionRevision);
  const revokeEpoch = Number(projection.revokeEpoch);
  const permissions = [...new Set(rawPermissions)].sort();
  const groups = [...new Set(permissions.map((permission) => ROLE_MARKERS[permission]).filter(Boolean))].sort();
  return Object.freeze({ projection, permissions, groups, permissionRevision, revokeEpoch });
}

function mappedAuthorityStatus(status) {
  if (status === 401 || status === 403) return status;
  if (status >= 500) return 503;
  return 401;
}

function createConsoleIdentityVerifier({
  baseUrl,
  targetOwnerAdmission = false,
  ownerMarker = 'osaa-gateway-v1',
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const origin = configuredOrigin(baseUrl);
  if (targetOwnerAdmission && ownerMarker !== 'osaa-gateway-v1') throw new TypeError('C_AI Owner marker contract is closed');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('identity timeout is invalid');
  return async function verifyConsoleActor(req) {
    const method = String(req?.method || 'GET').toUpperCase();
    let path = '';
    if (targetOwnerAdmission) {
      try { path = new URL(String(req?.url || ''), 'http://owner.local').pathname; }
      catch { fail(400, 'Owner request URI is invalid'); }
      if (!targetPathAllowed(method, path)) fail(403, 'request is outside the exact admitted C_AI routes');
      if (req?.headers?.cookie || req?.headers?.['x-os-csrf-token']) fail(403, 'raw browser credentials reached C_AI');
      if (req?.headers?.['x-os-owner-admission'] !== ownerMarker) fail(403, 'C_AI Owner admission marker is invalid');
      if (!SAFE_METHODS.has(method) && req?.headers?.['x-os-owner-csrf-verified'] !== 'true') {
        fail(403, 'C_AI mutation requires verified browser CSRF');
      }
    }
    const credential = targetOwnerAdmission ? targetCredential(req) : null;
    const legacyMatch = targetOwnerAdmission ? null : String(req?.headers?.authorization || '').match(/^Bearer\s+([^\s]{32,16384})$/u);
    if (!targetOwnerAdmission && !legacyMatch) fail(401, 'no bearer token');
    const bearerToken = targetOwnerAdmission ? credential.token : legacyMatch[1];
    let response;
    try {
      response = await fetchImpl(origin + (targetOwnerAdmission ? '/api/identity/me' : '/api/identity/session'), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          accept: 'application/json',
          ...(targetOwnerAdmission ? {
            'x-os-owner-admission': ownerMarker,
            ...(req?.headers?.['x-os-correlation-id']
              ? { 'x-os-correlation-id': String(req.headers['x-os-correlation-id']).slice(0, 128) } : {}),
          } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { fail(503, 'Console session authority unavailable'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) fail(mappedAuthorityStatus(response.status), body?.message || body?.error || 'invalid Console session');

    if (targetOwnerAdmission) {
      const { projection, permissions, groups, permissionRevision, revokeEpoch } = targetProjection(body, credential);
      return Object.freeze({
        username: credential.subjectId,
        subject: credential.subjectId,
        sub: credential.subjectId,
        browserSessionId: String(projection.sessionId),
        authSessionRef: credential.authSessionRef,
        groups: Object.freeze(groups),
        permissions: Object.freeze(permissions),
        assurance: credential.aal,
        authzRevision: String(permissionRevision),
        credentialRevision: permissionRevision,
        revokeEpoch: String(revokeEpoch),
        bearerToken,
        provider: 'console-target-session',
      });
    }

    const subject = String(body?.subjectId || body?.subject || '');
    const permissions = Array.isArray(body?.permissions) ? [...new Set(body.permissions.map(String))].sort() : [];
    const explicitGroups = Array.isArray(body?.groups) ? body.groups.map(String) : [];
    const groups = [...new Set([...explicitGroups, ...permissions.map((permission) => ROLE_MARKERS[permission]).filter(Boolean)])].sort();
    const assurance = String(body?.aal || body?.assurance || 'aal1');
    if (!subject || !['aal1', 'aal2'].includes(assurance)) fail(503, 'Console session authority returned an invalid actor projection');
    return Object.freeze({
      username: String(body?.username || subject), subject, sub: subject, browserSessionId: String(body?.sessionId || ''),
      groups: Object.freeze(groups), permissions: Object.freeze(permissions), assurance,
      authzRevision: String(body?.permissionRevision || body?.authorizationRevision || body?.authzRevision || ''),
      credentialRevision: Number(body?.permissionRevision || body?.authorizationRevision || body?.authzRevision || 0),
      revokeEpoch: String(body?.revokeEpoch ?? ''), bearerToken, provider: 'supabase',
    });
  };
}

module.exports = { createConsoleIdentityVerifier, targetPathAllowed };
