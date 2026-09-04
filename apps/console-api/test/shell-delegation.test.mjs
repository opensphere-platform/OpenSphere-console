import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createShellDelegationBroker, createShellConsoleHandler} from '../src/shell-delegation.mjs';
import {REGISTRY_NAMESPACES} from '../src/registry-lifecycle-contract.mjs';

const NOW = Date.parse('2026-09-04T00:00:00.000Z');
const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const PERMISSION_REVISION = `sha256:${'a'.repeat(64)}`;

function compact(claims, publicKey, privateKey) {
  const jwk = publicKey.export({format: 'jwk'});
  const kid = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url');
  const header = Buffer.from(JSON.stringify({alg: 'EdDSA', typ: 'JWT', kid})).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

function fixture(projectionOverrides = {}) {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const binding = Object.freeze({
    sessionId: SESSION_ID,
    actorId: ACTOR_ID,
    origin: 'https://localhost:1114',
    sessionClass: 'operator-interactive',
    runtimeAdapterId: 'cbss.kubernetes-pod',
    networkProfile: 'console-only',
    runtimeUid: 'runtime-pod-uid',
    permissionRevision: PERMISSION_REVISION,
    aal: 'aal2',
    releaseEvidenceRef: 'release://edge/test',
    generation: 2,
    fencingEpoch: 9,
  });
  const projection = {
    binding,
    session: {
      authorityFresh: true,
      revokedAt: null,
      permissions: ['session:attach', 'console.role.operator', 'catalog:read'],
      subjectId: ACTOR_ID,
    },
    runtimePublicKeyPem: publicKey.export({type: 'spki', format: 'pem'}),
    credentialExpiresAt: new Date(NOW + 600_000).toISOString(),
    ...projectionOverrides,
  };
  const queries = [];
  const broker = createShellDelegationBroker({
    delegationSecret: 's'.repeat(32),
    signingKey: Buffer.alloc(32, 7),
    now: () => NOW,
    query: async (sql, parameters) => {
      queries.push({sql, parameters});
      if (sql.includes('has_function_privilege')) return {rows: [{ready: true}]};
      return {rows: [{authority: projection}]};
    },
  });
  const now = Math.floor(NOW / 1000);
  const contextJws = compact({
    contract: 'opensphere-web-shell-context/v2',
    iss: 'opensphere-shell-credential-agent',
    aud: 'opensphere-os-cli',
    profile: 'web-shell',
    executionProfile: 'web-shell',
    authority: 'delegated-credential-agent',
    sessionClass: binding.sessionClass,
    runtimeAdapterId: binding.runtimeAdapterId,
    jti: 'context-once',
    sessionId: binding.sessionId,
    actorId: binding.actorId,
    runtimeUid: binding.runtimeUid,
    origin: binding.origin,
    permissionRevision: binding.permissionRevision,
    aal: binding.aal,
    releaseEvidenceRef: binding.releaseEvidenceRef,
    generation: binding.generation,
    fencingEpoch: binding.fencingEpoch,
    iat: now,
    nbf: now,
    exp: now + 30,
  }, publicKey, privateKey);
  return {broker, binding, contextJws, queries};
}

test('native Shell authority exchanges a runtime-signed context for a short delegated credential', async () => {
  const value = fixture();
  assert.equal(await value.broker.health(), true);
  const result = await value.broker.exchange({
    secret: 's'.repeat(32),
    body: {binding: value.binding, contextJws: value.contextJws},
  });
  assert.match(result.accessToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(Date.parse(result.tokenExpiresAt), NOW + 240_000);
  const session = await value.broker.resolveSession({headers: {authorization: `Bearer ${result.accessToken}`}});
  assert.equal(session.subjectId, ACTOR_ID);
  assert.equal(session.credentialKind, 'web_shell');
  assert.equal(session.shellSessionId, SESSION_ID);
  assert.equal(value.queries.filter(({sql}) => sql.startsWith('SELECT console_shell.resolve_native_shell_authority')).length, 2);
});

test('native Shell authority fails closed for browser credentials and stale authority', async () => {
  const value = fixture();
  const result = await value.broker.exchange({secret: 's'.repeat(32), body: {binding: value.binding, contextJws: value.contextJws}});
  await assert.rejects(
    value.broker.resolveSession({headers: {authorization: `Bearer ${result.accessToken}`, cookie: 'session=browser'}}),
    (error) => error.code === 'ShellDelegationRejected' && error.status === 401,
  );
  const stale = fixture({session: {authorityFresh: false, revokedAt: null, permissions: ['session:attach'], subjectId: ACTOR_ID}});
  await assert.rejects(
    stale.broker.exchange({secret: 's'.repeat(32), body: {binding: stale.binding, contextJws: stale.contextJws}}),
    (error) => error.code === 'ShellDelegationRejected' && error.status === 401,
  );
});

function responseCapture() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test('private Shell Console API exposes only the explicit delegated route set', async () => {
  let delegatedCalls = 0;
  const broker = {
    health: async () => true,
    resolveSession: async () => ({subjectId: ACTOR_ID, permissions: ['console.role.operator'], accessTokenExpiresAt: new Date(NOW + 60_000).toISOString()}),
  };
  const handler = createShellConsoleHandler({
    broker,
    handlerOptions: {health: async () => true},
    createHandler: () => async () => { delegatedCalls += 1; },
  });
  const introspect = responseCapture();
  await handler({method: 'GET', url: '/api/identity/cli/introspect', headers: {}}, introspect);
  assert.equal(introspect.status, 200);
  assert.deepEqual(introspect.body.groups, ['console-operators']);
  const blocked = responseCapture();
  await handler({method: 'GET', url: '/api/internal/arbitrary', headers: {}}, blocked);
  assert.equal(blocked.status, 404);
  assert.equal(delegatedCalls, 0);
});

test('registry credential propagation includes the OS Shell runtime namespace', () => {
  assert.ok(REGISTRY_NAMESPACES.includes('opensphere-shell-sessions'));
});

test('Console API image carries the native Shell context verifier', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(
    dockerfile,
    /COPY apps\/os-shell-control\/authority\/os-shell-context[.]js \/workspace\/apps\/os-shell-control\/authority\/os-shell-context[.]js/u,
  );
});
