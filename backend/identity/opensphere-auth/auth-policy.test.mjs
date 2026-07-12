import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_TOTP_ENABLED,
  authPolicyFromConfigMap,
  authPolicyPatch,
  parsePolicyBoolean,
} from './auth-policy.mjs';

test('development default keeps TOTP disabled', () => {
  assert.equal(DEFAULT_TOTP_ENABLED, false);
  assert.deepEqual(authPolicyFromConfigMap(null), {
    totpEnabled: false,
    environment: 'development',
    updatedAt: null,
    updatedBy: null,
    source: 'default',
  });
});

test('ConfigMap values normalize to one boolean policy', () => {
  assert.equal(parsePolicyBoolean('enabled'), true);
  assert.equal(parsePolicyBoolean('off', true), false);
  assert.equal(parsePolicyBoolean('unexpected', true), true);
  assert.equal(authPolicyFromConfigMap({ data: { totpEnabled: 'true', environment: 'staging' } }).totpEnabled, true);
});

test('policy patch records actor and timestamp', () => {
  assert.deepEqual(authPolicyPatch(true, 'mars', new Date('2026-07-12T00:00:00.000Z')), {
    data: { totpEnabled: 'true', updatedAt: '2026-07-12T00:00:00.000Z', updatedBy: 'mars' },
  });
  assert.throws(() => authPolicyPatch('true', 'mars'), /must be boolean/);
});

test('deployment declares shared development policy and scoped RBAC', () => {
  const deploy = fs.readFileSync(new URL('./deploy.yaml', import.meta.url), 'utf8');
  assert.match(deploy, /name:\s*opensphere-auth-policy/);
  assert.match(deploy, /environment:\s*development/);
  assert.match(deploy, /opensphere\.io\/default-totp-enabled:\s*"false"/);
  assert.doesNotMatch(deploy, /\n\s+totpEnabled:\s*"false"/);
  assert.match(deploy, /resourceNames:\s*\["opensphere-auth-pats",\s*"opensphere-auth-policy"\]/);
  assert.match(deploy, /name:\s*opensphere-auth-codes/);
  assert.match(deploy, /resourceNames:\s*\["opensphere-auth-codes"\]/);
});

test('authorization codes use the shared one-time Secret store', () => {
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /const\s+codes\s*=\s*new Map/);
  assert.match(server, /storeAuthorizationCode/);
  assert.match(server, /takeAuthorizationCode/);
  assert.match(server, /resourceVersion/);
});
