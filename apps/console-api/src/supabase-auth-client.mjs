import { avatarProjection } from './profile-avatar.mjs';

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

const SESSION_PERSISTENCE = new Set(['browser', '1h', '4h', '8h', '12h', '24h', '3d', '7d', '14d', '30d']);

function sessionPersistence(user) {
  return declaredSessionPersistence(user) || '24h';
}

function declaredSessionPersistence(user) {
  const candidate = user?.user_metadata?.console_session_persistence;
  return typeof candidate === 'string' && SESSION_PERSISTENCE.has(candidate) ? candidate : undefined;
}

function configuredOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Supabase Auth URL must be an absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new TypeError('Supabase Auth URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

async function boundedJson(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('Supabase Auth response is too large');
  if (!response.body) throw new Error('Supabase Auth response body is missing');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error('Supabase Auth response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

function jwtClaims(token, now) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(claims.sub || ''))
        || claims.role !== 'authenticated'
        || !['aal1', 'aal2'].includes(claims.aal)
        || !Number.isSafeInteger(Number(claims.exp))
        || Number(claims.exp) <= Math.floor(now.getTime() / 1000) + 5) {
      throw new Error('invalid claims');
    }
    return claims;
  } catch {
    fail('AuthorityUnavailable', 'Supabase Auth returned an invalid access credential', 503);
  }
}

