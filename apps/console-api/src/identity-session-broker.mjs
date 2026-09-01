import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { createDatabaseSessionResolver, readBrowserSessionProof } from './session-resolver.mjs';

const PENDING_MFA_TTL_MS = 5 * 60 * 1000;
const IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 30 * 1000;
const SESSION_DURATION_MS = Object.freeze({
  browser: 24 * 60 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});

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

function cookie(name, value, maxAge, httpOnly = false, persistent = true) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    ...(httpOnly ? ['HttpOnly'] : []),
    'Secure',
    'SameSite=Strict',
    ...(persistent ? [`Max-Age=${Math.floor(maxAge / 1000)}`] : []),
  ].join('; ');
}

function sessionPersistence(value) {
  const persistence = value == null ? '24h' : String(value);
  if (!Object.hasOwn(SESSION_DURATION_MS, persistence)) {
    fail('AuthorityUnavailable', 'Supabase Auth returned an invalid session persistence policy', 503);
  }
  return persistence;
}

export function createIdentitySessionBroker({
  store,
  authClient,
  credentialCipher,
  publicOrigin,
  randomBytes = systemRandomBytes,
  clock = () => new Date(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!store?.issueSession) throw new TypeError('session issue store is required');
  if (!store?.getPendingMfa || !store?.activateMfa) throw new TypeError('session MFA store is required');
  if (!store?.getRefreshCredentials || !store?.rotateCredentials || !store?.rejectRefresh) throw new TypeError('session refresh store is required');
  if (!store?.touchActivity) throw new TypeError('session activity store is required');
  if (!authClient?.authenticatePassword || !authClient?.completeTotp || !authClient?.refreshSession || !authClient?.logout) throw new TypeError('Supabase Auth client is required');
  if (!credentialCipher?.encrypt || !credentialCipher?.decrypt) throw new TypeError('session credential cipher is required');
  if (typeof randomBytes !== 'function') throw new TypeError('secure random byte source is required');
  if (typeof wait !== 'function') throw new TypeError('bounded refresh wait is required');
  let origin;
  try { origin = new URL(publicOrigin).origin; } catch { throw new TypeError('Console public origin is invalid'); }
  if (origin !== publicOrigin || !origin.startsWith('https://')) throw new TypeError('Console public origin must be an HTTPS origin');
  const baseResolveSession = createDatabaseSessionResolver({ store });

  function refreshDue(session) {
    if (session.accessTokenExpiresAt == null) return false;
    const expiresAt = new Date(session.accessTokenExpiresAt).getTime();
    if (!Number.isFinite(expiresAt)) fail('AuthenticationRequired', 'session credential expiry is invalid', 401);
    return expiresAt <= clock().getTime() + REFRESH_WINDOW_MS;
  }

  async function peerRotation(request, options) {
    let latest;
    for (const milliseconds of [0, 25, 75, 150]) {
      if (milliseconds) await wait(milliseconds);
      latest = await baseResolveSession(request, options);
      if (!refreshDue(latest)) return latest;
    }
    return null;
  }

  return Object.freeze({
    async login({ body, requestOrigin, correlationId }) {
      if (String(requestOrigin || '') !== origin) fail('PermissionDenied', 'login origin is not allowed', 403);
      const input = credentials(body);
      const auth = await authClient.authenticatePassword(input);
      const handle = Buffer.from(randomBytes(32)).toString('base64url');
      const csrf = Buffer.from(randomBytes(24)).toString('base64url');
      if (handle.length !== 43 || csrf.length !== 32) fail('AuthorityUnavailable', 'secure random byte source failed', 503);
      const pendingMfa = Boolean(auth.verifiedTotpFactorId) && auth.aal !== 'aal2';
      const persistence = sessionPersistence(auth.sessionPersistence);
      const absoluteTtl = SESSION_DURATION_MS[persistence];
      const absoluteExpiresAt = new Date(clock().getTime() + absoluteTtl);
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
          accessTokenExpiresAt: auth.accessTokenExpiresAt,
          absoluteExpiresAt: absoluteExpiresAt.toISOString(),
          persistence,
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
        persistence: issued.persistence,
        createdAt: issued.createdAt,
        lastSeenAt: issued.lastSeenAt,
        idleExpiresAt: issued.idleExpiresAt,
        absoluteExpiresAt: issued.absoluteExpiresAt,
        userAgentDigest: null,
      });
      return Object.freeze({
        cookies: Object.freeze([
          cookie('__Host-opensphere-session', handle, pendingMfa ? PENDING_MFA_TTL_MS : absoluteTtl, true, pendingMfa || persistence !== 'browser'),
          cookie('__Host-opensphere_csrf', csrf, pendingMfa ? PENDING_MFA_TTL_MS : absoluteTtl, false, pendingMfa || persistence !== 'browser'),
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
      let activated;
      try {
        activated = await store.activateMfa({
          sessionId: pending.sessionId,
          subjectId: pending.subjectId,
          expectedAccessCiphertextDigest: digest(pending.accessTokenCiphertext),
          accessTokenCiphertext: credentialCipher.encrypt(completed.accessToken),
          refreshTokenCiphertext: credentialCipher.encrypt(completed.refreshToken),
          authSessionRef: completed.authSessionRef,
          accessTokenExpiresAt: completed.accessTokenExpiresAt,
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
          cookie('__Host-opensphere-session', proof.handle,
            Math.max(0, new Date(pending.absoluteExpiresAt).getTime() - clock().getTime()), true,
            pending.persistence !== 'browser'),
          cookie('__Host-opensphere_csrf', proof.csrf,
            Math.max(0, new Date(pending.absoluteExpiresAt).getTime() - clock().getTime()), false,
            pending.persistence !== 'browser'),
        ]),
        body: Object.freeze({ assurance: 'aal2', sessionId: activated.sessionId }),
      });
    },

    async touchActivity(request) {
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const session = await store.touchActivity({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
      });
      if (!session?.sessionId || session.state !== 'active') {
        fail('AuthorityUnavailable', 'session activity authority returned an invalid record', 503);
      }
      return Object.freeze({
        id: session.sessionId,
        current: true,
        status: 'active',
        assurance: session.aal,
        persistence: session.persistence,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        userAgentDigest: null,
      });
    },

    async resolveSession(request, { requireCsrf = false, correlationId } = {}) {
      const options = { requireCsrf };
      let session = await baseResolveSession(request, options);
      if (!refreshDue(session)) return session;

      const proof = readBrowserSessionProof(request, options);
      let current;
      try {
        current = await store.getRefreshCredentials({
          tokenDigest: proof.tokenDigest,
          csrfTokenDigest: proof.csrfTokenDigest,
          requireCsrf,
        });
      } catch (error) {
        if (error?.code === 'RefreshNotRequired') return baseResolveSession(request, options);
        throw error;
      }
      if (!current?.sessionId || !current?.subjectId || !current?.refreshTokenCiphertext) {
        fail('AuthorityUnavailable', 'session refresh authority returned an invalid record', 503);
      }
      const expectedRefreshCiphertextDigest = digest(current.refreshTokenCiphertext);
      let refreshed;
      try {
        refreshed = await authClient.refreshSession({
          refreshToken: credentialCipher.decrypt(current.refreshTokenCiphertext),
          expectedSubjectId: current.subjectId,
        });
      } catch (error) {
        if (error?.code !== 'RefreshRejected') throw error;
        const peer = await peerRotation(request, options);
        if (peer) return peer;
        const rejected = await store.rejectRefresh({
          sessionId: current.sessionId,
          subjectId: current.subjectId,
          expectedRefreshCiphertextDigest,
          correlationId,
        });
        if (rejected.outcome === 'peer_rotated') {
          session = await baseResolveSession(request, options);
          if (!refreshDue(session)) return session;
          fail('AuthorityUnavailable', 'peer session refresh is still settling', 503);
        }
        fail('AuthenticationRequired', 'Supabase Auth explicitly rejected the current refresh credential', 401);
      }

      const rotated = await store.rotateCredentials({
        sessionId: current.sessionId,
        subjectId: current.subjectId,
        expectedRefreshCiphertextDigest,
        accessTokenCiphertext: credentialCipher.encrypt(refreshed.accessToken),
        refreshTokenCiphertext: credentialCipher.encrypt(refreshed.refreshToken),
        authSessionRef: refreshed.authSessionRef,
        aal: refreshed.aal,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        correlationId,
      });
      if (!['rotated', 'peer_rotated'].includes(rotated.outcome)) {
        fail('AuthorityUnavailable', 'session refresh authority returned an invalid outcome', 503);
      }
      session = await baseResolveSession(request, options);
      if (refreshDue(session)) fail('AuthorityUnavailable', 'session credential rotation is still settling', 503);
      return session;
    },
  });
}
