'use strict';

const { timingSafeEqual } = require('node:crypto');
const { canonicalPermissionRevision } = require('./os-shell-contract');
const { verifyOsShellContextJws } = require('./os-shell-context');

function equal(left, right) { const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || '')); return a.length === b.length && timingSafeEqual(a, b); }

function createOsShellCredentialExchange({ secret, resolveShellSession, resolveBrowserSession, issueToken, now = () => Date.now() }) {
  if (String(secret || '').length < 32) throw new Error('OS Shell delegation service credential is required');
  return async function exchange(req, body) {
    if (!equal(req.headers['x-os-shell-delegation-secret'], secret)) throw { code: 401, msg: 'OS Shell delegation service rejected' };
    const binding = body?.binding || {};
    const session = await resolveShellSession(binding);
    if (!session) throw { code: 403, msg: 'durable OS Shell binding is not active' };
    verifyOsShellContextJws(body?.contextJws, session, { now });
    const browser = await resolveBrowserSession(session.browser_session_id, session.actor_id);
    if (!browser?.active || !Array.isArray(browser.permissions) || !browser.permissions.includes('session:attach')) {
      throw { code: browser?.code === 'AuthorizationAuthorityUnavailable' ? 503 : 403, msg: 'current browser authority rejected OS Shell delegation' };
    }
    const revision = canonicalPermissionRevision({ credentialRevision: Number(browser.authzRevision), roles: browser.groups || [], permissions: browser.permissions });
    if (revision !== session.permission_revision || browser.assurance !== session.aal) throw { code: 403, msg: 'OS Shell permission revision or assurance changed' };
    const issuedAt = Math.floor(now() / 1000); const expiresAt = issuedAt + 240;
    return { accessToken: issueToken({ sub: session.actor_id, jti: session.session_id, typ: 'web_shell',
      credential_revision: Number(browser.authzRevision), session_id: session.session_id, generation: Number(session.generation),
      fencing_epoch: Number(session.fencing_epoch), permission_revision: session.permission_revision, aal: session.aal, exp: expiresAt }),
    tokenExpiresAt: new Date(expiresAt * 1000).toISOString() };
  };
}

module.exports = { createOsShellCredentialExchange };