export function createSupabaseAuthClient({
  baseUrl,
  serviceRoleKey = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  maximumResponseBytes = 64 * 1024,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('Supabase Auth timeout is invalid');
  if (!Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 1024 || maximumResponseBytes > 1024 * 1024) {
    throw new TypeError('Supabase Auth response limit is invalid');
  }
  const origin = configuredOrigin(baseUrl);
  const adminKey = String(serviceRoleKey || '');
  if (adminKey && (adminKey.length < 32 || adminKey.length > 8192 || /[\r\n]/u.test(adminKey))) {
    throw new TypeError('Supabase service role key is invalid');
  }

  async function request(path, {
    method = 'GET', body, token, apiKey,
    rejectedCode = 'AuthenticationRequired',
    rejectedMessage = 'email or password is invalid',
    rejectedStatus = 401,
    rejectedStatuses = [400, 401],
    expectEmpty = false,
  } = {}) {
    let response;
    try {
      response = await fetchImpl(origin + path, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(apiKey ? { apikey: apiKey } : {}),
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      fail(timeout ? 'DependencyTimeout' : 'AuthorityUnavailable', timeout ? 'Supabase Auth timed out' : 'Supabase Auth is unavailable', 503);
    }
    if (expectEmpty && response.ok && response.status === 204) return {};
    let document = {};
    try { document = await boundedJson(response, maximumResponseBytes); }
    catch {
      if (response.ok) fail('AuthorityUnavailable', 'Supabase Auth returned an invalid response', 503);
    }
    if (!response.ok) {
      if (rejectedStatuses.includes(response.status)) fail(rejectedCode, rejectedMessage, rejectedStatus);
      if (response.status === 429) fail('RateLimited', 'Supabase Auth rate limit was reached', 429);
      fail('AuthorityUnavailable', 'Supabase Auth request failed', 503);
    }
    return document;
  }

  return Object.freeze({
    async readManagedUser(subjectId) {
      if (!adminKey) fail('AuthorityUnavailable', 'Supabase managed-user authority is unavailable', 503);
      const expectedSubjectId = String(subjectId || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(expectedSubjectId)) {
        fail('ValidationFailed', 'managed-user subject is invalid', 400);
      }
      const user = await request(`/admin/users/${encodeURIComponent(expectedSubjectId)}`, {
        token: adminKey,
        apiKey: adminKey,
        rejectedCode: 'ManagedIdentityNotFound',
        rejectedMessage: 'managed identity was not found in Supabase Auth',
        rejectedStatus: 404,
        rejectedStatuses: [404],
      });
      if (String(user?.id || '') !== expectedSubjectId) {
        fail('AuthorityUnavailable', 'Supabase Auth changed the managed-user subject', 503);
      }
      const metadata = user?.user_metadata && typeof user.user_metadata === 'object' && !Array.isArray(user.user_metadata)
        ? user.user_metadata : {};
      const email = String(user?.email || '').trim().toLowerCase();
      const username = String(metadata.preferred_username || (email.includes('@') ? email.split('@')[0] : '')).trim();
      const displayName = String(metadata.display_name || metadata.name || username).trim();
      if (email.length > 254 || username.length < 1 || username.length > 63
          || displayName.length < 1 || displayName.length > 120
          || /[\r\n\u0000-\u001f\u007f]/u.test(username + displayName)) {
        fail('AuthorityUnavailable', 'Supabase Auth returned an invalid managed-user profile', 503);
      }
      const factors = Array.isArray(user?.factors) ? user.factors.filter((factor) => factor?.factor_type === 'totp') : [];
      const verifiedTotpCount = factors.filter((factor) => factor?.status === 'verified').length;
      const bannedUntil = Date.parse(String(user?.banned_until || ''));
      return Object.freeze({
        id: expectedSubjectId,
        username,
        displayName,
        email,
        enabled: !Number.isFinite(bannedUntil) || bannedUntil <= now().getTime(),
        mfa: Object.freeze({
          totpCount: factors.length,
          verifiedTotpCount,
          status: verifiedTotpCount ? 'registered' : 'enrollment-required',
        }),
      });
    },

    async readProfileAvatar({ accessToken, expectedSubjectId }) {
      const claims = jwtClaims(accessToken, now());
      if (String(claims.sub) !== String(expectedSubjectId || '')) {
        fail('AuthenticationRequired', 'profile avatar subject does not match', 401);
      }
      const user = await request('/user', { token: accessToken });
      if (String(user?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth profile avatar subject changed', 503);
      }
      return Object.freeze({ subjectId: String(claims.sub), projection: avatarProjection(user) });
    },

    async updateProfileAvatar({ accessToken, expectedSubjectId, metadata }) {
      const claims = jwtClaims(accessToken, now());
      if (String(claims.sub) !== String(expectedSubjectId || '')) {
        fail('AuthenticationRequired', 'profile avatar subject does not match', 401);
      }
      const updated = await request('/user', {
        method: 'PUT', token: accessToken,
        body: { data: { console_avatar: metadata } },
        rejectedCode: 'AvatarRejected', rejectedMessage: 'profile avatar update was rejected',
        rejectedStatus: 400, rejectedStatuses: [400, 401, 422],
      });
      if (String(updated?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth profile avatar subject changed', 503);
      }
      const projection = avatarProjection(updated);
      if (projection.current.source !== metadata.source
          || (metadata.source === 'linked' && (projection.current.provider !== metadata.provider || projection.current.url !== metadata.url))
          || (metadata.source === 'upload' && (projection.current.digest !== metadata.digest || projection.current.contentType !== metadata.contentType))) {
        fail('AuthorityUnavailable', 'Supabase Auth did not confirm the profile avatar', 503);
      }
      return Object.freeze({ subjectId: String(claims.sub), projection });
    },

    async readSessionPreference({ accessToken, expectedSubjectId }) {
      const claims = jwtClaims(accessToken, now());
      if (String(claims.sub) !== String(expectedSubjectId || '')) {
        fail('AuthenticationRequired', 'session preference subject does not match', 401);
      }
      const user = await request('/user', { token: accessToken });
      if (String(user?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth session preference subject changed', 503);
      }
      return Object.freeze({ subjectId: String(claims.sub), duration: sessionPersistence(user) });
    },

    async updateSessionPreference({ accessToken, expectedSubjectId, duration }) {
      const selected = String(duration || '');
      if (!SESSION_PERSISTENCE.has(selected)) {
        fail('ValidationFailed', 'session preference duration is invalid', 400);
      }
      const claims = jwtClaims(accessToken, now());
      if (String(claims.sub) !== String(expectedSubjectId || '')) {
        fail('AuthenticationRequired', 'session preference subject does not match', 401);
      }
      const updated = await request('/user', {
        method: 'PUT', token: accessToken,
        body: { data: { console_session_persistence: selected } },
        rejectedCode: 'PreferenceRejected',
        rejectedMessage: 'session preference update was rejected',
        rejectedStatus: 400,
        rejectedStatuses: [400, 401, 422],
      });
      if (String(updated?.id || '') !== String(claims.sub)
          || declaredSessionPersistence(updated) !== selected) {
        fail('AuthorityUnavailable', 'Supabase Auth did not confirm the session preference', 503);
      }
      return Object.freeze({ subjectId: String(claims.sub), duration: selected });
    },

    async createOwnedPasswordRecoveryLink({ accessToken, expectedSubjectId, redirectUrl, publicOrigin }) {
      if (!adminKey) fail('AuthorityUnavailable', 'Supabase recovery-link authority is unavailable', 503);
      const claims = jwtClaims(accessToken, now());
      if (String(claims.sub) !== String(expectedSubjectId || '')) {
        fail('AuthenticationRequired', 'password recovery subject does not match', 401);
      }
      const user = await request('/user', { token: accessToken });
      const email = String(user?.email || '').trim();
      if (String(user?.id || '') !== String(claims.sub)
          || email.length < 3 || email.length > 254
          || !/^[^@\s]+@[^@\s]+[.][^@\s]+$/u.test(email)) {
        fail('AuthorityUnavailable', 'Supabase Auth returned no verified recovery subject', 503);
      }
      let publicUrl;
      try { publicUrl = new URL(publicOrigin); } catch {
        fail('AuthorityUnavailable', 'Console recovery-link origin is invalid', 503);
      }
      if (publicUrl.origin !== publicOrigin || publicUrl.protocol !== 'https:'
          || redirectUrl !== publicUrl.origin + '/auth/recovery') {
        fail('AuthorityUnavailable', 'Console recovery-link redirect is invalid', 503);
      }
      const generated = await request('/admin/generate_link', {
        method: 'POST', token: adminKey, apiKey: adminKey,
        body: { type: 'recovery', email, redirect_to: redirectUrl },
        rejectedCode: 'RecoveryLinkRejected',
        rejectedMessage: 'password recovery link request was rejected',
        rejectedStatus: 400,
        rejectedStatuses: [400, 401, 403, 409, 422],
      });
      const returnedSubjectId = String(generated?.id || generated?.user?.id || '');
      if (returnedSubjectId && returnedSubjectId !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth changed the recovery-link subject', 503);
      }
      const rawActionLink = generated?.action_link || generated?.properties?.action_link;
      let action;
      try { action = new URL(String(rawActionLink || ''), origin + '/'); } catch {
        fail('AuthorityUnavailable', 'Supabase Auth returned no usable recovery link', 503);
      }
      const hasToken = ['token', 'token_hash'].some((name) => {
        const value = action.searchParams.get(name);
        return value != null && value.length >= 8 && value.length <= 16384;
      });
      if (action.origin !== origin || action.pathname !== '/verify'
          || action.searchParams.get('type') !== 'recovery'
          || action.searchParams.get('redirect_to') !== redirectUrl || !hasToken) {
        fail('AuthorityUnavailable', 'Supabase Auth returned an invalid recovery link', 503);
      }
      const publicAction = new URL('/auth/v1/verify', publicUrl.origin);
      publicAction.search = action.search;
      return Object.freeze({ subjectId: String(claims.sub), resetUrl: publicAction.toString() });
    },

    async createInitialAdministrator({ username, displayName, email, password }) {
      if (!adminKey) fail('AuthorityUnavailable', 'Supabase administrator authority is unavailable', 503);
      const created = await request('/admin/users', {
        method: 'POST', token: adminKey, apiKey: adminKey,
        body: {
          email,
          password,
          email_confirm: true,
          user_metadata: { preferred_username: username, display_name: displayName },
        },
        rejectedCode: 'BootstrapRejected',
        rejectedMessage: 'initial administrator account was rejected',
        rejectedStatus: 400,
        rejectedStatuses: [400, 409, 422],
      });
      const subjectId = String(created?.id || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(subjectId)) {
        fail('AuthorityUnavailable', 'Supabase Auth returned no initial administrator subject', 503);
      }
      return Object.freeze({ subjectId });
    },

    async deleteInitialAdministrator(subjectId) {
      if (!adminKey) return;
      await request(`/admin/users/${encodeURIComponent(String(subjectId))}`, {
        method: 'DELETE', token: adminKey, apiKey: adminKey,
        rejectedCode: 'BootstrapCleanupRejected',
        rejectedMessage: 'unclaimed initial administrator cleanup was rejected',
        rejectedStatus: 503,
        rejectedStatuses: [400, 401, 403, 404, 409, 422],
      });
    },

    async authenticatePassword({ email, password }) {
      const session = await request('/token?grant_type=password', { method: 'POST', body: { email, password } });
      if (!session?.access_token || !session?.refresh_token) {
        fail('AuthorityUnavailable', 'Supabase Auth returned no usable session', 503);
      }
      const claims = jwtClaims(session.access_token, now());
      const user = await request('/user', { token: session.access_token });
      if (String(user?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth subject verification failed', 503);
      }
      const verifiedTotp = (Array.isArray(user.factors) ? user.factors : [])
        .find((factor) => factor?.factor_type === 'totp' && factor?.status === 'verified');
      return Object.freeze({
        subjectId: String(claims.sub),
        accessToken: String(session.access_token),
        refreshToken: String(session.refresh_token),
        authSessionRef: String(claims.session_id || claims.sub),
        aal: claims.aal,
        accessTokenExpiresAt: new Date(Number(claims.exp) * 1000).toISOString(),
        sessionPersistence: sessionPersistence(user),
        verifiedTotpFactorId: verifiedTotp?.id ? String(verifiedTotp.id) : null,
      });
    },

    async completeTotp({ accessToken, code, expectedSubjectId }) {
      if (!/^\d{6}$/u.test(String(code || ''))) {
        fail('ValidationFailed', 'current 6-digit authentication code is required', 400);
      }
      const currentClaims = jwtClaims(accessToken, now());
      if (String(currentClaims.sub) !== String(expectedSubjectId || '')) {
        fail('AuthenticationRequired', 'pending MFA subject does not match', 401);
      }
      const currentUser = await request('/user', { token: accessToken });
      if (String(currentUser?.id || '') !== String(currentClaims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth subject verification failed', 503);
      }
      const factor = (Array.isArray(currentUser.factors) ? currentUser.factors : [])
        .find((candidate) => candidate?.factor_type === 'totp' && candidate?.status === 'verified' && candidate?.id);
      if (!factor) fail('MfaFactorUnavailable', 'verified TOTP factor was not found', 409);
      const factorId = encodeURIComponent(String(factor.id));
      const challenge = await request(`/factors/${factorId}/challenge`, {
        method: 'POST', token: accessToken, body: {},
      });
      if (!challenge?.id) fail('AuthorityUnavailable', 'Supabase Auth returned no MFA challenge', 503);
      const verification = await request(`/factors/${factorId}/verify`, {
        method: 'POST',
        token: accessToken,
        body: { challenge_id: String(challenge.id), code: String(code) },
      });
      const session = verification?.session || verification;
      if (!session?.access_token || !session?.refresh_token) {
        fail('AuthorityUnavailable', 'Supabase Auth returned no aal2 session', 503);
      }
      const claims = jwtClaims(session.access_token, now());
      if (claims.aal !== 'aal2' || String(claims.sub) !== String(expectedSubjectId)) {
        fail('AuthorityUnavailable', 'Supabase Auth did not produce the expected aal2 subject', 503);
      }
      const user = await request('/user', { token: session.access_token });
      if (String(user?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth aal2 subject verification failed', 503);
      }
      return Object.freeze({
        subjectId: String(claims.sub),
        accessToken: String(session.access_token),
        refreshToken: String(session.refresh_token),
        authSessionRef: String(claims.session_id || claims.sub),
        aal: 'aal2',
        accessTokenExpiresAt: new Date(Number(claims.exp) * 1000).toISOString(),
      });
    },

    async beginTotpEnrollment({ accessToken, expectedSubjectId, friendlyName }) {
      const claims = jwtClaims(accessToken, now());
      if (String(claims.sub) !== String(expectedSubjectId || '')) {
        fail('AuthenticationRequired', 'TOTP enrollment subject does not match', 401);
      }
      const name = String(friendlyName || '').trim();
      if (name.length < 1 || name.length > 64 || /[\r\n\u0000-\u001f\u007f]/u.test(name)) {
        fail('ValidationFailed', 'TOTP friendly name is invalid', 400);
      }
      const currentUser = await request('/user', { token: accessToken });
      if (String(currentUser?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth subject verification failed', 503);
      }
      const factors = Array.isArray(currentUser.factors) ? currentUser.factors : [];
      if (factors.some((factor) => factor?.factor_type === 'totp' && factor?.status === 'verified')) {
        fail('MfaAlreadyEnrolled', 'a verified TOTP factor is already registered', 409);
      }
      for (const factor of factors.filter((candidate) => candidate?.factor_type === 'totp'
        && candidate?.status === 'unverified' && candidate?.id)) {
        await request(`/factors/${encodeURIComponent(String(factor.id))}`, {
          method: 'DELETE', token: accessToken,
          rejectedCode: 'MfaEnrollmentRejected', rejectedMessage: 'stale TOTP factor cleanup was rejected', rejectedStatus: 409,
        });
      }
      const enrollment = await request('/factors', {
        method: 'POST', token: accessToken,
        body: { factor_type: 'totp', friendly_name: name },
        rejectedCode: 'MfaEnrollmentRejected', rejectedMessage: 'TOTP enrollment was rejected', rejectedStatus: 409,
      });
      const factorId = String(enrollment?.id || '');
      const secret = String(enrollment?.totp?.secret || '');
      const qrCode = String(enrollment?.totp?.qr_code || '');
      const uri = String(enrollment?.totp?.uri || '');
      if (factorId.length < 1 || factorId.length > 256 || /[\r\n\u0000-\u001f\u007f]/u.test(factorId)
          || secret.length < 8 || secret.length > 256 || /\s/u.test(secret)
          || qrCode.length > 48 * 1024 || uri.length > 4096) {
        fail('AuthorityUnavailable', 'Supabase Auth returned invalid TOTP enrollment material', 503);
      }
      return Object.freeze({ factorId, secret, qrCode, uri });
    },

    async verifyTotpEnrollment({ accessToken, factorId, code, expectedSubjectId }) {
      const normalizedFactorId = String(factorId || '');
      if (normalizedFactorId.length < 1 || normalizedFactorId.length > 256
          || /[\r\n\u0000-\u001f\u007f]/u.test(normalizedFactorId)
          || !/^\d{6}$/u.test(String(code || ''))) {
        fail('ValidationFailed', 'TOTP factor and current 6-digit authentication code are required', 400);
      }
      const claims = jwtClaims(accessToken, now());
      if (String(claims.sub) !== String(expectedSubjectId || '')) {
        fail('AuthenticationRequired', 'TOTP enrollment subject does not match', 401);
      }
      const currentUser = await request('/user', { token: accessToken });
      if (String(currentUser?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth subject verification failed', 503);
      }
      const factor = (Array.isArray(currentUser.factors) ? currentUser.factors : [])
        .find((candidate) => candidate?.factor_type === 'totp' && candidate?.status === 'unverified'
          && String(candidate?.id || '') === normalizedFactorId);
      if (!factor) fail('MfaFactorUnavailable', 'pending TOTP factor was not found for this subject', 409);
      const encodedFactorId = encodeURIComponent(normalizedFactorId);
      const challenge = await request(`/factors/${encodedFactorId}/challenge`, {
        method: 'POST', token: accessToken, body: {},
        rejectedCode: 'MfaProofRejected', rejectedMessage: 'TOTP challenge was rejected', rejectedStatus: 401,
      });
      if (!challenge?.id) fail('AuthorityUnavailable', 'Supabase Auth returned no MFA challenge', 503);
      const verification = await request(`/factors/${encodedFactorId}/verify`, {
        method: 'POST', token: accessToken,
        body: { challenge_id: String(challenge.id), code: String(code) },
        rejectedCode: 'MfaProofRejected', rejectedMessage: 'TOTP proof was rejected', rejectedStatus: 401,
      });
      const session = verification?.session || verification;
      if (!session?.access_token || !session?.refresh_token) {
        fail('AuthorityUnavailable', 'Supabase Auth returned no aal2 enrollment session', 503);
      }
      const completedClaims = jwtClaims(session.access_token, now());
      if (completedClaims.aal !== 'aal2' || String(completedClaims.sub) !== String(expectedSubjectId)) {
        fail('AuthorityUnavailable', 'Supabase Auth did not produce the expected aal2 subject', 503);
      }
      const completedUser = await request('/user', { token: session.access_token });
      const verifiedFactor = (Array.isArray(completedUser?.factors) ? completedUser.factors : [])
        .some((candidate) => candidate?.factor_type === 'totp' && candidate?.status === 'verified'
          && String(candidate?.id || '') === normalizedFactorId);
      if (String(completedUser?.id || '') !== String(completedClaims.sub) || !verifiedFactor) {
        fail('AuthorityUnavailable', 'Supabase Auth TOTP enrollment verification was not durable', 503);
      }
      return Object.freeze({
        subjectId: String(completedClaims.sub),
        accessToken: String(session.access_token),
        refreshToken: String(session.refresh_token),
        authSessionRef: String(completedClaims.session_id || completedClaims.sub),
        aal: 'aal2',
        accessTokenExpiresAt: new Date(Number(completedClaims.exp) * 1000).toISOString(),
      });
    },

    async refreshSession({ refreshToken, expectedSubjectId }) {
      if (!refreshToken || !expectedSubjectId) {
        fail('SessionCredentialInvalid', 'refresh credential binding is invalid', 401);
      }
      const session = await request('/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: String(refreshToken) },
        rejectedCode: 'RefreshRejected',
        rejectedMessage: 'Supabase Auth explicitly rejected the current refresh credential',
        rejectedStatus: 401,
      });
      if (!session?.access_token || !session?.refresh_token) {
        fail('AuthorityUnavailable', 'Supabase Auth returned no rotated session', 503);
      }
      const claims = jwtClaims(session.access_token, now());
      if (String(claims.sub) !== String(expectedSubjectId)
          || String(session.user?.id || '') !== String(expectedSubjectId)) {
        fail('AuthorityUnavailable', 'Supabase Auth refresh subject verification failed', 503);
      }
      return Object.freeze({
        subjectId: String(claims.sub),
        accessToken: String(session.access_token),
        refreshToken: String(session.refresh_token),
        authSessionRef: String(claims.session_id || claims.sub),
        aal: claims.aal,
        accessTokenExpiresAt: new Date(Number(claims.exp) * 1000).toISOString(),
      });
    },

    async completePasswordRecovery({ recoveryAccessToken, password }) {
      const accessToken = String(recoveryAccessToken || '');
      const nextPassword = String(password || '');
      if (accessToken.length < 64 || accessToken.length > 16384
          || !/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/u.test(accessToken)
          || nextPassword.length < 12 || nextPassword.length > 1024) {
        fail('ValidationFailed', 'a valid recovery proof and password of at least 12 characters are required', 400);
      }
      const claims = jwtClaims(accessToken, now());
      const methods = Array.isArray(claims.amr)
        ? claims.amr.map((entry) => typeof entry === 'string' ? entry : entry?.method)
        : [];
      if (!methods.includes('recovery')) {
        fail('RecoveryRejected', 'password recovery proof is invalid or expired', 401);
      }
      const user = await request('/user', {
        token: accessToken,
        rejectedCode: 'RecoveryRejected',
        rejectedMessage: 'password recovery proof is invalid or expired',
      });
      if (String(user?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth recovery subject verification failed', 503);
      }
      const updated = await request('/user', {
        method: 'PUT', token: accessToken, body: { password: nextPassword },
        rejectedCode: 'RecoveryRejected',
        rejectedMessage: 'password recovery proof or password policy was rejected',
        rejectedStatus: 400,
        rejectedStatuses: [400, 401, 422],
      });
      if (String(updated?.id || '') !== String(claims.sub)) {
        fail('AuthorityUnavailable', 'Supabase Auth password recovery subject changed', 503);
      }
      return Object.freeze({ subjectId: String(claims.sub), accessToken });
    },

    async logoutAll(accessToken) {
      await request('/logout?scope=global', {
        method: 'POST', token: accessToken, expectEmpty: true,
        rejectedCode: 'AuthenticationRequired',
        rejectedMessage: 'Supabase Auth session is no longer active',
      });
    },

    async logout(accessToken) {
      try { await request('/logout?scope=global', { method: 'POST', token: accessToken, expectEmpty: true }); }
      catch { /* Best-effort cleanup after local persistence failure. */ }
    },
  });
}
