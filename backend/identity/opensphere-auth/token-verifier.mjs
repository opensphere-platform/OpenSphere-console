import crypto from 'node:crypto';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function audienceIncludes(actual, expected) {
  if (typeof actual === 'string') return actual === expected;
  return Array.isArray(actual) && actual.includes(expected);
}

/**
 * Verify an ES256 JWT and its OpenID security claims. This function is deliberately
 * fail-closed: every token accepted by an administrative path must carry the same
 * issuer, audience, authorized party and temporal contract.
 */
export function verifyEs256Jwt(jwt, options) {
  try {
    const {
      key,
      issuer,
      audience,
      expectedKid,
      nowSeconds = Math.floor(Date.now() / 1000),
      clockSkewSeconds = 30,
    } = options;
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    if (header.alg !== 'ES256') return null;
    if (header.typ !== undefined && header.typ !== 'JWT') return null;
    if (expectedKid !== undefined && header.kid !== expectedKid) return null;

    const verified = crypto.verify(
      'SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(encodedSignature, 'base64url'),
    );
    if (!verified) return null;

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.iss !== issuer || !audienceIncludes(payload.aud, audience) || payload.azp !== audience) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (!isFiniteNumber(payload.exp) || !isFiniteNumber(payload.nbf) || !isFiniteNumber(payload.iat)) return null;
    if (payload.exp < nowSeconds - clockSkewSeconds) return null;
    if (payload.nbf > nowSeconds + clockSkewSeconds) return null;
    if (payload.iat > nowSeconds + clockSkewSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

/** A PAT is active only while its signed claims and the revocable server-side record agree. */
export function isActivePat(payload, records, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!payload || payload.typ !== 'pat' || typeof payload.jti !== 'string' || !payload.jti) return false;
  const raw = records && records[payload.jti];
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const record = JSON.parse(raw);
    if (record.user !== payload.preferred_username) return false;
    if (!isFiniteNumber(record.exp) || record.exp !== payload.exp || record.exp < nowSeconds) return false;
    return true;
  } catch {
    return false;
  }
}
