import { createHash } from 'node:crypto';

const DEFAULT_COOKIE = '__Host-opensphere-session';

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

function cookies(header) {
  const result = new Map();
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !result.has(name)) result.set(name, value);
  }
  return result;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function readBrowserSessionProof(request, { requireCsrf = false, cookieName = DEFAULT_COOKIE } = {}) {
  const handle = cookies(request?.headers?.cookie).get(cookieName) || '';
  if (handle.length < 32 || handle.length > 512) {
    fail('SessionInvalid', 'active Console session is required', 401);
  }
  const csrf = String(request?.headers?.['x-os-csrf-token'] || '');
  if (requireCsrf && (csrf.length < 16 || csrf.length > 512)) {
    fail('CsrfRejected', 'Console session CSRF validation failed', 403);
  }
  return Object.freeze({
    handle,
    csrf,
    tokenDigest: digest(handle),
    csrfTokenDigest: requireCsrf ? digest(csrf) : null,
  });
}

export function createDatabaseSessionResolver({ store, cookieName = DEFAULT_COOKIE }) {
  if (!store?.resolveSession) throw new TypeError('session-capable authority store is required');
  return async function resolveSession(request, { requireCsrf = false } = {}) {
    const proof = readBrowserSessionProof(request, { requireCsrf, cookieName });
    const session = await store.resolveSession({
      tokenDigest: proof.tokenDigest,
      csrfTokenDigest: proof.csrfTokenDigest,
      requireCsrf,
    });
    return Object.freeze({
      sessionId: session.sessionId,
      subjectId: session.subjectId,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      authorityFresh: session.authorityFresh === true,
      permissions: Array.isArray(session.permissions) ? session.permissions : [],
      permissionRevision: String(session.permissionRevision),
      revokeEpoch: String(session.revokeEpoch),
      aal: session.aal,
    });
  };
}
