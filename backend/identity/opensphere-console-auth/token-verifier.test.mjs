import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { isActivePat, verifyEs256Jwt } from './token-verifier.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ISSUER = 'https://issuer.example/oauth2/openid/opensphere-console';
const AUDIENCE = 'opensphere-console';
const KID = 'test-kid';
const NOW = 1_800_000_000;

function sign(overrides = {}, headerOverrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT', ...headerOverrides })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    sub: 'user-1',
    aud: AUDIENCE,
    azp: AUDIENCE,
    preferred_username: 'mars',
    groups: ['opensphere-console-admins'],
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 300,
    ...overrides,
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const signature = crypto.sign('SHA256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${signature.toString('base64url')}`;
}

const verify = (jwt) => verifyEs256Jwt(jwt, {
  key: publicKey,
  issuer: ISSUER,
  audience: AUDIENCE,
  expectedKid: KID,
  nowSeconds: NOW,
});

test('valid ES256 administrative token is accepted', () => assert.equal(verify(sign())?.sub, 'user-1'));
test('alg confusion is rejected', () => assert.equal(verify(sign({}, { alg: 'none' })), null));
test('unexpected kid is rejected', () => assert.equal(verify(sign({}, { kid: 'other' })), null));
test('issuer mismatch is rejected', () => assert.equal(verify(sign({ iss: 'https://other.example' })), null));
test('audience mismatch is rejected', () => assert.equal(verify(sign({ aud: 'other' })), null));
test('authorized-party mismatch is rejected', () => assert.equal(verify(sign({ azp: 'other' })), null));
test('expired token is rejected', () => assert.equal(verify(sign({ exp: NOW - 31 })), null));
test('future nbf is rejected', () => assert.equal(verify(sign({ nbf: NOW + 31 })), null));
test('future iat is rejected', () => assert.equal(verify(sign({ iat: NOW + 31 })), null));
test('missing temporal claim is rejected', () => assert.equal(verify(sign({ nbf: undefined })), null));

test('PAT requires an active matching server-side record', () => {
  const payload = { typ: 'pat', jti: 'jti-1', preferred_username: 'mars', exp: NOW + 300 };
  const records = { 'jti-1': JSON.stringify({ user: 'mars', exp: NOW + 300 }) };
  assert.equal(isActivePat(payload, records, NOW), true);
  assert.equal(isActivePat(payload, {}, NOW), false);
  assert.equal(isActivePat(payload, { 'jti-1': JSON.stringify({ user: 'other', exp: NOW + 300 }) }, NOW), false);
  assert.equal(isActivePat(payload, { 'jti-1': JSON.stringify({ user: 'mars', exp: NOW - 1 }) }, NOW), false);
});
