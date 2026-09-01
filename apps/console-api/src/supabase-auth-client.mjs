function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
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

  async function request(path, { method = 'GET', body, token } = {}) {
    let response;
    try {
      response = await fetchImpl(origin + path, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
    let document = {};
    try { document = await boundedJson(response, maximumResponseBytes); }
    catch {
      if (response.ok) fail('AuthorityUnavailable', 'Supabase Auth returned an invalid response', 503);
    }
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) fail('AuthenticationRequired', 'email or password is invalid', 401);
      if (response.status === 429) fail('RateLimited', 'Supabase Auth rate limit was reached', 429);
      fail('AuthorityUnavailable', 'Supabase Auth request failed', 503);
    }
    return document;
  }

  return Object.freeze({
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
      });
    },

    async logout(accessToken) {
      try { await request('/logout', { method: 'POST', token: accessToken }); }
      catch { /* Best-effort cleanup after local persistence failure. */ }
    },
  });
}
