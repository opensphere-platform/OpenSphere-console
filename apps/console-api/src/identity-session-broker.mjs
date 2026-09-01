import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { readBrowserSessionProof } from './session-resolver.mjs';

const ACTIVE_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_MFA_TTL_MS = 5 * 60 * 1000;

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function credentials(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('ValidationFailed', 'login body must be an object', 400);
  const unknown = Object.keys(body).filter((key) => !['email', 'password'].includes(key));
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (unknown.length || email.length < 3 || email.length > 254 || !email.includes('@')
      || password.length < 1 || password.length > 1024) {
    fail('ValidationFailed', 'email and password are required', 400);
  }
  return { email, password };
}

function cookie(name, value, maxAge, httpOnly = false) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    ...(httpOnly ? ['HttpOnly'] : []),
    'Secure',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAge / 1000)}`,
  ].join('; ');
}

export function createIdentitySessionBroker({
  store,
  authClient,
  credentialCipher,
  publicOrigin,
  randomBytes = systemRandomBytes,
  clock = () => new Date(),
} = {}) {
  if (!store?.issueSession) throw new TypeError('session issue store is required');
  if (!store?.getPendingMfa || !store?.activateMfa) throw new TypeError('session MFA store is required');
  if (!authClient?.authenticatePassword || !authClient?.completeTotp || !authClient?.logout) throw new TypeError('Supabase Auth client is required');
  if (!credentialCipher?.encrypt || !credentialCipher?.decrypt) throw new TypeError('session credential cipher is required');
  if (typeof randomBytes !== 'function') throw new TypeError('secure random byte source is required');
  let origin;
  try { origin = new URL(publicOrigin).origin; } catch { throw new TypeError('Console public origin is invalid'); }
  if (origin !== publicOrigin || !origin.startsWith('https://')) throw new TypeError('Console public origin must be an HTTPS origin');

  return Object.freeze({
    async login({ body, requestOrigin, correlationId }) {
      if (String(requestOrigin || '') !== origin) fail('PermissionDenied', 'login origin is not allowed', 403);
      const input = credentials(body);
      const auth = await authClient.authenticatePassword(input);
      const handle = Buffer.from(randomBytes(32)).toString('base64url');
      const csrf = Buffer.from(randomBytes(24)).toString('base64url');
      if (handle.length !== 43 || csrf.length !== 32) fail('AuthorityUnavailable', 'secure random byte source failed', 503);
      const pendingMfa = Boolean(auth.verifiedTotpFactorId) && auth.aal !== 'aal2';
      const ttl = pendingMfa ? PENDING_MFA_TTL_MS : ACTIVE_TTL_MS;
      const expiresAt = new Date(clock().getTime() + ttl);
      let issued;
      try {
        issued = await store.issueSession({
          subjectId: auth.subjectId,
          tokenDigest: digest(handle),
          csrfTokenDigest: digest(csrf),
          accessTokenCiphertext: credentialCipher.encrypt(auth.accessToken),
          refreshTokenCiphertext: credentialCipher.encrypt(auth.refreshToken),
          authSessionRef: auth.authSessionRef,
          aal: auth.aal,
          expiresAt: expiresAt.toISOString(),
          pendingMfa,
          correlationId,
        });
      } catch (error) {
        await authClient.logout(auth.accessToken);
        throw error;
      }
      if (!issued?.sessionId || issued.subjectId !== auth.subjectId || issued.state !== (pendingMfa ? 'pending_mfa' : 'active')) {
        await authClient.logout(auth.accessToken);
        fail('AuthorityUnavailable', 'Console session authority returned an invalid record', 503);
      }
      const session = Object.freeze({
        id: issued.sessionId,
        current: true,
        status: issued.state,
        assurance: issued.aal,
        persistence: '24h',
        createdAt: issued.createdAt,
        lastSeenAt: issued.lastSeenAt,
        idleExpiresAt: issued.expiresAt,
        absoluteExpiresAt: issued.expiresAt,
        userAgentDigest: null,
      });
      return Object.freeze({
        cookies: Object.freeze([
          cookie('__Host-opensphere-session', handle, ttl, true),
          cookie('__Host-opensphere_csrf', csrf, ttl),
        ]),
        body: Object.freeze({
          mfaRequired: pendingMfa,
          mfaEnrollmentRequired: !pendingMfa && auth.aal !== 'aal2',
          session,
        }),
      });
    },

    async completeMfa({ request, body, correlationId }) {
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => key !== 'code')
          || !/^\d{6}$/u.test(String(body.code || ''))) {
        fail('ValidationFailed', 'current 6-digit authentication code is required', 400);
      }
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const pending = await store.getPendingMfa({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
      });
      if (!pending?.sessionId || !pending?.subjectId || !pending?.accessTokenCiphertext) {
        fail('AuthorityUnavailable', 'pending MFA authority returned an invalid record', 503);
      }
      const accessToken = credentialCipher.decrypt(pending.accessTokenCiphertext);
      const completed = await authClient.completeTotp({
        accessToken,
        code: String(body.code),
        expectedSubjectId: pending.subjectId,
      });
      const expiresAt = new Date(clock().getTime() + ACTIVE_TTL_MS);
      let activated;
      try {
        activated = await store.activateMfa({
          sessionId: pending.sessionId,
          subjectId: pending.subjectId,
          expectedAccessCiphertextDigest: digest(pending.accessTokenCiphertext),
          accessTokenCiphertext: credentialCipher.encrypt(completed.accessToken),
          refreshTokenCiphertext: credentialCipher.encrypt(completed.refreshToken),
          authSessionRef: completed.authSessionRef,
          expiresAt: expiresAt.toISOString(),
          correlationId,
        });
      } catch (error) {
        await authClient.logout(completed.accessToken);
        throw error;
      }
      if (!activated?.sessionId || activated.sessionId !== pending.sessionId
          || activated.subjectId !== pending.subjectId || activated.state !== 'active' || activated.aal !== 'aal2') {
        await authClient.logout(completed.accessToken);
        fail('AuthorityUnavailable', 'Console session MFA authority returned an invalid record', 503);
      }
      return Object.freeze({
        cookies: Object.freeze([
          cookie('__Host-opensphere-session', proof.handle, ACTIVE_TTL_MS, true),
          cookie('__Host-opensphere_csrf', proof.csrf, ACTIVE_TTL_MS),
        ]),
        body: Object.freeze({ assurance: 'aal2', sessionId: activated.sessionId }),
      });
    },
  });
}
