'use strict';

const { createHmac, timingSafeEqual } = require('crypto');

function b64urlJson(value, label) {
  try { return JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { throw { code: 401, msg: `invalid ${label}` }; }
}

function verifyHs256Jwt(token, options) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw { code: 401, msg: 'malformed token' };
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = b64urlJson(encodedHeader, 'JWT header');
  const claims = b64urlJson(encodedPayload, 'JWT claims');
  if (header.alg !== 'HS256') throw { code: 401, msg: 'unexpected Supabase JWT alg' };
  const expected = createHmac('sha256', options.jwtSecret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const actual = Buffer.from(encodedSignature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw { code: 401, msg: 'bad signature' };
  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub) throw { code: 401, msg: 'missing sub' };
  if (!claims.iat || claims.iat > now + 30) throw { code: 401, msg: 'invalid iat' };
  if (!claims.exp || claims.exp <= now) throw { code: 401, msg: 'token expired' };
  if (claims.nbf && claims.nbf > now + 30) throw { code: 401, msg: 'token not yet valid' };
  if (claims.iss !== options.issuer) throw { code: 401, msg: 'bad iss' };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(options.audience)) throw { code: 401, msg: 'bad aud' };
  if (claims.role !== 'authenticated') throw { code: 401, msg: 'unexpected role' };
  return claims;
}

async function restRows(options, resource, query) {
  const response = await options.fetch(`${options.restUrl}/${resource}?${query}`, {
    headers: { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey, accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) throw { code: 503, msg: `Supabase authorization state unavailable (${resource} HTTP ${response.status})` };
  const rows = await response.json();
  if (!Array.isArray(rows)) throw { code: 503, msg: `invalid Supabase authorization response (${resource})` };
  return rows;
}

function createSupabaseVerifier(config = {}) {
  const options = {
    issuer: config.issuer || process.env.SUPABASE_AUTH_ISSUER,
    audience: config.audience || process.env.SUPABASE_AUTH_AUDIENCE || 'authenticated',
    jwtSecret: config.jwtSecret || process.env.SUPABASE_JWT_SECRET,
    restUrl: (config.restUrl || process.env.SUPABASE_REST_URL || '').replace(/\/$/, ''),
    serviceRoleKey: config.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY,
    timeoutMs: Number(config.timeoutMs || process.env.SUPABASE_AUTHZ_TIMEOUT_MS || 3000),
    fetch: config.fetch || globalThis.fetch,
  };
  for (const key of ['issuer', 'jwtSecret', 'restUrl', 'serviceRoleKey']) {
    if (!options[key]) throw new Error(`Supabase auth configuration missing: ${key}`);
  }
  return async function verifySupabaseToken(token) {
    const claims = verifyHs256Jwt(token, options);
    const subject = encodeURIComponent(claims.sub);
    let operatorRows;
    let roleRows;
    try {
      [operatorRows, roleRows] = await Promise.all([
        restRows(options, 'operator', `user_id=eq.${subject}&select=status,credential_revision`),
        restRows(options, 'operator_role', `user_id=eq.${subject}&select=expires_at,role(code)`),
      ]);
    } catch (error) {
      if (error?.code) throw error;
      throw { code: 503, msg: `Supabase authorization state unavailable: ${error.message}` };
    }
    const operator = operatorRows[0];
    if (!operator || operator.status !== 'active') throw { code: 401, msg: 'operator inactive or unknown' };
    if (claims.credential_revision !== undefined && Number(claims.credential_revision) !== Number(operator.credential_revision)) {
      throw { code: 401, msg: 'credential revision revoked' };
    }
    const now = Date.now();
    const groups = roleRows.filter((entry) => !entry.expires_at || Date.parse(entry.expires_at) > now).map((entry) => entry.role?.code).filter(Boolean);
    return { sub: claims.sub, username: claims.email || claims.user_metadata?.preferred_username || claims.sub, groups, assurance: claims.aal || 'aal1', authSessionId: claims.session_id || null, provider: 'supabase' };
  };
}

module.exports = { createSupabaseVerifier, verifyHs256Jwt };
