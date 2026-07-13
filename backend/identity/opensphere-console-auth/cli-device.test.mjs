import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { cliChallengeMessage, deviceFingerprint, safeEqualToken, validateDevicePublicJwk, verifyDeviceChallenge } from './cli-device.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });

test('P-256 public JWK is accepted while private or malformed keys are rejected', () => {
  assert.equal(validateDevicePublicJwk(jwk), true);
  assert.equal(validateDevicePublicJwk({ ...jwk, d: 'private' }), false);
  assert.equal(validateDevicePublicJwk({ ...jwk, crv: 'P-384' }), false);
  assert.equal(validateDevicePublicJwk({ ...jwk, x: 'bad' }), false);
});

test('device fingerprint is stable and colon-delimited', () => {
  assert.match(deviceFingerprint(jwk), /^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/);
  assert.equal(deviceFingerprint(jwk), deviceFingerprint({ y: jwk.y, x: jwk.x, crv: jwk.crv, kty: jwk.kty }));
});

test('challenge signature is bound to device, challenge and nonce', () => {
  const message = cliChallengeMessage('device-1', 'challenge-1', 'nonce-1');
  const signature = crypto.sign('SHA256', Buffer.from(message), privateKey).toString('base64url');
  assert.equal(verifyDeviceChallenge(jwk, 'device-1', 'challenge-1', 'nonce-1', signature), true);
  assert.equal(verifyDeviceChallenge(jwk, 'device-2', 'challenge-1', 'nonce-1', signature), false);
  assert.equal(verifyDeviceChallenge(jwk, 'device-1', 'challenge-1', 'nonce-2', signature), false);
});

test('poll token comparison is constant-time for equal-sized values', () => {
  assert.equal(safeEqualToken('same', 'same'), true);
  assert.equal(safeEqualToken('same', 'diff'), false);
  assert.equal(safeEqualToken('short', 'longer'), false);
});
