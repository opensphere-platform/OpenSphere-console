'use strict';

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');
const { canonicalPermissionRevision } = require('./os-shell-contract');
const { createOsShellCredentialExchange } = require('./os-shell-delegation');

const NOW = Date.parse('2026-08-15T00:00:00.000Z');
const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const BROWSER_ID = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const REVISION = 7;

function compact(value, keyId, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
}

function corruptSignature(compactJws) {
  const parts = compactJws.split('.'); const signature = Buffer.from(parts[2], 'base64url');
  signature[0] ^= 0x01; parts[2] = signature.toString('base64url'); return parts.join('.');
}

function fixture(browserOverrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }); const jwk = publicKey.export({ format: 'jwk' });
  const keyId = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url');
  const groups = ['console-operators', 'platform-admins']; const permissions = ['session:attach', 'catalog:read'];
  const permissionRevision = canonicalPermissionRevision({ credentialRevision: REVISION, roles: groups, permissions });
  const session = { session_id: SESSION_ID, browser_session_id: BROWSER_ID, actor_id: ACTOR_ID,
    origin: 'https://console.example.test', session_class: 'operator-interactive', runtime_adapter_id: 'cbss.kubernetes-pod',
    runtime_uid: 'pod-uid-1', runtime_public_key_pem: pem, permission_revision: permissionRevision, aal: 'aal2',
    release_evidence_ref: 'release://test', generation: 2, fencing_epoch: 9 };
  const issued = [];
  const exchange = createOsShellCredentialExchange({ secret: 's'.repeat(32), now: () => NOW,
    resolveShellSession: async () => session,
    resolveBrowserSession: async () => ({ active: true, assurance: 'aal2', authzRevision: String(REVISION),
      groups: [...groups].reverse(), permissions: [...permissions].reverse(), ...browserOverrides }),
    issueToken: (claims) => { issued.push(claims); return 'web-shell-token'; } });
  const nowSeconds = Math.floor(NOW / 1000);
  const claims = { contract: 'opensphere-web-shell-context/v2', iss: 'opensphere-shell-credential-agent', aud: 'opensphere-os-cli', profile: 'web-shell',
    executionProfile: 'web-shell', authority: 'delegated-credential-agent', sessionClass: session.session_class,
    runtimeAdapterId: session.runtime_adapter_id, jti: 'context-once', sessionId: SESSION_ID, actorId: ACTOR_ID,
    runtimeUid: session.runtime_uid, origin: session.origin, permissionRevision, aal: session.aal,
    releaseEvidenceRef: session.release_evidence_ref, generation: 2, fencingEpoch: 9,
    iat: nowSeconds, nbf: nowSeconds, exp: nowSeconds + 30 };
  return { exchange, issued, session, claims, keyId, privateKey, body: { binding: { sessionId: SESSION_ID, actorId: ACTOR_ID, generation: 2,
    fencingEpoch: 9, permissionRevision, aal: 'aal2' }, contextJws: compact(claims, keyId, privateKey) } };
}

test('delegation revalidates current sorted roles/permissions and issues only a <=5 minute web_shell credential', async () => {
  const value = fixture(); const result = await value.exchange({ headers: { 'x-os-shell-delegation-secret': 's'.repeat(32) } }, value.body);
  assert.equal(result.accessToken, 'web-shell-token'); assert.equal(Date.parse(result.tokenExpiresAt), NOW + 240_000);
  assert.equal(value.issued.length, 1); assert.equal(value.issued[0].typ, 'web_shell'); assert.equal(value.issued[0].exp, Math.floor(NOW / 1000) + 240);
  assert.equal(value.issued[0].permission_revision, value.session.permission_revision);
  assert.equal('access_token' in value.issued[0], false); assert.equal('browser_session_id' in value.issued[0], false);
});

test('role downgrade changes canonical permissionRevision immediately and blocks credential mint', async () => {
  const value = fixture({ groups: ['console-operators'] });
  await assert.rejects(() => value.exchange({ headers: { 'x-os-shell-delegation-secret': 's'.repeat(32) } }, value.body),
    (error) => error.code === 403 && /revision/.test(error.msg));
  assert.equal(value.issued.length, 0);
});

test('missing attach permission, AAL drift, bad service secret and stale context all fail closed', async () => {
  const noPermission = fixture({ permissions: ['catalog:read'] });
  await assert.rejects(() => noPermission.exchange({ headers: { 'x-os-shell-delegation-secret': 's'.repeat(32) } }, noPermission.body),
    (error) => error.code === 403);
  const aal = fixture({ assurance: 'aal1' });
  await assert.rejects(() => aal.exchange({ headers: { 'x-os-shell-delegation-secret': 's'.repeat(32) } }, aal.body),
    (error) => error.code === 403);
  const secret = fixture();
  await assert.rejects(() => secret.exchange({ headers: { 'x-os-shell-delegation-secret': 'wrong' } }, secret.body),
    (error) => error.code === 401);
  const stale = fixture();
  await assert.rejects(() => stale.exchange({ headers: { 'x-os-shell-delegation-secret': 's'.repeat(32) } },
    { ...stale.body, contextJws: corruptSignature(stale.body.contextJws) }), (error) => error.code === 401);
});

test('every compact JWS segment must use canonical unpadded base64url', async () => {
  for (const index of [0, 1, 2]) {
    const value = fixture(); const parts = value.body.contextJws.split('.'); parts[index] += '=';
    await assert.rejects(() => value.exchange({ headers: { 'x-os-shell-delegation-secret': 's'.repeat(32) } },
      { ...value.body, contextJws: parts.join('.') }), (error) => error.code === 401);
  }
});

test('context JWS contract version cannot be omitted or downgraded', async () => {
  for (const contract of [undefined, 'opensphere-web-shell-context/v1', 'unknown']) {
    const value = fixture(); const claims = { ...value.claims };
    if (contract === undefined) delete claims.contract; else claims.contract = contract;
    await assert.rejects(() => value.exchange({ headers: { 'x-os-shell-delegation-secret': 's'.repeat(32) } },
      { ...value.body, contextJws: compact(claims, value.keyId, value.privateKey) }), (error) => error.code === 401);
  }
});
