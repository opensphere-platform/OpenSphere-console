'use strict';

const ROLE_MARKERS = Object.freeze({
  'console.role.admin': 'console-admins',
  'console.role.operator': 'console-operators',
  'console.role.viewer': 'console-viewers',
});

function configuredOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Console session authority URL must be absolute'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
      || !['', '/'].includes(parsed.pathname)) {
    throw new TypeError('Console session authority URL must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function createConsoleIdentityVerifier({
  baseUrl,
  targetOwnerAdmission = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const origin = configuredOrigin(baseUrl);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('identity timeout is invalid');
  return async function verifyConsoleActor(req) {
    const match = String(req?.headers?.authorization || '').match(/^Bearer\s+([^\s]{32,16384})$/iu);
    if (!match) throw { code: 401, msg: 'no bearer token' };
    let response;
    try {
      response = await fetchImpl(origin + (targetOwnerAdmission ? '/api/identity/me' : '/api/identity/session'), {
        headers: {
          authorization: `Bearer ${match[1]}`,
          accept: 'application/json',
          ...(targetOwnerAdmission ? { 'x-os-owner-admission': 'osaa-gateway-v1' } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw { code: 503, msg: 'Console session authority unavailable' };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.message || body?.error || 'invalid Console session';
      throw { code: response.status === 403 ? 403 : 401, msg: message };
    }
    const projection = targetOwnerAdmission ? body?.data : body;
    const subject = String(projection?.subjectId || projection?.subject || '');
    const permissions = Array.isArray(projection?.permissions) ? [...new Set(projection.permissions.map(String))].sort() : [];
    const explicitGroups = !targetOwnerAdmission && Array.isArray(projection?.groups) ? projection.groups.map(String) : [];
    const groups = [...new Set([...explicitGroups, ...permissions.map((permission) => ROLE_MARKERS[permission]).filter(Boolean)])].sort();
    const assurance = String(projection?.aal || projection?.assurance || 'aal1');
    const authzRevision = String(projection?.permissionRevision || projection?.authorizationRevision || projection?.authzRevision || '');
    if (!subject || !['aal1', 'aal2'].includes(assurance) || (targetOwnerAdmission && !authzRevision)) {
      throw { code: 503, msg: 'Console session authority returned an invalid actor projection' };
    }
    return Object.freeze({
      username: String(projection?.username || subject),
      subject,
      groups: Object.freeze(groups),
      permissions: Object.freeze(permissions),
      assurance,
      authzRevision,
      bearerToken: match[1],
      provider: targetOwnerAdmission ? 'console-target-session' : 'supabase',
    });
  };
}

module.exports = { createConsoleIdentityVerifier };
