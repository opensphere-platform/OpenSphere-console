'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateLocalEdgeAutomationTokenClaims } = require('./local-edge-automation-token');

test('Backend image contains the local-edge token verifier required by server startup', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /COPY backend\/opensphere-console-backend\/local-edge-automation-token\.js \.\/local-edge-automation-token\.js/,
  );
});

const username = 'system:serviceaccount:opensphere-console:opensphere-local-edge-release';
const audience = 'opensphere-local-edge-release';
function token(overrides = {}, noncanonical = false) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ sub: username, aud: [audience], iat: 1000, nbf: 1000, exp: 1600,
    'kubernetes.io': { namespace: 'opensphere-console', serviceaccount: { name: 'opensphere-local-edge-release', uid: 'uid-1' } }, ...overrides });
  const signature = Buffer.alloc(64, 7).toString('base64url');
  return `${header}.${payload}.${noncanonical ? `${signature}=` : signature}`;
}

test('projected local-edge token is exact-identity, canonical, current and at most ten minutes', () => {
  assert.equal(validateLocalEdgeAutomationTokenClaims(token(), { username, audience, now: 1100 }).expiresAt, 1600);
  assert.throws(() => validateLocalEdgeAutomationTokenClaims(token({ exp: 1601 }), { username, audience, now: 1100 }), /lifetime/);
  assert.throws(() => validateLocalEdgeAutomationTokenClaims(token({ iat: 1200 }), { username, audience, now: 1100 }), /lifetime/);
  assert.throws(() => validateLocalEdgeAutomationTokenClaims(token({ nbf: 1200 }), { username, audience, now: 1100 }), /lifetime/);
  assert.throws(() => validateLocalEdgeAutomationTokenClaims(token({ exp: 1099 }), { username, audience, now: 1100 }), /lifetime/);
  assert.throws(() => validateLocalEdgeAutomationTokenClaims(token({ sub: 'system:serviceaccount:default:attacker' }), { username, audience, now: 1100 }), /identity/);
  assert.throws(() => validateLocalEdgeAutomationTokenClaims(token({}, true), { username, audience, now: 1100 }), /canonical/);
});
