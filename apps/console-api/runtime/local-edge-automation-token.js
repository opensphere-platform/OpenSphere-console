'use strict';

function canonicalSegment(value) {
  const segment = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw Object.assign(new Error('local edge automation token segment is not canonical'), { code: 401 });
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw Object.assign(new Error('local edge automation token segment is not canonical'), { code: 401 });
  return decoded;
}

function validateLocalEdgeAutomationTokenClaims(token, { username, audience, now = Math.floor(Date.now() / 1000) } = {}) {
  if (Buffer.byteLength(String(token || '')) > 16 * 1024) throw Object.assign(new Error('local edge automation token is oversized'), { code: 401 });
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw Object.assign(new Error('local edge automation token is malformed'), { code: 401 });
  let claims;
  try {
    canonicalSegment(parts[0]); claims = JSON.parse(canonicalSegment(parts[1]).toString('utf8')); canonicalSegment(parts[2]);
  } catch (error) {
    if (error?.code === 401) throw error;
    throw Object.assign(new Error('local edge automation token claims are malformed'), { code: 401 });
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const issuedAt = Number(claims.iat); const notBefore = Number(claims.nbf ?? claims.iat); const expiresAt = Number(claims.exp);
  if (!username || !audience || claims.sub !== username || audiences.length !== 1 || audiences[0] !== audience
    || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(notBefore) || !Number.isSafeInteger(expiresAt)
    || expiresAt <= now || issuedAt > now + 30 || notBefore > now + 30 || expiresAt <= issuedAt || expiresAt - issuedAt > 600
    || claims['kubernetes.io']?.namespace !== 'opensphere-console'
    || claims['kubernetes.io']?.serviceaccount?.name !== 'opensphere-local-edge-release') {
    throw Object.assign(new Error('local edge automation token lifetime or projected identity is invalid'), { code: 403 });
  }
  return Object.freeze({ issuedAt, expiresAt, audience, subject: username });
}

module.exports = { validateLocalEdgeAutomationTokenClaims };
