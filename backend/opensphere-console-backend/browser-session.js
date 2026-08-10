'use strict';

const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} = require('crypto');

const COOKIE_NAME = '__Host-opensphere_session';
const IDLE_TTL_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DURATION = '24h';
const DURATION_MS = Object.freeze({
  browser: 24 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
});

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function safeEqualHash(expected, value) {
  const left = Buffer.from(String(expected || ''), 'hex');
  const right = Buffer.from(sha256(value), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header) {
  const out = {};
  for (const item of String(header || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function encodeSecret(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decodeSecret(value, key) {
  const [version, iv, tag, payload] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !tag || !payload) throw { code: 401, msg: 'browser session credential is unreadable' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw { code: 401, msg: 'browser session credential integrity check failed' };
  }
}

function duration(value) {
  const normalized = String(value || DEFAULT_DURATION).trim();
  if (!Object.hasOwn(DURATION_MS, normalized)) throw { code: 400, msg: 'unsupported session duration' };
  return normalized;
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function errorStatus(error) {
  const value = Number(error?.code || error?.status || 0);
  return Number.isFinite(value) ? value : 0;
}

function authorityUnavailable(error) {
  const status = errorStatus(error);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function tokenActuallyExpired(error, token, currentMs) {
  if (error?.reason === 'token_expired') return true;
  const expiresAt = jwtExpiry(token);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= currentMs;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clientNetworkDigest(req) {
  const raw = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (!raw) return null;
  const prefix = raw.includes(':')
    ? raw.split(':').slice(0, 4).join(':')
    : raw.split('.').slice(0, 3).join('.');
  return sha256(prefix);
}

function cookies(value, persistence, csrfToken) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ];
  if (persistence !== 'browser') attributes.push(`Max-Age=${Math.floor(DURATION_MS[persistence] / 1000)}`);
  const csrf = [
    `__Host-opensphere_csrf=${encodeURIComponent(csrfToken)}`,
    'Path=/',
    'Secure',
    'SameSite=Strict',
  ];
  if (persistence !== 'browser') csrf.push(`Max-Age=${Math.floor(DURATION_MS[persistence] / 1000)}`);
  return [attributes.join('; '), csrf.join('; ')];
}

function clearCookies() {
  return [
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    '__Host-opensphere_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0',
  ];
}

function publicSession(row, currentId) {
  return {
    id: row.id,
    current: row.id === currentId,
    status: row.status,
    assurance: row.assurance,
    persistence: row.persistence,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
    userAgentDigest: row.user_agent_digest ? row.user_agent_digest.slice(0, 12) : null,
  };
}

function createBrowserSessionManager({
  restRequest,
  verifyToken,
  authRequest,
  encryptionKey,
  publicOrigin,
  idleTtlMs = IDLE_TTL_MS,
  now = () => new Date(),
  logger = console,
}) {
  const key = Buffer.isBuffer(encryptionKey)
    ? encryptionKey
    : Buffer.from(String(encryptionKey || ''), 'base64');
  if (key.length !== 32) throw new Error('BROWSER_SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes');
  // This is a bounded availability cache, not an identity authority. Entries
  // exist only after Supabase-backed verification and expire at the earliest of
  // access-token, idle, and absolute session expiry. They are GET-only.
  const verifiedByHandle = new Map();
  const verifiedByAccessToken = new Map();
  const authorityEventAt = new Map();

  function log(level, event, row = null, result = 'ok', reason = '') {
    const write = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : logger?.log?.bind(logger);
    if (!write) return;
    write(JSON.stringify({
      component: 'browser-session',
      event,
      result,
      sessionDigest: row?.id ? sha256(row.id).slice(0, 12) : null,
      reason: reason ? String(reason).slice(0, 160) : undefined,
    }));
  }

  function requestOriginAllowed(req) {
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    return origin === publicOrigin;
  }

  function csrfAllowed(req, row) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase())) return true;
    return requestOriginAllowed(req) && safeEqualHash(row.csrf_hash, req.headers['x-os-csrf-token']);
  }

  async function rowForHandle(handle, select = '*') {
    if (!handle) return null;
    const rows = await restRequest('browser_session', {
      query: `select=${select}&handle_hash=eq.${sha256(handle)}&limit=1`,
    });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function recordEvent(row, event, result = 'ok', metadata = {}) {
    if (!row?.id || !row?.owner_id) return false;
    try {
      await restRequest('session_event', {
        method: 'POST',
        body: [{
          session_id: row.id,
          owner_id: row.owner_id,
          event,
          result,
          metadata_digest: Object.keys(metadata).length ? sha256(JSON.stringify(metadata)) : null,
        }],
        prefer: 'return=minimal',
      });
      log(result === 'error' || result === 'rejected' ? 'warn' : 'info', event, row, result);
      return true;
    } catch (error) {
      log('error', 'audit_write_failed', row, 'error', `${event}:status-${errorStatus(error) || 'network'}`);
      return false;
    }
  }

  function expiryEvent(row, currentMs) {
    if (Date.parse(row.absolute_expires_at) <= currentMs) return 'expired_absolute';
    if (Date.parse(row.idle_expires_at) <= currentMs) return 'expired_idle';
    return '';
  }

  async function markExpired(row, event) {
    let rows = [];
    try {
      rows = await restRequest('browser_session', {
        method: 'PATCH',
        query: `id=eq.${encodeURIComponent(row.id)}&status=in.(active,pending_mfa)&select=id`,
        body: { status: 'expired', revoke_reason: null },
        prefer: 'return=representation',
      });
    } catch (error) {
      log('error', 'expiry_persist_failed', row, 'error', `status-${errorStatus(error) || 'network'}`);
      return false;
    }
    if (Array.isArray(rows) && rows[0]) {
      await recordEvent(row, event, 'ok');
      return true;
    }
    return false;
  }

  async function expire(row, event) {
    await markExpired(row, event);
    const reason = event === 'expired_absolute' ? 'absolute lifetime exceeded' : 'idle lifetime exceeded';
    throw { code: 401, msg: `browser session ${reason}` };
  }

  async function recordAuthorityUnavailable(row, source, error) {
    const key = row?.id ? `${row.id}:${source}` : '';
    if (key && now().getTime() - Number(authorityEventAt.get(key) || 0) < 60_000) return;
    if (key) authorityEventAt.set(key, now().getTime());
    log('warn', 'authority_unavailable', row, 'error', `${source}:status-${errorStatus(error) || 'network'}`);
    if (row) await recordEvent(row, 'authority_unavailable', 'error', { source });
  }

  async function persistRefreshRejection(row, reason) {
    const query = row.supabase_session_id
      ? `owner_id=eq.${encodeURIComponent(row.owner_id)}&supabase_session_id=eq.${encodeURIComponent(row.supabase_session_id)}&status=in.(active,pending_mfa)`
      : `id=eq.${encodeURIComponent(row.id)}&status=in.(active,pending_mfa)`;
    try {
      await restRequest('browser_session', {
        method: 'PATCH',
        query,
        body: {
          status: 'revoked',
          revoked_at: now().toISOString(),
          revoke_reason: String(reason || 'refresh credential rejected').slice(0, 256),
        },
        prefer: 'return=minimal',
      });
    } catch (error) {
      await recordAuthorityUnavailable(row, 'refresh-revocation', error);
      throw {
        code: 503,
        msg: 'Refresh rejection could not be persisted; browser session preserved pending authority recovery',
      };
    }
    await recordEvent(row, 'refresh_rejected', 'rejected', { reason });
  }

  async function supabase(path, options = {}) {
    const body = await authRequest(path, options);
    return body && typeof body === 'object' ? body : {};
  }

  async function rowAfterPeerRefresh(handle, previousCiphertext) {
    let latest = null;
    for (const delayMs of [0, 25, 75, 150]) {
      if (delayMs) await wait(delayMs);
      latest = await rowForHandle(handle);
      if (latest && latest.refresh_token_ciphertext !== previousCiphertext) return latest;
    }
    return latest;
  }

  async function claimsFromRow(latest) {
    const accessToken = decodeSecret(latest.access_token_ciphertext, key);
    const claims = await verifyToken(accessToken);
    return {
      row: latest,
      accessToken,
      claims,
      refreshedByPeer: true,
    };
  }

  async function refreshExpiredCredential(row, handle, current) {
    const previousCiphertext = row.refresh_token_ciphertext;
    const refreshToken = decodeSecret(previousCiphertext, key);
    let refreshed;
    try {
      refreshed = await supabase('/token', {
        method: 'POST',
        query: 'grant_type=refresh_token',
        body: { refresh_token: refreshToken },
      });
    } catch (error) {
      // A Supabase/PostgreSQL timeout or 5xx is an availability failure, not
      // proof of credential reuse. Preserve the opaque browser session and let
      // the caller retry after the authority recovers.
      if (authorityUnavailable(error)) {
        await recordAuthorityUnavailable(row, 'refresh', error);
        throw {
          code: 503,
          msg: 'Supabase session refresh temporarily unavailable; browser session preserved',
        };
      }

      // Another backend replica can rotate the same credential while this
      // request is in flight. Re-read the durable row before interpreting a
      // 400/401 as reuse; a changed ciphertext is the peer's successful result.
      if ([400, 401].includes(errorStatus(error))) {
        const latest = await rowAfterPeerRefresh(handle, previousCiphertext);
        if (latest && latest.refresh_token_ciphertext !== previousCiphertext) {
          return claimsFromRow(latest);
        }
        await persistRefreshRejection(row, 'refresh credential explicitly rejected');
        throw {
          code: 401,
          msg: 'browser session refresh credential was explicitly rejected; related session family revoked',
        };
      }
      throw error;
    }

    if (!refreshed.access_token || !refreshed.refresh_token) {
      throw {
        code: 503,
        msg: 'Supabase session refresh returned no usable credential; browser session preserved',
      };
    }

    // Persist the rotated pair before consulting live authorization state. If
    // PostgREST or role projection is temporarily unavailable afterwards, the
    // next request resumes from the new token instead of reusing the old one.
    const nextCredential = {
      access_token_ciphertext: encodeSecret(refreshed.access_token, key),
      refresh_token_ciphertext: encodeSecret(refreshed.refresh_token, key),
    };
    let storedRows;
    try {
      storedRows = await restRequest('browser_session', {
        method: 'PATCH',
        query: `id=eq.${encodeURIComponent(row.id)}&status=eq.active&refresh_token_ciphertext=eq.${encodeURIComponent(previousCiphertext)}&select=*`,
        body: nextCredential,
        prefer: 'return=representation',
      });
    } catch {
      throw {
        code: 503,
        msg: 'Supabase session rotation could not be persisted; browser session preserved',
      };
    }

    if (!Array.isArray(storedRows) || !storedRows[0]) {
      const latest = await rowAfterPeerRefresh(handle, previousCiphertext);
      if (latest && latest.refresh_token_ciphertext !== previousCiphertext) {
        return claimsFromRow(latest);
      }
      throw {
        code: 503,
        msg: 'Concurrent Supabase session rotation is still settling; browser session preserved',
      };
    }

    const stored = { ...row, ...nextCredential, ...storedRows[0] };
    const claims = await verifyToken(refreshed.access_token);
    await restRequest('browser_session', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(row.id)}&status=eq.active`,
      body: {
        supabase_session_id: claims.authSessionId || row.supabase_session_id,
        assurance: claims.assurance === 'aal2' ? 'aal2' : 'aal1',
      },
      prefer: 'return=minimal',
    });
    await recordEvent(row, 'refresh', 'ok');
    return {
      row: {
        ...stored,
        supabase_session_id: claims.authSessionId || row.supabase_session_id,
        assurance: claims.assurance === 'aal2' ? 'aal2' : 'aal1',
      },
      accessToken: refreshed.access_token,
      claims,
      refreshedByPeer: false,
    };
  }

  async function factors(accessToken) {
    const user = await supabase('/user', { token: accessToken });
    return {
      user,
      verifiedTotp: (Array.isArray(user.factors) ? user.factors : [])
        .find((factor) => factor.factor_type === 'totp' && factor.status === 'verified'),
    };
  }

  async function create(req, credentials) {
    const persistence = duration(credentials.duration);
    const session = await supabase('/token', {
      method: 'POST',
      query: 'grant_type=password',
      body: { email: String(credentials.email || '').trim(), password: String(credentials.password || '') },
    });
    if (!session.access_token || !session.refresh_token) throw { code: 502, msg: 'Supabase Auth returned no usable session' };
    const verified = await verifyToken(session.access_token);
    const factorState = verified.assurance === 'aal2'
      ? { user: session.user || {}, verifiedTotp: null }
      : await factors(session.access_token);
    const handle = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const current = now();
    const absolute = new Date(current.getTime() + DURATION_MS[persistence]);
    const mfaRequired = Boolean(factorState.verifiedTotp?.id);
    const status = mfaRequired ? 'pending_mfa' : 'active';
    const idle = new Date(Math.min(
      current.getTime() + (mfaRequired ? PENDING_TTL_MS : idleTtlMs),
      absolute.getTime(),
    ));
    const rows = await restRequest('browser_session', {
      method: 'POST',
      query: 'select=id,owner_id,status,assurance,persistence,created_at,last_seen_at,idle_expires_at,absolute_expires_at,user_agent_digest',
      body: [{
        owner_id: verified.sub,
        handle_hash: sha256(handle),
        csrf_hash: sha256(csrfToken),
        access_token_ciphertext: encodeSecret(session.access_token, key),
        refresh_token_ciphertext: encodeSecret(session.refresh_token, key),
        supabase_session_id: verified.authSessionId || null,
        assurance: verified.assurance === 'aal2' ? 'aal2' : 'aal1',
        persistence,
        status,
        credential_revision: Number(verified.credentialRevision || 0),
        user_agent_digest: req.headers['user-agent'] ? sha256(req.headers['user-agent']) : null,
        network_digest: clientNetworkDigest(req),
        activated_at: status === 'active' ? current.toISOString() : null,
        last_reauthenticated_at: verified.assurance === 'aal2' ? current.toISOString() : null,
        idle_expires_at: idle.toISOString(),
        absolute_expires_at: absolute.toISOString(),
      }],
      prefer: 'return=representation',
    });
    const row = rows[0];
    await recordEvent(row, 'login', status === 'active' ? 'ok' : 'pending', {
      persistence,
      assurance: row.assurance,
    });
    return {
      cookies: cookies(handle, persistence, csrfToken),
      csrfToken,
      mfaRequired,
      mfaEnrollmentRequired: !mfaRequired && verified.assurance !== 'aal2',
      factorId: mfaRequired ? factorState.verifiedTotp.id : null,
      session: publicSession(row, row.id),
    };
  }

  async function adoptLegacy(req, legacy) {
    if (!requestOriginAllowed(req)) throw { code: 403, msg: 'legacy session adoption origin rejected' };
    const refreshToken = String(legacy?.refreshToken || '');
    if (!refreshToken) throw { code: 400, msg: 'legacy refresh credential is required' };
    // Rotate before custody transfer so the browser-held refresh credential is
    // invalid as soon as the server-managed session is established.
    const session = await supabase('/token', {
      method: 'POST',
      query: 'grant_type=refresh_token',
      body: { refresh_token: refreshToken },
    });
    if (!session.access_token || !session.refresh_token) throw { code: 401, msg: 'legacy session could not be rotated' };
    const verified = await verifyToken(session.access_token);
    const factorState = verified.assurance === 'aal2'
      ? { verifiedTotp: null }
      : await factors(session.access_token);
    const handle = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const current = now();
    const absolute = new Date(current.getTime() + DURATION_MS.browser);
    const mfaRequired = Boolean(factorState.verifiedTotp?.id);
    const status = mfaRequired ? 'pending_mfa' : 'active';
    const idle = new Date(Math.min(
      current.getTime() + (mfaRequired ? PENDING_TTL_MS : idleTtlMs),
      absolute.getTime(),
    ));
    const rows = await restRequest('browser_session', {
      method: 'POST',
      query: 'select=id,owner_id,status,assurance,persistence,created_at,last_seen_at,idle_expires_at,absolute_expires_at,user_agent_digest',
      body: [{
        owner_id: verified.sub,
        handle_hash: sha256(handle),
        csrf_hash: sha256(csrfToken),
        access_token_ciphertext: encodeSecret(session.access_token, key),
        refresh_token_ciphertext: encodeSecret(session.refresh_token, key),
        supabase_session_id: verified.authSessionId || null,
        assurance: verified.assurance === 'aal2' ? 'aal2' : 'aal1',
        persistence: 'browser',
        status,
        credential_revision: Number(verified.credentialRevision || 0),
        user_agent_digest: req.headers['user-agent'] ? sha256(req.headers['user-agent']) : null,
        network_digest: clientNetworkDigest(req),
        activated_at: status === 'active' ? current.toISOString() : null,
        last_reauthenticated_at: verified.assurance === 'aal2' ? current.toISOString() : null,
        idle_expires_at: idle.toISOString(),
        absolute_expires_at: absolute.toISOString(),
      }],
      prefer: 'return=representation',
    });
    const row = rows[0];
    await recordEvent(row, 'login', status === 'active' ? 'ok' : 'pending', {
      persistence: 'browser',
      migratedFrom: 'legacy-session-storage',
    });
    return {
      cookies: cookies(handle, 'browser', csrfToken),
      csrfToken,
      mfaRequired,
      session: publicSession(row, row.id),
    };
  }

  async function authenticate(req, options = {}) {
    const handle = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const handleHash = sha256(handle);
    let row;
    try {
      row = await rowForHandle(handle);
    } catch (error) {
      const cached = verifiedByHandle.get(handleHash);
      const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase());
      if (authorityUnavailable(error)) await recordAuthorityUnavailable(cached?.auth?.row || null, 'session-ledger', error);
      if (!readOnly || !cached || cached.validUntil <= now().getTime()) throw error;
      return { ...cached.auth, authorityDegraded: true };
    }
    if (!row || row.status !== 'active') throw { code: 401, msg: 'browser session is not active' };
    const current = now();
    const expiredBy = expiryEvent(row, current.getTime());
    if (expiredBy) return expire(row, expiredBy);
    if (options.requireCsrf !== false && !csrfAllowed(req, row)) throw { code: 403, msg: 'browser session CSRF validation failed' };

    let accessToken = decodeSecret(row.access_token_ciphertext, key);
    let claims;
    try {
      claims = await verifyToken(accessToken);
    } catch (error) {
      const cached = verifiedByHandle.get(handleHash);
      const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase());
      if (authorityUnavailable(error)) {
        await recordAuthorityUnavailable(row, 'token-verification', error);
        if (readOnly && cached && cached.validUntil > current.getTime()) {
          return { ...cached.auth, authorityDegraded: true };
        }
        throw error;
      }
      // Refresh only a cryptographically valid token whose exp has elapsed.
      // Inactive operators, credential-revision revocation, bad signatures and
      // authorization outages must never be converted into refresh attempts.
      if (!tokenActuallyExpired(error, accessToken, current.getTime())) throw error;
      const rotated = await refreshExpiredCredential(row, handle, current);
      row = rotated.row;
      accessToken = rotated.accessToken;
      claims = rotated.claims;
    }

    const result = {
      actor: {
        ...claims,
        browserSessionId: row.id,
        authSessionId: row.supabase_session_id || claims.authSessionId || row.id,
        lastReauthenticatedAt: row.last_reauthenticated_at,
        provider: 'supabase-browser-session',
        credentialRevision: Number(row.credential_revision || 0),
      },
      row,
      accessToken,
    };
    const tokenExpiresAt = jwtExpiry(accessToken) || Date.parse(result.row.absolute_expires_at);
    const validUntil = Math.min(
      tokenExpiresAt,
      Date.parse(result.row.idle_expires_at),
      Date.parse(result.row.absolute_expires_at),
    );
    if (Number.isFinite(validUntil) && validUntil > current.getTime()) {
      const cached = { validUntil, auth: result };
      verifiedByHandle.set(handleHash, cached);
      verifiedByAccessToken.set(sha256(accessToken), cached);
    }
    return result;
  }

  /**
   * Durable workers re-open the server-owned session at execution time. No
   * browser bearer is persisted in the operation row and no degraded cache is
   * accepted for mutation.
   */
  async function resolveForDurableExecution(sessionId, expectedActorId) {
    const id = String(sessionId || '');
    const actorId = String(expectedActorId || '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(actorId)) return { active: false, code: 'InvalidSessionIdentity' };
    const rows = await restRequest('browser_session', {
      query: `select=*&id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(actorId)}&limit=1`,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.status !== 'active' || expiryEvent(row, now().getTime())) return { active: false, actorId, code: 'SessionInactive' };
    let accessToken;
    try { accessToken = decodeSecret(row.access_token_ciphertext, key); }
    catch { return { active: false, actorId, code: 'SessionCredentialUnreadable' }; }
    let claims;
    try { claims = await verifyToken(accessToken); }
    catch (error) {
      if (authorityUnavailable(error)) return { active: false, actorId, code: 'AuthorizationAuthorityUnavailable' };
      return { active: false, actorId, code: 'SessionCredentialInvalid' };
    }
    if (String(claims.sub || '') !== actorId) return { active: false, actorId, code: 'SessionActorChanged' };
    let operator;
    try {
      const operators = await restRequest('operator', {
        query: `select=user_id,status,disabled_at,credential_revision&user_id=eq.${encodeURIComponent(actorId)}&limit=1`,
      });
      operator = Array.isArray(operators) ? operators[0] : null;
    } catch {
      return { active: false, actorId, code: 'OperatorAuthorityUnavailable' };
    }
    if (!operator || operator.status !== 'active' || operator.disabled_at) {
      return { active: false, actorId, code: 'OperatorInactive' };
    }
    return {
      active: true, actorId, assurance: String(claims.assurance || row.assurance || 'aal1'),
      permissions: Array.isArray(claims.permissions) ? claims.permissions : [],
      authzRevision: String(operator.credential_revision ?? row.credential_revision ?? 0), accessToken,
      lastReauthenticatedAt: row.last_reauthenticated_at || null,
    };
  }

  /**
   * Rejoin a bearer forwarded by an approved owner service with the durable
   * browser-session assurance record.  A Supabase access token proves AAL2,
   * but it does not carry the exact time of the most recent factor challenge.
   * Only the active ledger row that owns the same subject/session and stores
   * the exact encrypted token may supply last_reauthenticated_at.
   */
  async function actorForForwardedAccessToken(accessToken, verifiedActor) {
    const token = String(accessToken || '');
    const subject = String(verifiedActor?.sub || '');
    const authSessionId = String(verifiedActor?.authSessionId || '');
    if (!token || !subject || !authSessionId) return null;

    const rows = await restRequest('browser_session', {
      query: `select=*&owner_id=eq.${encodeURIComponent(subject)}&supabase_session_id=eq.${encodeURIComponent(authSessionId)}&status=eq.active&order=last_seen_at.desc&limit=5`,
    });
    const current = now().getTime();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || row.status !== 'active' || expiryEvent(row, current)) continue;
      let storedToken = '';
      try { storedToken = decodeSecret(row.access_token_ciphertext, key); }
      catch { continue; }
      if (!safeEqualHash(sha256(storedToken), token)) continue;
      if (String(row.assurance || 'aal1') !== String(verifiedActor.assurance || 'aal1')) continue;
      return {
        ...verifiedActor,
        browserSessionId: row.id,
        authSessionId: row.supabase_session_id || verifiedActor.authSessionId,
        lastReauthenticatedAt: row.last_reauthenticated_at || null,
        provider: 'supabase-browser-owner-delegation',
        credentialRevision: Number(row.credential_revision || verifiedActor.credentialRevision || 0),
      };
    }
    return null;
  }

  async function touch(req) {
    const auth = await authenticate(req);
    const current = now();
    if (current.getTime() - Date.parse(auth.row.last_seen_at) < 60_000) {
      return { auth, session: publicSession(auth.row, auth.row.id) };
    }
    const idle = new Date(Math.min(
      current.getTime() + idleTtlMs,
      Date.parse(auth.row.absolute_expires_at),
    ));
    const rows = await restRequest('browser_session', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(auth.row.id)}&status=eq.active&select=id,last_seen_at,idle_expires_at`,
      body: { last_seen_at: current.toISOString(), idle_expires_at: idle.toISOString() },
      prefer: 'return=representation',
    });
    if (!Array.isArray(rows) || !rows[0]) throw { code: 401, msg: 'browser session is not active' };
    const updated = { ...auth.row, ...rows[0] };
    return { auth: { ...auth, row: updated }, session: publicSession(updated, updated.id) };
  }

  async function completeMfa(req, code) {
    const handle = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const row = await rowForHandle(handle);
    if (!row || row.status !== 'pending_mfa') throw { code: 401, msg: 'pending MFA session not found' };
    if (!csrfAllowed(req, row)) throw { code: 403, msg: 'browser session CSRF validation failed' };
    if (Date.parse(row.idle_expires_at) <= now().getTime()) return expire(row, 'expired_idle');
    if (!/^\d{6}$/.test(String(code || '').trim())) throw { code: 400, msg: 'current 6-digit authentication code is required' };
    const accessToken = decodeSecret(row.access_token_ciphertext, key);
    const factorState = await factors(accessToken);
    if (!factorState.verifiedTotp?.id) throw { code: 409, msg: 'verified TOTP factor not found' };
    const challenge = await supabase(`/factors/${encodeURIComponent(factorState.verifiedTotp.id)}/challenge`, {
      method: 'POST', token: accessToken, body: {},
    });
    if (!challenge.id) throw { code: 502, msg: 'Supabase MFA challenge creation failed' };
    const verified = await supabase(`/factors/${encodeURIComponent(factorState.verifiedTotp.id)}/verify`, {
      method: 'POST',
      token: accessToken,
      body: { challenge_id: challenge.id, code: String(code).trim() },
    });
    const session = verified.session || verified;
    if (!session.access_token || !session.refresh_token) throw { code: 502, msg: 'Supabase MFA returned no session' };
    const claims = await verifyToken(session.access_token);
    if (claims.assurance !== 'aal2') throw { code: 502, msg: 'Supabase MFA did not produce aal2 assurance' };
    const current = now();
    const idle = new Date(Math.min(current.getTime() + idleTtlMs, Date.parse(row.absolute_expires_at)));
    await restRequest('browser_session', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(row.id)}&status=eq.pending_mfa`,
      body: {
        access_token_ciphertext: encodeSecret(session.access_token, key),
        refresh_token_ciphertext: encodeSecret(session.refresh_token, key),
        supabase_session_id: claims.authSessionId || row.supabase_session_id,
        assurance: 'aal2',
        status: 'active',
        activated_at: current.toISOString(),
        last_reauthenticated_at: current.toISOString(),
        last_seen_at: current.toISOString(),
        idle_expires_at: idle.toISOString(),
      },
      prefer: 'return=minimal',
    });
    await recordEvent(row, 'step_up', 'ok', { assurance: 'aal2' });
    return { assurance: 'aal2', sessionId: row.id };
  }

  async function list(req) {
    const auth = await authenticate(req, { requireCsrf: false });
    if (auth.authorityDegraded) {
      return { auth, items: [publicSession(auth.row, auth.row.id)] };
    }
    const rows = await restRequest('browser_session', {
      query: `select=id,owner_id,status,assurance,persistence,created_at,last_seen_at,idle_expires_at,absolute_expires_at,user_agent_digest&owner_id=eq.${encodeURIComponent(auth.actor.sub)}&status=in.(active,pending_mfa)&order=last_seen_at.desc`,
    });
    const currentMs = now().getTime();
    const liveRows = [];
    for (const row of rows) {
      const expiredBy = expiryEvent(row, currentMs);
      if (expiredBy) {
        await markExpired(row, expiredBy);
        continue;
      }
      liveRows.push(row);
    }
    return { auth, items: liveRows.map((row) => publicSession(row, auth.row.id)) };
  }

  async function revoke(req, id, reason = 'user logout') {
    const auth = await authenticate(req);
    const targetId = id || auth.row.id;
    const rows = await restRequest('browser_session', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(targetId)}&owner_id=eq.${encodeURIComponent(auth.actor.sub)}&status=in.(active,pending_mfa)&select=id`,
      body: {
        status: 'revoked',
        revoked_at: now().toISOString(),
        revoke_reason: String(reason || 'user logout').trim().slice(0, 256),
      },
      prefer: 'return=representation',
    });
    if (!rows[0]) throw { code: 404, msg: 'browser session not found' };
    await recordEvent({ ...rows[0], owner_id: auth.actor.sub }, 'revoke', 'ok', {
      current: targetId === auth.row.id,
    });
    return { auth, current: targetId === auth.row.id };
  }

  async function revokeAll(req) {
    const auth = await authenticate(req);
    await restRequest('browser_session', {
      method: 'PATCH',
      query: `owner_id=eq.${encodeURIComponent(auth.actor.sub)}&status=in.(active,pending_mfa)`,
      body: { status: 'revoked', revoked_at: now().toISOString(), revoke_reason: 'user revoked all sessions' },
      prefer: 'return=minimal',
    });
    await recordEvent(auth.row, 'revoke_all', 'ok');
    return auth;
  }

  async function factorAccess(req) {
    return authenticate(req);
  }

  async function beginTotp(req, friendlyName) {
    const auth = await authenticate(req);
    const factorState = await factors(auth.accessToken);
    const all = Array.isArray(factorState.user?.factors) ? factorState.user.factors : [];
    if (all.some((factor) => factor.factor_type === 'totp' && factor.status === 'verified')) {
      throw { code: 409, msg: 'a verified TOTP factor is already registered' };
    }
    for (const factor of all.filter((item) => item.factor_type === 'totp' && item.status === 'unverified')) {
      await supabase(`/factors/${encodeURIComponent(factor.id)}`, {
        method: 'DELETE',
        token: auth.accessToken,
      });
    }
    const enrollment = await supabase('/factors', {
      method: 'POST',
      token: auth.accessToken,
      body: {
        factor_type: 'totp',
        friendly_name: String(friendlyName || 'OpenSphere Console').trim().slice(0, 64),
      },
    });
    if (!enrollment.id || !enrollment.totp?.secret) throw { code: 502, msg: 'Supabase Auth returned no TOTP enrollment' };
    return {
      factorId: enrollment.id,
      qrCode: enrollment.totp.qr_code || '',
      secret: enrollment.totp.secret,
      uri: enrollment.totp.uri || '',
    };
  }

  async function verifyTotp(req, factorId, code) {
    const auth = await authenticate(req);
    if (!factorId) throw { code: 400, msg: 'TOTP factor id is required' };
    if (!/^\d{6}$/.test(String(code || '').trim())) throw { code: 400, msg: 'current 6-digit authentication code is required' };
    const challenge = await supabase(`/factors/${encodeURIComponent(factorId)}/challenge`, {
      method: 'POST',
      token: auth.accessToken,
      body: {},
    });
    if (!challenge.id) throw { code: 502, msg: 'Supabase MFA challenge creation failed' };
    const verified = await supabase(`/factors/${encodeURIComponent(factorId)}/verify`, {
      method: 'POST',
      token: auth.accessToken,
      body: { challenge_id: challenge.id, code: String(code).trim() },
    });
    const session = verified.session || verified;
    if (!session.access_token || !session.refresh_token) throw { code: 502, msg: 'Supabase MFA returned no session' };
    const claims = await verifyToken(session.access_token);
    if (claims.assurance !== 'aal2') throw { code: 502, msg: 'Supabase MFA did not produce aal2 assurance' };
    const current = now();
    await restRequest('browser_session', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(auth.row.id)}&status=eq.active`,
      body: {
        access_token_ciphertext: encodeSecret(session.access_token, key),
        refresh_token_ciphertext: encodeSecret(session.refresh_token, key),
        supabase_session_id: claims.authSessionId || auth.row.supabase_session_id,
        assurance: 'aal2',
        last_reauthenticated_at: current.toISOString(),
      },
      prefer: 'return=minimal',
    });
    await recordEvent(auth.row, 'step_up', 'ok', { assurance: 'aal2', enrollment: true });
    return { assurance: 'aal2' };
  }

  async function stepUp(req, code) {
    const auth = await authenticate(req);
    if (!/^\d{6}$/.test(String(code || '').trim())) throw { code: 400, msg: 'current 6-digit authentication code is required' };
    const factorState = await factors(auth.accessToken);
    if (!factorState.verifiedTotp?.id) throw { code: 409, msg: 'verified TOTP factor not found' };
    const challenge = await supabase(`/factors/${encodeURIComponent(factorState.verifiedTotp.id)}/challenge`, {
      method: 'POST',
      token: auth.accessToken,
      body: {},
    });
    if (!challenge.id) throw { code: 502, msg: 'Supabase MFA challenge creation failed' };
    const verified = await supabase(`/factors/${encodeURIComponent(factorState.verifiedTotp.id)}/verify`, {
      method: 'POST',
      token: auth.accessToken,
      body: { challenge_id: challenge.id, code: String(code).trim() },
    });
    const session = verified.session || verified;
    if (!session.access_token || !session.refresh_token) throw { code: 502, msg: 'Supabase MFA returned no session' };
    const claims = await verifyToken(session.access_token);
    if (claims.assurance !== 'aal2') throw { code: 502, msg: 'Supabase MFA did not produce aal2 assurance' };
    const current = now();
    await restRequest('browser_session', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(auth.row.id)}&status=eq.active`,
      body: {
        access_token_ciphertext: encodeSecret(session.access_token, key),
        refresh_token_ciphertext: encodeSecret(session.refresh_token, key),
        supabase_session_id: claims.authSessionId || auth.row.supabase_session_id,
        assurance: 'aal2',
        last_reauthenticated_at: current.toISOString(),
      },
      prefer: 'return=minimal',
    });
    await recordEvent(auth.row, 'step_up', 'ok', { assurance: 'aal2', enrollment: false });
    return { assurance: 'aal2', reauthenticatedAt: current.toISOString() };
  }

  async function events(req, limit = 50) {
    const auth = await authenticate(req, { requireCsrf: false });
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const rows = await restRequest('session_event', {
      query: `select=id,session_id,event,result,occurred_at&owner_id=eq.${encodeURIComponent(auth.actor.sub)}&order=occurred_at.desc&limit=${safeLimit}`,
    });
    return { auth, items: Array.isArray(rows) ? rows : [] };
  }

  return {
    create,
    adoptLegacy,
    authenticate,
    resolveForDurableExecution,
    touch,
    completeMfa,
    list,
    revoke,
    revokeAll,
    factorAccess,
    beginTotp,
    verifyTotp,
    stepUp,
    events,
    actorForForwardedAccessToken,
    cachedActorForAccessToken(accessToken) {
      const cached = verifiedByAccessToken.get(sha256(accessToken));
      if (!cached || cached.validUntil <= now().getTime()) return null;
      return { ...cached.auth.actor, authorityDegraded: true };
    },
    clearCookies,
    cookieName: COOKIE_NAME,
  };
}

module.exports = {
  COOKIE_NAME,
  createBrowserSessionManager,
  parseCookies,
  sha256,
};
