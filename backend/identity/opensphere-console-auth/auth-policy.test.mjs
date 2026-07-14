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
    enforced: false,
    updatedAt: null,
    updatedBy: null,
    source: 'default',
  });
});

// AG-5: 운영(production)은 TOTP를 강제(totpEnabled=true, enforced=true)하고, 배포 env override가 ConfigMap보다 우선.
test('AG-5: production forces TOTP on and marks it enforced, env override wins', () => {
  const viaConfigMap = authPolicyFromConfigMap({ data: { totpEnabled: 'false', environment: 'production' } });
  assert.equal(viaConfigMap.totpEnabled, true, 'production must force TOTP on even if configured false');
  assert.equal(viaConfigMap.enforced, true);

  const viaOverride = authPolicyFromConfigMap({ data: { totpEnabled: 'false', environment: 'development' } }, DEFAULT_TOTP_ENABLED, 'production');
  assert.equal(viaOverride.totpEnabled, true, 'env override=production must force TOTP even if ConfigMap says development');
  assert.equal(viaOverride.enforced, true);
  assert.equal(viaOverride.environment, 'production');

  // development은 강제하지 않고 설정값을 따른다.
  const dev = authPolicyFromConfigMap({ data: { totpEnabled: 'false', environment: 'development' } });
  assert.equal(dev.totpEnabled, false);
  assert.equal(dev.enforced, false);
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
  assert.match(deploy, /name:\s*opensphere-console-auth-policy/);
  assert.match(deploy, /environment:\s*development/);
  assert.match(deploy, /opensphere\.io\/default-totp-enabled:\s*"false"/);
  assert.doesNotMatch(deploy, /\n\s+totpEnabled:\s*"false"/);
  assert.match(deploy, /resourceNames:\s*\["opensphere-console-auth-policy"\][\s\S]*verbs:\s*\["get",\s*"patch",\s*"update"\]/);
  // Legacy credential ConfigMaps may be patched only to delete successfully
  // migrated records.  `update` remains forbidden: it could replace an entire
  // ConfigMap and reintroduce revoked credential material.
  assert.match(deploy, /resourceNames:\s*\["opensphere-console-auth-pats",\s*"opensphere-console-auth-cli-devices"\][\s\S]*verbs:\s*\["get",\s*"patch"\]/);
  assert.doesNotMatch(deploy, /resourceNames:\s*\["opensphere-console-auth-pats",\s*"opensphere-console-auth-cli-devices"\][\s\S]{0,100}verbs:\s*\[[^\]]*"update"/);
  assert.match(deploy, /name:\s*opensphere-console-auth-codes/);
  assert.match(deploy, /name:\s*opensphere-console-auth-cli-flows/);
  assert.match(deploy, /resourceNames:\s*\["opensphere-console-auth-codes",\s*"opensphere-console-auth-cli-flows"\]/);
});

// AG-5: BFF는 운영 강제 환경에서 TOTP 비활성화 요청을 403으로 거부하고, environment를 배포 env로 결정한다.
test('AG-5: server enforces TOTP in production and rejects disabling it', () => {
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(server, /const AUTH_ENVIRONMENT = process\.env\.AUTH_ENVIRONMENT/);
  assert.match(server, /authPolicyFromConfigMap\(r\.json, DEFAULT_TOTP_ENABLED, AUTH_ENVIRONMENT\)/);
  assert.match(server, /current\.enforced && body\.totpEnabled === false/);
  assert.match(server, /totp_enforced_in_production/);
});

test('authorization codes use the shared one-time Secret store', () => {
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /const\s+codes\s*=\s*new Map/);
  assert.match(server, /storeAuthorizationCode/);
  assert.match(server, /takeAuthorizationCode/);
  assert.match(server, /resourceVersion/);
});

test('BFF readiness verifies durable credential storage and the authentication policy', () => {
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const deploy = fs.readFileSync(new URL('./deploy.yaml', import.meta.url), 'utf8');
  assert.match(server, /async function bffReadiness\(\)/);
  assert.match(server, /credentialStoreRequest\('GET', '\/readyz'\)/);
  assert.match(server, /k8sApi\('GET', AUTH_POLICY_CM_PATH\)/);
  assert.match(server, /p === '\/bff\/healthz'[\s\S]{0,180}state\.ready \? 200 : 503/);
  assert.match(deploy, /readinessProbe:[\s\S]{0,120}path: \/bff\/healthz/);
  assert.match(deploy, /livenessProbe:[\s\S]{0,120}path: \/healthz/);
});
