import crypto from 'node:crypto';

const isBase64Url = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

export function validateDevicePublicJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return false;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.d !== undefined) return false;
  if (!isBase64Url(jwk.x) || !isBase64Url(jwk.y)) return false;
  try {
    if (Buffer.from(jwk.x, 'base64url').length !== 32 || Buffer.from(jwk.y, 'base64url').length !== 32) return false;
    crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

export function deviceFingerprint(jwk) {
  if (!validateDevicePublicJwk(jwk)) throw new Error('invalid device public key');
  const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical).digest('hex').match(/.{1,2}/g).join(':');
}

export function cliChallengeMessage(deviceId, challengeId, nonce) {
  return `opensphere-cli-session-v1\n${deviceId}\n${challengeId}\n${nonce}`;
}

export function verifyDeviceChallenge(jwk, deviceId, challengeId, nonce, signature) {
  if (!validateDevicePublicJwk(jwk) || !isBase64Url(signature)) return false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return crypto.verify(
      'SHA256',
      Buffer.from(cliChallengeMessage(deviceId, challengeId, nonce)),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function safeEqualToken(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
