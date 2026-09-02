import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requireFromApi = createRequire(new URL('../apps/console-api/package.json', import.meta.url));
const { Pool } = requireFromApi('pg');
const migrationManifest = JSON.parse(await readFile(new URL('../migrations/manifest.json', import.meta.url), 'utf8'));

const runtimeUrl = process.env.CONSOLE_DATABASE_URL;
const adminUrl = process.env.CONSOLE_TEST_ADMIN_DATABASE_URL;
if (!runtimeUrl || !adminUrl) throw new Error('Console API runtime and test-admin database URLs are required');

const port = Number(process.env.CONSOLE_TEST_PORT || 58080);
const origin = 'http://127.0.0.1:' + port;
const publicOrigin = 'https://console.integration.test';
const loginSubjectId = '11111111-1111-4111-8111-111111111111';
const managedTargetSubjectId = '77777777-7777-4777-8777-777777777777';
const managedCreatedSubjectId = 'aaaaaaaa-0000-4000-8000-000000000888';
function integrationAccessToken({ aal, expiresInSeconds, sessionId, amr }) {
  return [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    sub: loginSubjectId,
    role: 'authenticated',
    aal,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    session_id: sessionId,
    ...(amr ? { amr } : {}),
  })).toString('base64url'),
  'integration-signature',
].join('.');
}
let loginAccessToken;
const rotatedLoginAccessToken = integrationAccessToken({
  aal: 'aal1', expiresInSeconds: 3600, sessionId: 'supabase-auth-session-integration-rotated-0001',
});
const loginRefreshToken = 'supabase-refresh-credential-integration-0001';
const rotatedLoginRefreshToken = 'supabase-refresh-credential-integration-rotated-0001';
const enrollmentAal2AccessToken = integrationAccessToken({
  aal: 'aal2', expiresInSeconds: 3600, sessionId: 'supabase-auth-session-enrollment-aal2-0001',
});
const enrollmentAal2RefreshToken = 'supabase-refresh-credential-enrollment-aal2-0001';
const stepUpAal2AccessToken = integrationAccessToken({
  aal: 'aal2', expiresInSeconds: 3600, sessionId: 'supabase-auth-session-step-up-aal2-0001',
});
const stepUpAal2RefreshToken = 'supabase-refresh-credential-step-up-aal2-0001';
const recoveryAccessToken = integrationAccessToken({
  aal: 'aal1', expiresInSeconds: 3600, sessionId: 'supabase-auth-session-recovery-0001',
  amr: [{ method: 'recovery', timestamp: Math.floor(Date.now() / 1000) }],
});
let recoveryPasswordChanged = false;
let recoverySessionLoggedOut = false;
let sessionPreferenceDuration = '24h';
let avatarMetadata = null;
let avatarBytes = null;
let avatarContentType = null;
let totpEnrollmentState = 'none';
const mfaAccessToken = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    sub: loginSubjectId, role: 'authenticated', aal: 'aal1',
    exp: Math.floor(Date.now() / 1000) + 3600,
    session_id: 'supabase-auth-session-mfa-pending-0001',
  })).toString('base64url'),
  'integration-signature',
].join('.');
const mfaAal2AccessToken = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    sub: loginSubjectId, role: 'authenticated', aal: 'aal2',
    exp: Math.floor(Date.now() / 1000) + 3600,
    session_id: 'supabase-auth-session-mfa-aal2-0001',
  })).toString('base64url'),
  'integration-signature',
].join('.');
const mfaRefreshToken = 'supabase-refresh-credential-mfa-pending-0001';
const mfaAal2RefreshToken = 'supabase-refresh-credential-mfa-aal2-0001';
const handle = 'opaque-session-handle-for-console-api-integration';
const csrf = 'csrf-proof-for-console-api-integration';
const credential = 'integration-registry-credential-never-persisted';
const correlationId = 'integration-correlation-registry-0001';
const idempotencyKey = 'integration-registry-operation-0001';
const approverHandle = 'opaque-approver-session-for-console-api-integration';
const approverCsrf = 'csrf-approver-proof-for-console-api-integration';
const approvalCorrelationId = 'integration-correlation-approval-0001';
const approvalIdempotencyKey = 'integration-approval-operation-0001';
const policyRevision = 'console-operation-policy-2026-09-02.1';
const headers = {
  cookie: '__Host-opensphere-session=' + handle,
  'x-os-csrf-token': csrf,
  'x-os-idempotency-key': idempotencyKey,
  'x-os-correlation-id': correlationId,
  'content-type': 'application/json',
};
const body = JSON.stringify({
  username: 'opensphere-platform',
  credential,
  reason: 'verify Console API PostgreSQL integration',
});
const installCatalogRevision = 'sha256:' + 'c'.repeat(64);
const installDigest = 'sha256:' + 'e'.repeat(64);
const installImage = 'ghcr.io/opensphere-platform/opensphere-plugin-workspace@' + installDigest;
const serviceRoleKey = 'integration-service-role-' + 's'.repeat(64);
let recoveryLinkRequests = 0;
let registration = null;
const managedAuthUsers = new Map([[
  managedTargetSubjectId,
  {
    id: managedTargetSubjectId,
    email: 'viewer@opensphere.test',
    banned_until: null,
    user_metadata: { preferred_username: 'viewer', display_name: 'Console Viewer' },
    factors: [{ id: 'managed-target-factor-1', factor_type: 'totp', status: 'verified' }],
  },
]]);
const authorityServer = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const requestContentType = String(request.headers['content-type'] || '').toLowerCase();
  const requestBody = rawBody.length && /(?:^application\/json|[+]json)(?:;|$)/u.test(requestContentType)
    ? JSON.parse(rawBody.toString('utf8'))
    : rawBody.length ? rawBody : null;
  if (request.url === '/token?grant_type=password' && request.method === 'POST') {
    const mfaLogin = requestBody?.email === 'mfa@opensphere.test';
    assert.deepEqual(requestBody, mfaLogin
      ? { email: 'mfa@opensphere.test', password: 'integration-password' }
      : { email: 'operator@opensphere.test', password: 'integration-password' });
    if (!mfaLogin) {
      loginAccessToken = integrationAccessToken({
        aal: 'aal1', expiresInSeconds: 20, sessionId: 'supabase-auth-session-integration-0001',
      });
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      access_token: mfaLogin ? mfaAccessToken : loginAccessToken,
      refresh_token: mfaLogin ? mfaRefreshToken : loginRefreshToken,
      user: { id: loginSubjectId },
    }));
    return;
  }
  if (request.url === '/token?grant_type=refresh_token' && request.method === 'POST') {
    assert.deepEqual(requestBody, { refresh_token: loginRefreshToken });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      access_token: rotatedLoginAccessToken,
      refresh_token: rotatedLoginRefreshToken,
      user: { id: loginSubjectId },
    }));
    return;
  }
  if (request.url === '/user' && request.method === 'GET') {
    const bearer = request.headers.authorization;
    assert.ok([loginAccessToken, rotatedLoginAccessToken, enrollmentAal2AccessToken, stepUpAal2AccessToken,
      mfaAccessToken, mfaAal2AccessToken, recoveryAccessToken]
      .some((token) => bearer === 'Bearer ' + token));
    const enrollmentBearer = bearer === 'Bearer ' + rotatedLoginAccessToken
      || bearer === 'Bearer ' + enrollmentAal2AccessToken
      || bearer === 'Bearer ' + stepUpAal2AccessToken;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: loginSubjectId,
      email: 'operator@opensphere.test',
      user_metadata: {
        console_session_persistence: sessionPreferenceDuration,
        ...(avatarMetadata ? { console_avatar: avatarMetadata } : {}),
      },
      identities: [{ provider: 'github', identity_data: { avatar_url: 'https://avatars.integration.test/operator#profile' } }],
      factors: bearer === 'Bearer ' + mfaAccessToken
        ? [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }]
        : enrollmentBearer && totpEnrollmentState !== 'none'
          ? [{ id: 'factor-enrollment-1', factor_type: 'totp', status: totpEnrollmentState }]
          : [],
    }));
    return;
  }
  if (request.url === '/admin/generate_link' && request.method === 'POST') {
    assert.equal(request.headers.authorization, 'Bearer ' + serviceRoleKey);
    assert.equal(request.headers.apikey, serviceRoleKey);
    assert.equal(requestBody?.type, 'recovery');
    assert.equal(requestBody?.redirect_to, publicOrigin + '/auth/recovery');
    const managedEntry = [...managedAuthUsers.values()].find((candidate) => candidate.email === requestBody?.email);
    assert.ok(requestBody?.email === 'operator@opensphere.test' || managedEntry);
    const recoverySubjectId = managedEntry?.id || loginSubjectId;
    recoveryLinkRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: recoverySubjectId,
      action_link: authorityOrigin + '/verify?token=integration-recovery-link-token-' + recoverySubjectId.slice(0, 8) + '&type=recovery&redirect_to='
        + encodeURIComponent(publicOrigin + '/auth/recovery'),
    }));
    return;
  }
  if (request.url === '/admin/users' && request.method === 'POST') {
    assert.equal(request.headers.authorization, 'Bearer ' + serviceRoleKey);
    assert.equal(request.headers.apikey, serviceRoleKey);
    assert.deepEqual(requestBody, {
      email: 'new-viewer@opensphere.test',
      email_confirm: true,
      user_metadata: { preferred_username: 'new-viewer', display_name: 'New Console Viewer' },
    });
    const created = {
      id: managedCreatedSubjectId,
      email: requestBody.email,
      banned_until: null,
      user_metadata: requestBody.user_metadata,
      factors: [],
    };
    managedAuthUsers.set(managedCreatedSubjectId, created);
    await admin.query('INSERT INTO auth.users(id) VALUES ($1) ON CONFLICT DO NOTHING', [managedCreatedSubjectId]);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(created));
    return;
  }
  const managedUserMatch = request.url?.match(/^\/admin\/users\/([0-9a-f-]{36})$/u);
  if (managedUserMatch && request.method === 'GET') {
    assert.equal(request.headers.authorization, 'Bearer ' + serviceRoleKey);
    assert.equal(request.headers.apikey, serviceRoleKey);
    const requestedSubject = managedUserMatch[1];
    const managedEntry = managedAuthUsers.get(requestedSubject);
    const projected = managedEntry || {
      id: requestedSubject,
      email: 'operator@opensphere.test',
      banned_until: null,
      user_metadata: { preferred_username: 'operator-' + requestedSubject.slice(0, 4), display_name: 'Console Operator' },
      factors: requestedSubject === loginSubjectId
        ? [{ id: 'factor-enrollment-1', factor_type: 'totp', status: totpEnrollmentState === 'none' ? 'unverified' : totpEnrollmentState }]
        : [],
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(projected));
    return;
  }
  if (managedUserMatch && request.method === 'PUT') {
    assert.equal(request.headers.authorization, 'Bearer ' + serviceRoleKey);
    assert.equal(request.headers.apikey, serviceRoleKey);
    const requestedSubject = managedUserMatch[1];
    const current = managedAuthUsers.get(requestedSubject);
    if (!current) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const updated = {
      ...current,
      ...(requestBody?.email ? { email: requestBody.email } : {}),
      ...(requestBody?.user_metadata ? { user_metadata: requestBody.user_metadata } : {}),
      ...(requestBody?.ban_duration ? {
        banned_until: requestBody.ban_duration === 'none' ? null : '2126-09-02T00:00:00.000Z',
      } : {}),
    };
    managedAuthUsers.set(requestedSubject, updated);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(updated));
    return;
  }
  if (managedUserMatch && request.method === 'DELETE') {
    assert.equal(request.headers.authorization, 'Bearer ' + serviceRoleKey);
    assert.equal(request.headers.apikey, serviceRoleKey);
    const requestedSubject = managedUserMatch[1];
    managedAuthUsers.delete(requestedSubject);
    await admin.query('DELETE FROM auth.users WHERE id=$1', [requestedSubject]);
    response.writeHead(204);
    response.end();
    return;
  }
  const managedFactorMatch = request.url?.match(/^\/admin\/users\/([0-9a-f-]{36})\/factors\/([^/]+)$/u);
  if (managedFactorMatch && request.method === 'DELETE') {
    assert.equal(request.headers.authorization, 'Bearer ' + serviceRoleKey);
    assert.equal(request.headers.apikey, serviceRoleKey);
    const requestedSubject = managedFactorMatch[1];
    const factorId = decodeURIComponent(managedFactorMatch[2]);
    const current = managedAuthUsers.get(requestedSubject);
    assert.ok(current?.factors.some((factor) => factor.id === factorId && factor.factor_type === 'totp'));
    managedAuthUsers.set(requestedSubject, { ...current, factors: current.factors.filter((factor) => factor.id !== factorId) });
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.url === '/user' && request.method === 'PUT') {
    if (request.headers.authorization === 'Bearer ' + recoveryAccessToken) {
      assert.deepEqual(requestBody, { password: 'recovered-integration-password' });
      recoveryPasswordChanged = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: loginSubjectId }));
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer ' + rotatedLoginAccessToken);
    if (requestBody?.data?.console_avatar) {
      avatarMetadata = requestBody.data.console_avatar;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: loginSubjectId,
        user_metadata: { console_session_persistence: sessionPreferenceDuration, console_avatar: avatarMetadata },
        identities: [{ provider: 'github', identity_data: { avatar_url: 'https://avatars.integration.test/operator#profile' } }],
      }));
      return;
    }
    assert.deepEqual(requestBody, { data: { console_session_persistence: '7d' } });
    sessionPreferenceDuration = '7d';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: loginSubjectId,
      user_metadata: { console_session_persistence: sessionPreferenceDuration },
    }));
    return;
  }
  const avatarObjectUrl = `/object/console-uploads/avatars/${loginSubjectId}/profile`;
  if (request.url === avatarObjectUrl) {
    assert.equal(request.headers.authorization, 'Bearer ' + serviceRoleKey);
    assert.equal(request.headers.apikey, serviceRoleKey);
    if (request.method === 'POST') {
      assert.equal(request.headers['x-upsert'], 'true');
      assert.ok(['image/webp', 'image/png', 'image/jpeg'].includes(String(request.headers['content-type'])));
      avatarBytes = rawBody;
      avatarContentType = String(request.headers['content-type']);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && avatarBytes) {
      response.writeHead(200, { 'content-type': avatarContentType, 'content-length': String(avatarBytes.length) });
      response.end(avatarBytes);
      return;
    }
    if (request.method === 'DELETE') {
      avatarBytes = null;
      avatarContentType = null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
  }
  if (request.url === '/logout?scope=global' && request.method === 'POST') {
    assert.equal(request.headers.authorization, 'Bearer ' + recoveryAccessToken);
    recoverySessionLoggedOut = true;
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.url === '/factors' && request.method === 'POST') {
    assert.equal(request.headers.authorization, 'Bearer ' + rotatedLoginAccessToken);
    assert.deepEqual(requestBody, { factor_type: 'totp', friendly_name: 'OpenSphere Console administrator' });
    totpEnrollmentState = 'unverified';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'factor-enrollment-1',
      totp: {
        secret: 'JBSWY3DPEHPK3PXP',
        qr_code: '<svg>integration enrollment</svg>',
        uri: 'otpauth://totp/OpenSphere-integration',
      },
    }));
    return;
  }
  if (request.url === '/factors/factor-enrollment-1/challenge' && request.method === 'POST') {
    const steppingUp = request.headers.authorization === 'Bearer ' + enrollmentAal2AccessToken;
    assert.ok(steppingUp || request.headers.authorization === 'Bearer ' + rotatedLoginAccessToken);
    assert.deepEqual(requestBody, {});
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: steppingUp
      ? 'integration-step-up-challenge-0001'
      : 'integration-enrollment-challenge-0001' }));
    return;
  }
  if (request.url === '/factors/factor-enrollment-1/verify' && request.method === 'POST') {
    const steppingUp = request.headers.authorization === 'Bearer ' + enrollmentAal2AccessToken;
    assert.ok(steppingUp || request.headers.authorization === 'Bearer ' + rotatedLoginAccessToken);
    assert.deepEqual(requestBody, steppingUp
      ? { challenge_id: 'integration-step-up-challenge-0001', code: '789012' }
      : { challenge_id: 'integration-enrollment-challenge-0001', code: '654321' });
    totpEnrollmentState = 'verified';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      access_token: steppingUp ? stepUpAal2AccessToken : enrollmentAal2AccessToken,
      refresh_token: steppingUp ? stepUpAal2RefreshToken : enrollmentAal2RefreshToken,
    }));
    return;
  }
  if (request.url === '/factors/factor-1/challenge' && request.method === 'POST') {
    assert.equal(request.headers.authorization, 'Bearer ' + mfaAccessToken);
    assert.deepEqual(requestBody, {});
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'integration-mfa-challenge-0001' }));
    return;
  }
  if (request.url === '/factors/factor-1/verify' && request.method === 'POST') {
    assert.equal(request.headers.authorization, 'Bearer ' + mfaAccessToken);
    assert.deepEqual(requestBody, { challenge_id: 'integration-mfa-challenge-0001', code: '123456' });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: mfaAal2AccessToken, refresh_token: mfaAal2RefreshToken }));
    return;
  }
  if (request.url === '/health' || request.url === '/status') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
    return;
  }
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/openapi+json' });
    response.end(JSON.stringify({ openapi: '3.0.0', paths: { '/console': {} } }));
    return;
  }
  if (request.url === '/api/v1/registry/resolve' && request.method === 'POST') {
    const revision = String(requestBody?.revision || '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      result: 'Eligible', revision,
      candidate: {
        kind: 'extension', descriptorId: 'extension.workspace', id: 'workspace',
        image: installImage, digest: installDigest, channel: 'edge', catalogRevision: revision,
        descriptorRevision: revision, executionRevision: installImage,
        sourceRevision: 'a'.repeat(40), manifestDigest: 'sha256:' + 'd'.repeat(64),
        compatibilityVersion: '1.0.0', buildAuthority: 'localhost', keyId: 'integration-release-key',
        evidenceRefs: [`oci:${installImage}#p256-module-signature`, `oci:${installImage}#local-edge-build-metadata`],
        packageResourceVersion: '17', packageGeneration: 2,
        verification: {
          catalog: 'Verified', manifest: 'Verified', signature: 'Verified', permissions: 'Approved',
          provenance: 'LocalEdgeSigned', sbom: 'NotRequiredLocalEdge',
        },
      },
    }));
    return;
  }
  if (request.url?.endsWith('/uipluginpackages/workspace') && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      metadata: {
        name: 'workspace', resourceVersion: '17', generation: 2,
        labels: { 'opensphere.io/scope': 'workspace-extension' },
      },
      spec: {
        kind: 'plugin', image: { repository: 'ghcr.io/opensphere-platform/opensphere-plugin-workspace', digest: installDigest },
        resolution: {
          resolvedDigest: installDigest, requestedChannel: 'edge', revision: 'a'.repeat(40),
          compatibilityVersion: '1.0.0', signatureIdentity: 'integration-release-key',
        },
        manifest: { sha256: 'd'.repeat(64) }, trust: { keyId: 'integration-release-key' },
      },
    }));
    return;
  }
  if (request.url?.endsWith('/uipluginregistrations/workspace') && request.method === 'GET') {
    response.writeHead(registration ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(registration || { reason: 'NotFound' }));
    return;
  }
  if (request.url?.endsWith('/uipluginregistrations') && request.method === 'POST') {
    registration = {
      ...requestBody,
      metadata: { ...requestBody.metadata, uid: 'integration-registration-uid', resourceVersion: '18', generation: 3 },
      status: {
        observedGeneration: 3, phase: 'Ready', currentDigest: installDigest,
        currentManifestSha256: 'd'.repeat(64), currentRevision: 'a'.repeat(40),
        currentCompatibilityVersion: '1.0.0', currentSignatureIdentity: 'integration-release-key',
        workload: { phase: 'Ready' },
        verification: { manifest: 'Verified', signature: 'Verified', entryDigest: 'Verified', permissions: 'Approved' },
        serving: { phase: 'Current', digest: installDigest, manifestSha256: 'd'.repeat(64) },
        revalidation: { phase: 'Passed' },
      },
    };
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify(registration));
    return;
  }
  if (request.url?.endsWith('/uipluginregistrations/workspace') && request.method === 'PATCH' && registration) {
    if (requestBody?.metadata?.resourceVersion !== registration.metadata.resourceVersion) {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ reason: 'Conflict' }));
      return;
    }
    registration = {
      ...registration,
      metadata: { ...registration.metadata, resourceVersion: '19', generation: 4 },
      spec: { ...registration.spec, ...requestBody.spec },
      status: { ...registration.status, observedGeneration: 4, phase: 'Uninstalling' },
    };
    const applied = registration;
    setTimeout(() => { registration = null; }, 20);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(applied));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ reason: 'NotFound' }));
});
await new Promise((resolve) => authorityServer.listen(0, '127.0.0.1', resolve));
const authorityOrigin = 'http://127.0.0.1:' + authorityServer.address().port;
const serviceAccountDirectory = await mkdtemp(join(tmpdir(), 'opensphere-c-ext-e2e-'));
await Promise.all([
  writeFile(join(serviceAccountDirectory, 'token'), 'integration-service-account-token', { mode: 0o600 }),
  writeFile(join(serviceAccountDirectory, 'namespace'), 'opensphere-console', { mode: 0o600 }),
]);
const child = spawn(process.execPath, ['apps/console-api/src/server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    CONSOLE_DATABASE_URL: runtimeUrl,
    CONSOLE_REGISTRY_URL: authorityOrigin,
    CONSOLE_SUPABASE_AUTH_URL: authorityOrigin,
    CONSOLE_SUPABASE_REST_URL: authorityOrigin,
    CONSOLE_SUPABASE_STORAGE_URL: authorityOrigin,
    CONSOLE_PUBLIC_ORIGIN: publicOrigin,
    CONSOLE_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONSOLE_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let extensionChild;
let extensionOutput = '';
let childOutput = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    childOutput = (childOutput + chunk.toString('utf8')).slice(-4000);
  });
}
const admin = new Pool({ connectionString: adminUrl, max: 1 });

async function waitForReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error('Console API exited before readiness: ' + childOutput);
    try {
      const response = await fetch(origin + '/healthz');
      if (response.ok && (await response.json()).state === 'Ready') return;
    } catch {
      // Bounded startup retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Console API readiness timed out: ' + childOutput);
}

async function startExtensionController() {
  const extensionDatabaseUrl = process.env.CONSOLE_EXTENSION_DATABASE_URL;
  if (!extensionDatabaseUrl) throw new Error('CONSOLE_EXTENSION_DATABASE_URL is required');
  extensionChild = spawn(process.execPath, ['apps/extension-controller/src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: '58081',
      CONSOLE_EXTENSION_DATABASE_URL: extensionDatabaseUrl,
      CONSOLE_EXTENSION_WORKER_ID: 'cccccccc-1111-4111-8111-111111111111',
      CONSOLE_EXTENSION_POLL_MS: '100',
      CONSOLE_EXTENSION_LEASE_SECONDS: '30',
      CONSOLE_EXTENSION_OBSERVATION_MAX_ATTEMPTS: '20',
      CONSOLE_REGISTRY_URL: authorityOrigin,
      KUBERNETES_API_URL: authorityOrigin,
      KUBERNETES_SERVICE_ACCOUNT_DIRECTORY: serviceAccountDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [extensionChild.stdout, extensionChild.stderr]) {
    stream.on('data', (chunk) => {
      extensionOutput = (extensionOutput + chunk.toString('utf8')).slice(-4000);
    });
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (extensionChild.exitCode != null) throw new Error('Extension Controller exited before readiness: ' + extensionOutput);
    try {
      const response = await fetch('http://127.0.0.1:58081/healthz');
      if (response.ok && (await response.json()).state === 'Ready') return;
    } catch {
      // Bounded startup retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Extension Controller readiness timed out: ' + extensionOutput);
}

async function mutation(candidateBody = body, candidateHeaders = headers) {
  return fetch(origin + '/api/admin/extensions/registry-connections/opensphere-ghcr', {
    method: 'PUT',
    headers: candidateHeaders,
    body: candidateBody,
  });
}

async function createRevocation() {
  const image = 'ghcr.io/opensphere-platform/console@sha256:' + 'e'.repeat(64);
  const response = await fetch(origin + '/api/admin/extensions/revocations', {
    method: 'POST',
    headers: {
      ...headers,
      'x-os-idempotency-key': 'integration-revocation-operation-0001',
      'x-os-correlation-id': 'integration-correlation-revocation-0001',
    },
    body: JSON.stringify({
      image,
      reason: 'verify independent approval integration',
      confirmation: 'REVOKE ' + image,
    }),
  });
  assert.equal(response.status, 202);
  return response.json();
}

function approval(operationId, candidateBody, candidateHeaders = {}) {
  return fetch(origin + '/api/platform/operations/' + operationId + '/approvals', {
    method: 'POST',
    headers: {
      cookie: '__Host-opensphere-session=' + approverHandle,
      'x-os-csrf-token': approverCsrf,
      'x-os-idempotency-key': approvalIdempotencyKey,
      'x-os-correlation-id': approvalCorrelationId,
      'content-type': 'application/json',
      ...candidateHeaders,
    },
    body: JSON.stringify(candidateBody),
  });
}

function verification(operationId, candidateBody, candidateHeaders = {}) {
  return fetch(origin + '/api/platform/operations/' + operationId + '/verification', {
    method: 'POST',
    headers: {
      cookie: headers.cookie,
      'x-os-csrf-token': csrf,
      'x-os-idempotency-key': 'integration-verification-operation-0001',
      'x-os-correlation-id': 'integration-verification-correlation-0001',
      'content-type': 'application/json',
      ...candidateHeaders,
    },
    body: JSON.stringify(candidateBody),
  });
}

try {
  await admin.query('BEGIN');
  try {
    await admin.query('INSERT INTO auth.users(id) VALUES ($1) ON CONFLICT DO NOTHING', [managedTargetSubjectId]);
    await admin.query([
      'INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)',
      'SELECT $1, desired_permission.permission_name, authority.permission_revision, $1',
      'FROM console_identity.subject_authority authority',
      "CROSS JOIN unnest(ARRAY['console.identity.manage','console.role.admin']::text[]) AS desired_permission(permission_name)",
      'WHERE authority.subject_id=$1 AND NOT EXISTS (',
      ' SELECT 1 FROM console_identity.permission_grant current_grant',
      ' WHERE current_grant.subject_id=$1 AND current_grant.permission=desired_permission.permission_name AND current_grant.revoked_at IS NULL)',
    ].join(' '), [loginSubjectId]);
    await admin.query([
      'UPDATE console_identity.browser_session session_row',
      'SET permission_revision=authority.permission_revision, revoke_epoch=authority.revoke_epoch,',
      'revoked_at=NULL, revoke_reason=NULL, last_reauthenticated_at=statement_timestamp()',
      'FROM console_identity.subject_authority authority',
      "WHERE session_row.session_id='22222222-2222-4222-8222-222222222222'",
      'AND authority.subject_id=$1 AND session_row.subject_id=authority.subject_id',
    ].join(' '), [loginSubjectId]);
    await admin.query([
      'INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)',
      "VALUES ($1, '77777777-0000-4000-8000-000000000001', 1, 0)",
    ].join(' '), [managedTargetSubjectId]);
    await admin.query([
      'INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)',
      "SELECT $1, permission, 1, $2 FROM unnest(console_identity.managed_role_permissions('console-viewers')) permission",
    ].join(' '), [managedTargetSubjectId, loginSubjectId]);
    await admin.query([
      'SELECT console_identity.issue_browser_session(',
      "$1, sha256(convert_to('managed-target-e2e-handle','UTF8')), sha256(convert_to('managed-target-e2e-csrf','UTF8')),",
      "'v1.TUFOQUdFRFRBUkdFVEFDQ0VTUw.TUFOQUdFRFRBUkdFVEFDQ0VTUw.TUFOQUdFRFRBUkdFVEFDQ0VTUw',",
      "'v1.TUFOQUdFRFRBUkdFVFJFRlJFU0g.TUFOQUdFRFRBUkdFVFJFRlJFU0g.TUFOQUdFRFRBUkdFVFJFRlJFU0g',",
      "'managed-target-auth-session', 'aal1', statement_timestamp()+interval '1 hour',",
      "statement_timestamp()+interval '24 hours', '24h', false, 'managed-target-session-0001')",
    ].join(' '), [managedTargetSubjectId]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  await waitForReady();
  const bootstrapStatusResponse = await fetch(origin + '/api/identity/bootstrap/status');
  assert.equal(bootstrapStatusResponse.status, 200);
  assert.deepEqual(await bootstrapStatusResponse.json(), { state: 'complete' });
  const loginResponse = await fetch(origin + '/api/identity/session/login', {
    method: 'POST',
    headers: {
      origin: publicOrigin,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-session-login-0001',
    },
    body: JSON.stringify({ email: 'operator@opensphere.test', password: 'integration-password' }),
  });
  assert.equal(loginResponse.status, 200);
  const loginCookies = loginResponse.headers.getSetCookie();
  assert.equal(loginCookies.length, 2);
  const loginSessionCookie = loginCookies.find((value) => value.startsWith('__Host-opensphere-session='));
  const loginCsrfCookie = loginCookies.find((value) => value.startsWith('__Host-opensphere_csrf='));
  assert.ok(loginSessionCookie);
  assert.ok(loginCsrfCookie);
  assert.match(loginSessionCookie, /; HttpOnly; Secure; SameSite=Strict;/);
  assert.match(loginCsrfCookie, /; Secure; SameSite=Strict;/);
  assert.doesNotMatch(loginCsrfCookie, /; HttpOnly;/);
  const loginCookieHeader = loginSessionCookie.split(';', 1)[0];
  const loginCsrf = decodeURIComponent(loginCsrfCookie.split(';', 1)[0].split('=', 2)[1]);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.mfaRequired, false);
  assert.equal(loginBody.session.status, 'active');
  assert.equal(loginBody.session.persistence, '24h');
  assert.ok(new Date(loginBody.session.idleExpiresAt) < new Date(loginBody.session.absoluteExpiresAt));
  assert.ok(loginCookies.every((cookie) => cookie.includes('Max-Age=86400')));
  assert.doesNotMatch(JSON.stringify(loginBody), /access_token|refresh_token|integration-password|supabase-refresh/i);

  const loginEvidence = await admin.query(
    [
      'SELECT octet_length(token_digest)::int AS token_digest_bytes,',
      'octet_length(csrf_token_digest)::int AS csrf_digest_bytes,',
      'access_token_ciphertext, refresh_token_ciphertext, auth_session_ref, revoked_at,',
      'last_seen_at, expires_at, absolute_expires_at, persistence,',
      '(SELECT COALESCE(string_agg(evidence::text, \'\'), \'\') FROM console_audit.event',
      "WHERE action = 'console.identity.session.login' AND correlation_id = $2) AS audit_evidence",
      'FROM console_identity.browser_session WHERE session_id = $1',
    ].join(' '),
    [loginBody.session.id, 'integration-session-login-0001'],
  );
  assert.equal(loginEvidence.rowCount, 1);
  assert.equal(loginEvidence.rows[0].token_digest_bytes, 32);
  assert.equal(loginEvidence.rows[0].csrf_digest_bytes, 32);
  assert.match(loginEvidence.rows[0].access_token_ciphertext, /^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/);
  assert.match(loginEvidence.rows[0].refresh_token_ciphertext, /^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/);
  assert.equal(loginEvidence.rows[0].auth_session_ref, 'supabase-auth-session-integration-0001');
  assert.equal(loginEvidence.rows[0].revoked_at, null);
  assert.equal(loginEvidence.rows[0].persistence, '24h');
  assert.ok(loginEvidence.rows[0].expires_at < loginEvidence.rows[0].absolute_expires_at);
  assert.doesNotMatch(loginEvidence.rows[0].audit_evidence, new RegExp(loginRefreshToken));
  assert.doesNotMatch(loginEvidence.rows[0].audit_evidence, new RegExp(loginAccessToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const issuedSessionResponse = await fetch(origin + '/api/identity/session', {
    headers: { cookie: loginCookieHeader, 'x-os-correlation-id': 'integration-issued-session-read-0001' },
  });
  assert.equal(issuedSessionResponse.status, 200);
  assert.equal((await issuedSessionResponse.json()).data.subjectId, loginSubjectId);
  const refreshedLoginEvidence = await admin.query(
    [
      'SELECT access_token_ciphertext, refresh_token_ciphertext, auth_session_ref,',
      'last_seen_at, expires_at, absolute_expires_at, persistence,',
      "access_token_expires_at > clock_timestamp() + interval '30 minutes' AS durable_future_expiry,",
      '(SELECT COALESCE(string_agg(evidence::text, \'\'), \'\') FROM console_audit.event',
      "WHERE action = 'console.identity.session.refresh' AND correlation_id = $2) AS audit_evidence",
      'FROM console_identity.browser_session WHERE session_id = $1',
    ].join(' '),
    [loginBody.session.id, 'integration-issued-session-read-0001'],
  );
  assert.equal(refreshedLoginEvidence.rowCount, 1);
  assert.notEqual(refreshedLoginEvidence.rows[0].access_token_ciphertext, loginEvidence.rows[0].access_token_ciphertext);
  assert.notEqual(refreshedLoginEvidence.rows[0].refresh_token_ciphertext, loginEvidence.rows[0].refresh_token_ciphertext);
  assert.equal(refreshedLoginEvidence.rows[0].auth_session_ref, 'supabase-auth-session-integration-rotated-0001');
  assert.equal(refreshedLoginEvidence.rows[0].durable_future_expiry, true);
  assert.equal(refreshedLoginEvidence.rows[0].last_seen_at.toISOString(), loginEvidence.rows[0].last_seen_at.toISOString());
  assert.equal(refreshedLoginEvidence.rows[0].expires_at.toISOString(), loginEvidence.rows[0].expires_at.toISOString());
  assert.equal(refreshedLoginEvidence.rows[0].absolute_expires_at.toISOString(), loginEvidence.rows[0].absolute_expires_at.toISOString());
  assert.doesNotMatch(refreshedLoginEvidence.rows[0].audit_evidence, /supabase-refresh|integration-signature/i);

  const managedDirectoryResponse = await fetch(origin + '/api/identity', {
    headers: { cookie: loginCookieHeader, 'x-os-correlation-id': 'integration-managed-identity-list-0001' },
  });
  assert.equal(managedDirectoryResponse.status, 200);
  const managedDirectory = await managedDirectoryResponse.json();
  assert.equal(managedDirectory.meta.scope, 'managed');
  assert.equal(managedDirectory.meta.writeEnabled, true);
  assert.equal(managedDirectory.groups.length, 3);
  const managedTarget = managedDirectory.users.find((user) => user.id === managedTargetSubjectId);
  assert.equal(managedTarget.username, 'viewer');
  assert.deepEqual(managedTarget.groups.map(({ name }) => name), ['console-viewers']);
  assert.doesNotMatch(JSON.stringify(managedDirectory), /service-role|token_digest|refresh_token|apikey/i);

  const preferenceRead = await fetch(origin + '/api/identity/session/preference', {
    headers: { cookie: loginCookieHeader, 'x-os-correlation-id': 'integration-session-preference-read-0001' },
  });
  assert.equal(preferenceRead.status, 200);
  assert.deepEqual(await preferenceRead.json(), {
    duration: '24h', defaultDuration: '24h', idleTimeoutHours: 12, appliesTo: 'next-login',
  });
  const preferenceUpdate = await fetch(origin + '/api/identity/session/preference', {
    method: 'PUT',
    headers: {
      cookie: loginCookieHeader,
      'x-os-csrf-token': loginCsrf,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-session-preference-update-0001',
    },
    body: JSON.stringify({ duration: '7d' }),
  });
  assert.equal(preferenceUpdate.status, 200);
  assert.deepEqual(await preferenceUpdate.json(), {
    duration: '7d', defaultDuration: '24h', idleTimeoutHours: 12, appliesTo: 'next-login',
  });
  const preferenceEvidence = await admin.query(
    [
      'SELECT count(*)::int AS event_count,',
      "COALESCE(string_agg(evidence::text, ''), '') AS evidence",
      'FROM console_audit.event',
      "WHERE action = 'console.identity.session.preference.update' AND correlation_id = $1",
    ].join(' '),
    ['integration-session-preference-update-0001'],
  );
  assert.equal(preferenceEvidence.rows[0].event_count, 1);
  assert.match(preferenceEvidence.rows[0].evidence, /"duration":\s*"7d"/);
  assert.doesNotMatch(preferenceEvidence.rows[0].evidence, /integration-signature|supabase-refresh|apikey/i);

  const initialAvatarRead = await fetch(origin + '/api/identity/profile/avatar', {
    headers: { cookie: loginCookieHeader, 'x-os-correlation-id': 'integration-avatar-read-0001' },
  });
  assert.equal(initialAvatarRead.status, 200);
  const automaticAvatar = await initialAvatarRead.json();
  assert.deepEqual(automaticAvatar.current, {
    source: 'linked', provider: 'github', url: 'https://avatars.integration.test/operator', digest: null, contentType: null,
  });
  assert.deepEqual(automaticAvatar.linkedAccounts, [{ provider: 'github', url: 'https://avatars.integration.test/operator' }]);

  const initialAvatarSelection = await fetch(origin + '/api/identity/profile/avatar', {
    method: 'PUT',
    headers: {
      cookie: loginCookieHeader, 'x-os-csrf-token': loginCsrf, 'content-type': 'application/json',
      'x-os-correlation-id': 'integration-avatar-select-0001',
    },
    body: JSON.stringify({ source: 'initial' }),
  });
  assert.equal(initialAvatarSelection.status, 200);
  assert.equal((await initialAvatarSelection.json()).current.source, 'initial');

  const avatarPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const avatarDigest = `sha256:${createHash('sha256').update(avatarPng).digest('hex')}`;
  const avatarUpload = await fetch(origin + '/api/identity/profile/avatar/upload', {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader, 'x-os-csrf-token': loginCsrf, 'content-type': 'application/json',
      'x-os-correlation-id': 'integration-avatar-upload-0001',
    },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: avatarPng.toString('base64') }),
  });
  const uploadedAvatar = await avatarUpload.json();
  assert.equal(avatarUpload.status, 200, JSON.stringify(uploadedAvatar));
  assert.deepEqual(uploadedAvatar.current, {
    source: 'upload', provider: null,
    url: `/api/identity/profile/avatar/content?v=${encodeURIComponent(avatarDigest)}`,
    digest: avatarDigest, contentType: 'image/png',
  });
  const avatarContent = await fetch(origin + `/api/identity/profile/avatar/content?v=${encodeURIComponent(avatarDigest)}`, {
    headers: { cookie: loginCookieHeader, 'x-os-correlation-id': 'integration-avatar-content-0001' },
  });
  assert.equal(avatarContent.status, 200);
  assert.equal(avatarContent.headers.get('content-type'), 'image/png');
  assert.equal(avatarContent.headers.get('cache-control'), 'private, max-age=300, must-revalidate');
  assert.equal(avatarContent.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await avatarContent.arrayBuffer()), avatarPng);
  assert.equal((await fetch(origin + `/api/identity/profile/avatar/content?v=sha256:${'0'.repeat(64)}`, {
    headers: { cookie: loginCookieHeader },
  })).status, 404);
  const avatarEvidence = await admin.query(
    [
      'SELECT count(*)::int AS event_count,',
      "COALESCE(string_agg(action || evidence::text, ''), '') AS evidence",
      'FROM console_audit.event',
      "WHERE action IN ('console.identity.profile.avatar.select', 'console.identity.profile.avatar.upload')",
      "AND correlation_id IN ('integration-avatar-select-0001', 'integration-avatar-upload-0001')",
    ].join(' '),
  );
  assert.equal(avatarEvidence.rows[0].event_count, 2);
  assert.doesNotMatch(avatarEvidence.rows[0].evidence, /integration-signature|supabase-refresh|service-role|dataBase64/i);

  const recoveryLinkHeaders = {
    cookie: loginCookieHeader,
    'x-os-csrf-token': loginCsrf,
    'x-os-idempotency-key': 'integration-owned-password-recovery-key-0001',
    'x-os-correlation-id': 'integration-owned-password-recovery-correlation-0001',
    'content-type': 'application/json',
  };
  const recoveryLinkResponse = await fetch(origin + '/api/identity/me/password', {
    method: 'POST', headers: recoveryLinkHeaders,
    body: JSON.stringify({ reason: 'self-service password change' }),
  });
  const recoveryLink = await recoveryLinkResponse.json();
  assert.equal(recoveryLinkResponse.status, 200, JSON.stringify(recoveryLink));
  const recoveryLinkUrl = new URL(recoveryLink.resetUrl);
  assert.equal(recoveryLink.ok, true);
  assert.equal(recoveryLinkUrl.origin, publicOrigin);
  assert.equal(recoveryLinkUrl.pathname, '/auth/v1/verify');
  assert.equal(recoveryLinkUrl.searchParams.get('type'), 'recovery');
  assert.equal(recoveryLinkUrl.searchParams.get('redirect_to'), publicOrigin + '/auth/recovery');
  assert.equal(recoveryLinkRequests, 1);
  const recoveryLinkEvidence = await admin.query(
    [
      'SELECT count(*)::int AS event_count,',
      "COALESCE(string_agg(reason || evidence::text, ''), '') AS evidence",
      'FROM console_audit.event',
      "WHERE action = 'console.identity.password.recovery_link.request' AND correlation_id = $1",
    ].join(' '),
    ['integration-owned-password-recovery-correlation-0001'],
  );
  assert.equal(recoveryLinkEvidence.rows[0].event_count, 1);
  assert.match(recoveryLinkEvidence.rows[0].evidence, /self-service password change/);
  assert.doesNotMatch(recoveryLinkEvidence.rows[0].evidence,
    /integration-owned-password-recovery-key-0001|integration-recovery-link-token|operator@opensphere[.]test|integration-signature/i);

  const recoveryLinkReplay = await fetch(origin + '/api/identity/me/password', {
    method: 'POST',
    headers: {
      ...recoveryLinkHeaders,
      'x-os-correlation-id': 'integration-owned-password-recovery-correlation-0002',
    },
    body: JSON.stringify({ reason: 'self-service password change' }),
  });
  assert.equal(recoveryLinkReplay.status, 409);
  const recoveryLinkReplayBody = await recoveryLinkReplay.json();
  assert.equal(recoveryLinkReplayBody.code, 'IdempotencyReplayUnavailable');
  assert.equal(recoveryLinkReplayBody.sideEffect, 'unknown');
  assert.equal(recoveryLinkRequests, 1);

  const sessionHistoryResponse = await fetch(origin + '/api/identity/session/events?limit=2', {
    headers: { cookie: loginCookieHeader, 'x-os-correlation-id': 'integration-session-events-read-0001' },
  });
  assert.equal(sessionHistoryResponse.status, 200);
  const sessionHistory = await sessionHistoryResponse.json();
  assert.equal(sessionHistory.items.length, 2);
  assert.equal(sessionHistory.items[0].event, 'refresh');
  assert.equal(sessionHistory.items[0].result, 'ok');
  assert.equal(sessionHistory.items[0].session_id, loginBody.session.id);
  assert.equal(sessionHistory.items[1].event, 'login');
  assert.deepEqual(Object.keys(sessionHistory.items[0]).sort(), ['event', 'id', 'occurred_at', 'result', 'session_id']);
  assert.doesNotMatch(JSON.stringify(sessionHistory), /integration-signature|supabase-refresh|evidence|reason|correlation/i);
  assert.equal((await fetch(origin + '/api/identity/session/events?limit=101', {
    headers: { cookie: loginCookieHeader },
  })).status, 400);

  await admin.query(
    [
      'UPDATE console_identity.browser_session',
      "SET last_seen_at = statement_timestamp() - interval '2 minutes', expires_at = statement_timestamp() + interval '1 hour'",
      'WHERE session_id = $1',
    ].join(' '),
    [loginBody.session.id],
  );
  const touchResponse = await fetch(origin + '/api/identity/session/touch', {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'x-os-csrf-token': loginCsrf,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-session-activity-touch-0001',
    },
    body: '{}',
  });
  assert.equal(touchResponse.status, 200);
  const touchedSession = (await touchResponse.json()).session;
  assert.equal(touchedSession.id, loginBody.session.id);
  assert.equal(touchedSession.persistence, '24h');
  assert.ok(new Date(touchedSession.idleExpiresAt) > new Date(Date.now() + 11 * 60 * 60 * 1000));
  assert.equal(touchedSession.absoluteExpiresAt, loginBody.session.absoluteExpiresAt);
  const touchEvidence = await admin.query(
    [
      'SELECT last_seen_at > statement_timestamp() - interval \'1 minute\' AS touched,',
      'expires_at > statement_timestamp() + interval \'11 hours\' AS idle_extended,',
      'expires_at <= absolute_expires_at AS absolute_bound,',
      '(SELECT count(*)::int FROM console_audit.event WHERE action = \'console.identity.session.activity\') AS activity_audit_events',
      'FROM console_identity.browser_session WHERE session_id = $1',
    ].join(' '),
    [loginBody.session.id],
  );
  assert.deepEqual(touchEvidence.rows[0], {
    touched: true, idle_extended: true, absolute_bound: true, activity_audit_events: 0,
  });

  const enrollmentResponse = await fetch(origin + '/api/identity/session/totp/enrollment', {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'x-os-csrf-token': loginCsrf,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-totp-enrollment-begin-0001',
    },
    body: JSON.stringify({ friendlyName: 'OpenSphere Console administrator' }),
  });
  assert.equal(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json();
  assert.deepEqual(enrollment, {
    factorId: 'factor-enrollment-1',
    secret: 'JBSWY3DPEHPK3PXP',
    qrCode: '<svg>integration enrollment</svg>',
    uri: 'otpauth://totp/OpenSphere-integration',
  });
  const preEnrollmentEvidence = await admin.query(
    'SELECT access_token_ciphertext, refresh_token_ciphertext, aal FROM console_identity.browser_session WHERE session_id = $1',
    [loginBody.session.id],
  );
  assert.equal(preEnrollmentEvidence.rows[0].aal, 'aal1');
  assert.doesNotMatch(JSON.stringify(preEnrollmentEvidence.rows[0]), /JBSWY3DPEHPK3PXP|factor-enrollment-1|otpauth/);

  const enrollmentVerificationResponse = await fetch(origin + '/api/identity/session/totp/verification', {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'x-os-csrf-token': loginCsrf,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-totp-enrollment-verify-0001',
    },
    body: JSON.stringify({ factorId: enrollment.factorId, code: '654321' }),
  });
  assert.equal(enrollmentVerificationResponse.status, 200);
  assert.deepEqual(await enrollmentVerificationResponse.json(), { assurance: 'aal2', sessionId: loginBody.session.id });
  const enrollmentEvidence = await admin.query(
    [
      'SELECT access_token_ciphertext, refresh_token_ciphertext, auth_session_ref, aal,',
      '(SELECT COALESCE(string_agg(evidence::text, \'\'), \'\') FROM console_audit.event',
      "WHERE action = 'console.identity.factor.totp.enroll' AND correlation_id = $2) AS audit_evidence",
      'FROM console_identity.browser_session WHERE session_id = $1',
    ].join(' '),
    [loginBody.session.id, 'integration-totp-enrollment-verify-0001'],
  );
  assert.equal(enrollmentEvidence.rows[0].aal, 'aal2');
  assert.equal(enrollmentEvidence.rows[0].auth_session_ref, 'supabase-auth-session-enrollment-aal2-0001');
  assert.notEqual(enrollmentEvidence.rows[0].access_token_ciphertext, preEnrollmentEvidence.rows[0].access_token_ciphertext);
  assert.notEqual(enrollmentEvidence.rows[0].refresh_token_ciphertext, preEnrollmentEvidence.rows[0].refresh_token_ciphertext);
  assert.doesNotMatch(enrollmentEvidence.rows[0].audit_evidence, /JBSWY3DPEHPK3PXP|factor-enrollment-1|otpauth|integration-signature/);

  await admin.query(
    "UPDATE console_identity.browser_session SET last_reauthenticated_at = statement_timestamp() - interval '6 minutes' WHERE session_id = $1",
    [loginBody.session.id],
  );
  const staleStepUpHeaders = {
    ...headers,
    cookie: loginCookieHeader,
    'x-os-csrf-token': loginCsrf,
    'x-os-idempotency-key': 'integration-step-up-operation-0001',
    'x-os-correlation-id': 'integration-step-up-operation-correlation-0001',
  };
  const stalePrivilegedResponse = await mutation(body, staleStepUpHeaders);
  assert.equal(stalePrivilegedResponse.status, 428);
  assert.equal((await stalePrivilegedResponse.json()).code, 'StepUpRequired');
  const staleManagedRoleResponse = await fetch(origin + `/api/identity/users/${managedTargetSubjectId}/group`, {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader, 'x-os-csrf-token': loginCsrf, 'content-type': 'application/json',
      'x-os-correlation-id': 'integration-managed-role-stale-0001',
    },
    body: JSON.stringify({ op: 'add', group: 'console-operators', reason: 'grant operations access' }),
  });
  assert.equal(staleManagedRoleResponse.status, 428);
  assert.equal((await staleManagedRoleResponse.json()).code, 'StepUpRequired');
  const stepUpResponse = await fetch(origin + '/api/identity/session/step-up', {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'x-os-csrf-token': loginCsrf,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-session-step-up-0001',
    },
    body: JSON.stringify({ code: '789012' }),
  });
  assert.equal(stepUpResponse.status, 200);
  const stepUpBody = await stepUpResponse.json();
  assert.equal(stepUpBody.assurance, 'aal2');
  assert.ok(new Date(stepUpBody.reauthenticatedAt) > new Date(Date.now() - 60_000));
  const stepUpAccepted = await mutation(body, staleStepUpHeaders);
  assert.equal(stepUpAccepted.status, 202);
  const stepUpEvidence = await admin.query(
    [
      'SELECT last_reauthenticated_at > statement_timestamp() - interval \'1 minute\' AS recent,',
      '(SELECT count(*)::int FROM console_audit.event',
      "WHERE action = 'console.identity.session.step_up' AND correlation_id = $2) AS audit_events",
      'FROM console_identity.browser_session WHERE session_id = $1',
    ].join(' '),
    [loginBody.session.id, 'integration-session-step-up-0001'],
  );
  assert.deepEqual(stepUpEvidence.rows[0], { recent: true, audit_events: 1 });

  const managedRoleHeaders = {
    cookie: loginCookieHeader,
    'x-os-csrf-token': loginCsrf,
    'content-type': 'application/json',
    'x-os-correlation-id': 'integration-managed-role-add-0001',
  };
  const managedRoleBody = JSON.stringify({
    op: 'add', group: 'console-operators', reason: 'grant operations access',
  });
  const managedRoleChange = await fetch(origin + `/api/identity/users/${managedTargetSubjectId}/group`, {
    method: 'POST', headers: managedRoleHeaders, body: managedRoleBody,
  });
  assert.equal(managedRoleChange.status, 200);
  const managedRoleResult = await managedRoleChange.json();
  assert.deepEqual(managedRoleResult.roles, ['console-operators', 'console-viewers']);
  assert.equal(managedRoleResult.permissionRevision, 2);
  assert.equal(managedRoleResult.revokeEpoch, 1);
  assert.equal(managedRoleResult.revokedSessionCount, 1);
  const managedRoleEvidence = await admin.query(
    [
      'SELECT a.permission_revision, a.revoke_epoch,',
      '(SELECT count(*)::int FROM console_identity.browser_session s',
      ' WHERE s.subject_id=a.subject_id AND s.revoked_at IS NULL) AS active_sessions,',
      '(SELECT count(*)::int FROM console_audit.event e',
      " WHERE e.correlation_id='integration-managed-role-add-0001'",
      " AND e.action='console.identity.role.add' AND e.outcome='succeeded') AS audit_events,",
      '(SELECT COALESCE(string_agg(e.evidence::text,\'\'),\'\') FROM console_audit.event e',
      " WHERE e.correlation_id='integration-managed-role-add-0001') AS audit_evidence",
      'FROM console_identity.subject_authority a WHERE a.subject_id=$1',
    ].join(' '),
    [managedTargetSubjectId],
  );
  assert.deepEqual(managedRoleEvidence.rows[0], {
    permission_revision: '2', revoke_epoch: '1', active_sessions: 0, audit_events: 1,
    audit_evidence: managedRoleEvidence.rows[0].audit_evidence,
  });
  assert.doesNotMatch(managedRoleEvidence.rows[0].audit_evidence, /service-role|refresh|token|apikey/i);

  async function managedLifecycle(path, key, correlation, payload) {
    return fetch(origin + path, {
      method: 'POST',
      headers: {
        cookie: loginCookieHeader,
        'x-os-csrf-token': loginCsrf,
        'x-os-idempotency-key': key,
        'x-os-correlation-id': correlation,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  const managedCreateResponse = await managedLifecycle(
    '/api/identity/users',
    'integration-managed-create-key-0001',
    'integration-managed-create-correlation-0001',
    {
      username: 'new-viewer', displayName: 'New Console Viewer', email: 'new-viewer@opensphere.test',
      roles: ['console-viewers'], reason: 'create managed viewer identity',
    },
  );
  const managedCreated = await managedCreateResponse.json();
  assert.equal(managedCreateResponse.status, 201, JSON.stringify(managedCreated));
  assert.equal(managedCreated.id, managedCreatedSubjectId);
  assert.deepEqual(managedCreated.roles, ['console-viewers']);
  assert.equal(new URL(managedCreated.onboardingPath).origin, publicOrigin);

  const managedProfileResponse = await managedLifecycle(
    `/api/identity/users/${managedTargetSubjectId}/attrs`,
    'integration-managed-profile-key-0001',
    'integration-managed-profile-correlation-0001',
    { displayName: 'Updated Console Viewer', email: 'updated-viewer@opensphere.test', reason: 'update managed viewer profile' },
  );
  assert.equal(managedProfileResponse.status, 200, await managedProfileResponse.text());
  assert.equal(managedAuthUsers.get(managedTargetSubjectId).user_metadata.display_name, 'Updated Console Viewer');
  assert.equal(managedAuthUsers.get(managedTargetSubjectId).email, 'updated-viewer@opensphere.test');

  const managedEnabledResponse = await managedLifecycle(
    `/api/identity/users/${managedTargetSubjectId}/enabled`,
    'integration-managed-enabled-key-0001',
    'integration-managed-enabled-correlation-0001',
    { enabled: false, reason: 'disable managed viewer identity' },
  );
  const managedEnabled = await managedEnabledResponse.json();
  assert.equal(managedEnabledResponse.status, 200, JSON.stringify(managedEnabled));
  assert.equal(managedEnabled.enabled, false);
  assert.equal(managedAuthUsers.get(managedTargetSubjectId).banned_until, '2126-09-02T00:00:00.000Z');

  const managedOnboardingResponse = await managedLifecycle(
    `/api/identity/users/${managedTargetSubjectId}/onboarding`,
    'integration-managed-onboarding-key-0001',
    'integration-managed-onboarding-correlation-0001',
    { reason: 'issue managed onboarding link' },
  );
  const managedOnboarding = await managedOnboardingResponse.json();
  assert.equal(managedOnboardingResponse.status, 200, JSON.stringify(managedOnboarding));
  assert.equal(new URL(managedOnboarding.onboardingPath).origin, publicOrigin);

  const managedMfaResponse = await managedLifecycle(
    `/api/identity/users/${managedTargetSubjectId}/mfa/reset`,
    'integration-managed-mfa-key-0001',
    'integration-managed-mfa-correlation-0001',
    { reason: 'reset managed viewer mfa' },
  );
  const managedMfa = await managedMfaResponse.json();
  assert.equal(managedMfaResponse.status, 200, JSON.stringify(managedMfa));
  assert.equal(managedMfa.removedFactorCount, 1);
  assert.equal(managedAuthUsers.get(managedTargetSubjectId).factors.length, 0);

  const managedLifecycleEvidence = await admin.query(
    [
      'SELECT count(*)::int AS event_count, COALESCE(string_agg(action || evidence::text,\'\'),\'\') AS evidence',
      'FROM console_audit.event',
      "WHERE action LIKE 'console.identity.lifecycle.%'",
    ].join(' '),
  );
  assert.equal(managedLifecycleEvidence.rows[0].event_count, 10);
  assert.doesNotMatch(managedLifecycleEvidence.rows[0].evidence,
    /new-viewer@opensphere|updated-viewer@opensphere|integration-recovery-link-token|service-role|apikey/i);
  const managedAuthorityEvidence = await admin.query(
    [
      'SELECT permission_revision, revoke_epoch,',
      '(SELECT count(*)::int FROM console_identity.permission_grant g',
      ' WHERE g.subject_id=a.subject_id AND g.revoked_at IS NULL) AS active_permissions',
      'FROM console_identity.subject_authority a WHERE subject_id=$1',
    ].join(' '),
    [managedCreatedSubjectId],
  );
  assert.deepEqual(managedAuthorityEvidence.rows[0], {
    permission_revision: '1', revoke_epoch: '0', active_permissions: 3,
  });

  const secondLoginResponse = await fetch(origin + '/api/identity/session/login', {
    method: 'POST',
    headers: {
      origin: publicOrigin,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-session-login-0002',
    },
    body: JSON.stringify({ email: 'operator@opensphere.test', password: 'integration-password' }),
  });
  assert.equal(secondLoginResponse.status, 200);
  const secondLoginCookies = secondLoginResponse.headers.getSetCookie();
  const secondSessionCookie = secondLoginCookies.find((value) => value.startsWith('__Host-opensphere-session='));
  const secondCsrfCookie = secondLoginCookies.find((value) => value.startsWith('__Host-opensphere_csrf='));
  assert.ok(secondSessionCookie && secondCsrfCookie);
  const secondCookieHeader = secondSessionCookie.split(';', 1)[0];
  const secondLoginBody = await secondLoginResponse.json();

  const inventoryResponse = await fetch(origin + '/api/identity/sessions', {
    headers: { cookie: loginCookieHeader, 'x-os-correlation-id': 'integration-session-inventory-0001' },
  });
  assert.equal(inventoryResponse.status, 200);
  const inventory = await inventoryResponse.json();
  assert.ok(inventory.items.length <= 100);
  assert.equal(inventory.items.filter((item) => item.current).length, 1);
  assert.equal(inventory.items.find((item) => item.id === loginBody.session.id)?.current, true);
  assert.equal(inventory.items.find((item) => item.id === secondLoginBody.session.id)?.current, false);
  assert.doesNotMatch(JSON.stringify(inventory), /accessToken|refreshToken|csrf|ciphertext|authSessionRef/i);

  const targetedRevokeResponse = await fetch(origin + '/api/identity/sessions/' + secondLoginBody.session.id, {
    method: 'DELETE',
    headers: {
      cookie: loginCookieHeader,
      'x-os-csrf-token': loginCsrf,
      'x-os-correlation-id': 'integration-session-owned-revoke-0001',
    },
  });
  assert.equal(targetedRevokeResponse.status, 204);
  assert.equal(targetedRevokeResponse.headers.getSetCookie().length, 0);
  const targetedRevokedRead = await fetch(origin + '/api/identity/session', {
    headers: { cookie: secondCookieHeader, 'x-os-correlation-id': 'integration-session-owned-revoked-read-0001' },
  });
  assert.equal(targetedRevokedRead.status, 401);
  const targetedRevokeEvidence = await admin.query(
    [
      'SELECT count(*)::int AS event_count,',
      "COALESCE(string_agg(evidence::text, ''), '') AS evidence",
      'FROM console_audit.event',
      "WHERE action = 'console.identity.session.revoke' AND correlation_id = $1",
    ].join(' '),
    ['integration-session-owned-revoke-0001'],
  );
  assert.equal(targetedRevokeEvidence.rows[0].event_count, 1);
  assert.doesNotMatch(targetedRevokeEvidence.rows[0].evidence, /accessToken|refreshToken|csrf|ciphertext/i);

  const issuedLogoutResponse = await fetch(origin + '/api/identity/session', {
    method: 'DELETE',
    headers: {
      cookie: loginCookieHeader,
      'x-os-csrf-token': loginCsrf,
      'x-os-correlation-id': 'integration-issued-session-revoke-0001',
    },
  });
  assert.equal(issuedLogoutResponse.status, 204);
  const issuedRevokedResponse = await fetch(origin + '/api/identity/session', {
    headers: { cookie: loginCookieHeader, 'x-os-correlation-id': 'integration-issued-session-revoked-read-0001' },
  });
  assert.equal(issuedRevokedResponse.status, 401);

  const mfaLoginResponse = await fetch(origin + '/api/identity/session/login', {
    method: 'POST',
    headers: {
      origin: publicOrigin,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-session-mfa-login-0001',
    },
    body: JSON.stringify({ email: 'mfa@opensphere.test', password: 'integration-password' }),
  });
  assert.equal(mfaLoginResponse.status, 200);
  const mfaLoginCookies = mfaLoginResponse.headers.getSetCookie();
  const mfaSessionCookie = mfaLoginCookies.find((value) => value.startsWith('__Host-opensphere-session='));
  const mfaCsrfCookie = mfaLoginCookies.find((value) => value.startsWith('__Host-opensphere_csrf='));
  assert.ok(mfaSessionCookie && mfaCsrfCookie);
  assert.ok(mfaLoginCookies.every((cookie) => cookie.includes('Max-Age=300')));
  const mfaCookieHeader = mfaSessionCookie.split(';', 1)[0];
  const mfaCsrf = decodeURIComponent(mfaCsrfCookie.split(';', 1)[0].split('=', 2)[1]);
  const mfaLoginBody = await mfaLoginResponse.json();
  assert.equal(mfaLoginBody.mfaRequired, true);
  assert.equal(mfaLoginBody.session.status, 'pending_mfa');
  assert.equal(mfaLoginBody.session.assurance, 'aal1');
  const pendingMfaEvidence = await admin.query(
    [
      'SELECT access_token_ciphertext, refresh_token_ciphertext, auth_session_ref, aal, revoke_reason,',
      '(expires_at - created_at) <= interval \'5 minutes\' AS bounded_pending_expiry',
      'FROM console_identity.browser_session WHERE session_id = $1',
    ].join(' '),
    [mfaLoginBody.session.id],
  );
  assert.equal(pendingMfaEvidence.rows[0].aal, 'aal1');
  assert.equal(pendingMfaEvidence.rows[0].revoke_reason, 'pending-mfa');
  assert.equal(pendingMfaEvidence.rows[0].bounded_pending_expiry, true);
  const pendingAccessCiphertext = pendingMfaEvidence.rows[0].access_token_ciphertext;
  const pendingRefreshCiphertext = pendingMfaEvidence.rows[0].refresh_token_ciphertext;

  const mfaCompleteResponse = await fetch(origin + '/api/identity/session/mfa', {
    method: 'POST',
    headers: {
      cookie: mfaCookieHeader,
      'x-os-csrf-token': mfaCsrf,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-session-mfa-complete-0001',
    },
    body: JSON.stringify({ code: '123456' }),
  });
  assert.equal(mfaCompleteResponse.status, 200);
  assert.deepEqual(await mfaCompleteResponse.json(), { assurance: 'aal2', sessionId: mfaLoginBody.session.id });
  const activatedMfaCookies = mfaCompleteResponse.headers.getSetCookie();
  assert.equal(activatedMfaCookies.length, 2);
  assert.ok(activatedMfaCookies.every((cookie) => {
    const seconds = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
    return seconds >= 604790 && seconds <= 604800;
  }));

  const activeMfaEvidence = await admin.query(
    [
      'SELECT access_token_ciphertext, refresh_token_ciphertext, auth_session_ref, aal, revoked_at, revoke_reason,',
      '(SELECT COALESCE(string_agg(evidence::text, \'\'), \'\') FROM console_audit.event',
      "WHERE action = 'console.identity.session.mfa' AND correlation_id = $2) AS audit_evidence",
      'FROM console_identity.browser_session WHERE session_id = $1',
    ].join(' '),
    [mfaLoginBody.session.id, 'integration-session-mfa-complete-0001'],
  );
  assert.equal(activeMfaEvidence.rows[0].aal, 'aal2');
  assert.equal(activeMfaEvidence.rows[0].revoked_at, null);
  assert.equal(activeMfaEvidence.rows[0].revoke_reason, null);
  assert.equal(activeMfaEvidence.rows[0].auth_session_ref, 'supabase-auth-session-mfa-aal2-0001');
  assert.notEqual(activeMfaEvidence.rows[0].access_token_ciphertext, pendingAccessCiphertext);
  assert.notEqual(activeMfaEvidence.rows[0].refresh_token_ciphertext, pendingRefreshCiphertext);
  assert.doesNotMatch(activeMfaEvidence.rows[0].audit_evidence, /supabase-refresh|integration-signature|auth-session-mfa-aal2/i);
  const activeMfaSessionResponse = await fetch(origin + '/api/identity/session', {
    headers: { cookie: mfaCookieHeader, 'x-os-correlation-id': 'integration-session-mfa-read-0001' },
  });
  assert.equal(activeMfaSessionResponse.status, 200);
  assert.equal((await activeMfaSessionResponse.json()).data.aal, 'aal2');
  const mfaLogoutResponse = await fetch(origin + '/api/identity/session', {
    method: 'DELETE',
    headers: {
      cookie: mfaCookieHeader,
      'x-os-csrf-token': mfaCsrf,
      'x-os-correlation-id': 'integration-session-mfa-logout-0001',
    },
  });
  assert.equal(mfaLogoutResponse.status, 204);

  const connectionProjectionResponse = await fetch(
    origin + '/api/admin/extensions/registry-connections/opensphere-ghcr',
    { headers: { cookie: headers.cookie, 'x-os-correlation-id': 'integration-registry-read-0001' } },
  );
  assert.equal(connectionProjectionResponse.status, 200);
  const connectionProjection = await connectionProjectionResponse.json();
  assert.equal(connectionProjection.authority, 'ConsoleRegistryConnectionMetadata');
  assert.equal(connectionProjection.data.connectionId, 'opensphere-ghcr');
  assert.equal(connectionProjection.data.configurationState, 'NotConfigured');
  assert.equal(connectionProjection.data.credentialPresent, false);
  assert.doesNotMatch(JSON.stringify(connectionProjection), /secretRef|credentialDigest|password|token/i);

  const accepted = await mutation();
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get('x-idempotent-replay'), 'false');
  const receipt = await accepted.json();
  assert.equal(receipt.actionId, 'console.registry.connection.replace');
  assert.equal(receipt.state, 'Authorized');
  assert.equal(receipt.correlationId, correlationId);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(credential));

  const replay = await mutation();
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await replay.json()).operationId, receipt.operationId);

  const mismatch = await mutation(JSON.stringify({
    username: 'opensphere-platform',
    credential: 'different-integration-registry-credential',
    reason: 'verify Console API PostgreSQL integration',
  }));
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, 'IdempotencyMismatch');

  const evidence = await admin.query(
    [
      'SELECT',
      '(SELECT count(*)::int FROM console_operation.operation WHERE correlation_id = $1) AS operations,',
      '(SELECT count(*)::int FROM console_operation.outbox o JOIN console_operation.operation p USING(operation_id) WHERE p.correlation_id = $1) AS outbox_events,',
      '(SELECT count(*)::int FROM console_audit.event WHERE correlation_id = $1) AS audit_events,',
      'position($2 in (',
      'COALESCE((SELECT string_agg(row_to_json(p)::text, \'\') FROM console_operation.operation p WHERE p.correlation_id = $1), \'\') ||',
      'COALESCE((SELECT string_agg(o.payload::text, \'\') FROM console_operation.outbox o JOIN console_operation.operation p USING(operation_id) WHERE p.correlation_id = $1), \'\') ||',
      'COALESCE((SELECT string_agg(a.evidence::text, \'\') FROM console_audit.event a WHERE a.correlation_id = $1), \'\')',
      ')) AS credential_position',
    ].join(' '),
    [correlationId, credential],
  );
  assert.deepEqual(evidence.rows[0], {
    operations: 1,
    outbox_events: 1,
    audit_events: 1,
    credential_position: 0,
  });

  const plannedRevocation = await createRevocation();
  assert.equal(plannedRevocation.state, 'Planned');
  assert.equal(plannedRevocation.approvalRequired, true);
  const approvalBody = {
    reason: 'independent approval integration review',
    approvalRevision: policyRevision,
    expectedStateVersion: 0,
    confirmation: null,
  };

  const selfApproval = await approval(plannedRevocation.operationId, approvalBody, {
    cookie: headers.cookie,
    'x-os-csrf-token': csrf,
    'x-os-idempotency-key': 'integration-self-approval-operation-0001',
    'x-os-correlation-id': 'integration-self-approval-correlation-0001',
  });
  assert.equal(selfApproval.status, 403);
  assert.equal((await selfApproval.json()).code, 'PermissionDenied');

  const approved = await approval(plannedRevocation.operationId, approvalBody);
  assert.equal(approved.status, 202);
  assert.equal(approved.headers.get('x-idempotent-replay'), 'false');
  const approvedReceipt = await approved.json();
  assert.equal(approvedReceipt.state, 'Authorized');
  assert.equal(approvedReceipt.stateVersion, 1);
  assert.equal(approvedReceipt.approvalRevision, policyRevision);

  const approvalReplay = await approval(plannedRevocation.operationId, approvalBody);
  assert.equal(approvalReplay.status, 202);
  assert.equal(approvalReplay.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await approvalReplay.json()).operationId, plannedRevocation.operationId);

  const approvalMismatch = await approval(plannedRevocation.operationId, {
    ...approvalBody,
    reason: 'different approval replay content',
  });
  assert.equal(approvalMismatch.status, 409);
  assert.equal((await approvalMismatch.json()).code, 'IdempotencyMismatch');

  const approvalEvidence = await admin.query(
    [
      'SELECT',
      '(SELECT count(*)::int FROM console_operation.approval WHERE operation_id = $1) AS approvals,',
      '(SELECT count(*)::int FROM console_operation.outbox WHERE operation_id = $1) AS outbox_events,',
      '(SELECT count(*)::int FROM console_audit.event WHERE operation_id = $1) AS audit_events,',
      '(SELECT state FROM console_operation.operation WHERE operation_id = $1) AS state,',
      '(SELECT state_version::int FROM console_operation.operation WHERE operation_id = $1) AS state_version'
    ].join(' '),
    [plannedRevocation.operationId],
  );
  assert.deepEqual(approvalEvidence.rows[0], {
    approvals: 1,
    outbox_events: 2,
    audit_events: 2,
    state: 'Authorized',
    state_version: 1,
  });

  await admin.query(
    [
      'UPDATE console_identity.browser_session',
      'SET revoked_at = statement_timestamp(), revoke_reason = $1',
      'WHERE session_id = $2',
    ].join(' '),
    ['integration approver revoke', '66666666-6666-4666-8666-666666666666'],
  );
  const revokedApproval = await approval(plannedRevocation.operationId, approvalBody, {
    'x-os-idempotency-key': 'integration-revoked-approval-operation-0001',
  });
  assert.equal(revokedApproval.status, 401);
  assert.equal((await revokedApproval.json()).code, 'AuthenticationRequired');

  await startExtensionController();
  let executionEvidence;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = await admin.query(
      [
        'SELECT',
        '(SELECT state FROM console_operation.operation WHERE operation_id = $1) AS state,',
        '(SELECT state_version::int FROM console_operation.operation WHERE operation_id = $1) AS state_version,',
        '(SELECT count(*)::int FROM console_operation.execution_receipt WHERE operation_id = $1) AS receipts,',
        '(SELECT count(*)::int FROM console_extension.revocation WHERE operation_id = $1) AS revocations,',
        '(SELECT count(*)::int FROM console_operation.outbox WHERE operation_id = $1 AND delivered_at IS NOT NULL) AS delivered_outbox'
      ].join(' '),
      [plannedRevocation.operationId],
    );
    if (candidate.rows[0].state === 'Applied') {
      executionEvidence = candidate.rows[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(executionEvidence, {
    state: 'Applied',
    state_version: 4,
    receipts: 1,
    revocations: 1,
    delivered_outbox: 1,
  });
  const revocationProjectionResponse = await fetch(origin + '/api/admin/extensions/revocations', {
    headers: {
      cookie: headers.cookie,
      'x-os-correlation-id': 'integration-revocation-projection-0001',
    },
  });
  assert.equal(revocationProjectionResponse.status, 200);
  const revocationProjection = await revocationProjectionResponse.json();
  assert.equal(revocationProjection.authority, 'ConsoleExtensionRevocation');
  assert.equal(revocationProjection.freshness, 'fresh');
  assert.equal(revocationProjection.correlationId, 'integration-revocation-projection-0001');
  assert.equal(
    revocationProjection.data.some((item) => item.imageRef === plannedRevocation.targetRef
      && item.operationId === plannedRevocation.operationId),
    true,
  );

  const verified = await verification(plannedRevocation.operationId, { expectedStateVersion: 4 });
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get('x-idempotent-replay'), 'false');
  const verifiedReceipt = await verified.json();
  assert.equal(verifiedReceipt.state, 'Verified');
  assert.equal(verifiedReceipt.stateVersion, 5);
  assert.equal(verifiedReceipt.observedPostcondition.authority, 'ConsoleExtensionRevocation');

  const verificationReplay = await verification(plannedRevocation.operationId, { expectedStateVersion: 4 });
  assert.equal(verificationReplay.status, 200);
  assert.equal(verificationReplay.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await verificationReplay.json()).state, 'Verified');

  const verificationMismatch = await verification(
    plannedRevocation.operationId,
    { expectedStateVersion: 5 },
  );
  assert.equal(verificationMismatch.status, 409);
  assert.equal((await verificationMismatch.json()).code, 'IdempotencyMismatch');

  const verificationEvidence = await admin.query(
    [
      'SELECT',
      '(SELECT state FROM console_operation.operation WHERE operation_id = $1) AS state,',
      '(SELECT state_version::int FROM console_operation.operation WHERE operation_id = $1) AS state_version,',
      '(SELECT count(*)::int FROM console_operation.verification_receipt WHERE operation_id = $1) AS verifications,',
      '(SELECT count(*)::int FROM console_operation.execution_receipt WHERE operation_id = $1) AS owner_receipts,',
      '(SELECT count(*)::int FROM console_audit.event WHERE operation_id = $1) AS audit_events'
    ].join(' '),
    [plannedRevocation.operationId],
  );
  assert.deepEqual(verificationEvidence.rows[0], {
    state: 'Verified',
    state_version: 5,
    verifications: 1,
    owner_receipts: 1,
    audit_events: 5,
  });

  const auditResponse = await fetch(origin + '/api/identity/audit?limit=2', {
    headers: { cookie: headers.cookie, 'x-os-correlation-id': 'integration-audit-read-page-one' },
  });
  assert.equal(auditResponse.status, 200);
  const auditProjection = await auditResponse.json();
  assert.equal(auditProjection.authority, 'SupabaseAuditLedger');
  assert.equal(auditProjection.data.items.length, 2);
  assert.match(auditProjection.data.nextCursor, /^[1-9][0-9]*$/);
  assert.equal(auditProjection.data.items[0].operationId, plannedRevocation.operationId);
  assert.match(auditProjection.data.items[0].eventHash, /^sha256:[0-9a-f]{64}$/);

  const nextAuditResponse = await fetch(
    origin + '/api/identity/audit?limit=2&cursor=' + auditProjection.data.nextCursor,
    { headers: { cookie: headers.cookie, 'x-os-correlation-id': 'integration-audit-read-page-two' } },
  );
  assert.equal(nextAuditResponse.status, 200);
  const nextAuditProjection = await nextAuditResponse.json();
  assert.equal(nextAuditProjection.data.items.length, 2);
  assert.equal(
    BigInt(nextAuditProjection.data.items[0].sequenceId) < BigInt(auditProjection.data.nextCursor),
    true,
  );

  const installResponse = await fetch(origin + '/api/admin/extensions/install', {
    method: 'POST',
    headers: {
      cookie: headers.cookie,
      'x-os-csrf-token': csrf,
      'content-type': 'application/json',
      'x-os-idempotency-key': 'integration-extension-install-0001',
      'x-os-correlation-id': 'integration-extension-install-correlation-0001',
    },
    body: JSON.stringify({
      descriptorId: 'extension.workspace',
      catalogRevision: installCatalogRevision,
      reason: 'verify exact revision install intake',
    }),
  });
  assert.equal(installResponse.status, 202);
  const installReceipt = await installResponse.json();
  assert.equal(installReceipt.state, 'Planned');
  assert.equal(installReceipt.approvalRequired, true);
  assert.equal(installReceipt.targetRef, installImage);
  const installEvidence = await admin.query(
    [
      'SELECT o.state, o.state_version::int AS state_version,',
      '(SELECT count(*)::int FROM console_operation.outbox x WHERE x.operation_id = o.operation_id) AS outbox_events,',
      "(SELECT count(*)::int FROM console_operation.outbox x WHERE x.operation_id = o.operation_id AND x.event_type = 'OperationAwaitingApproval') AS awaiting_events,",
      "(SELECT count(*)::int FROM console_operation.outbox x WHERE x.operation_id = o.operation_id AND x.event_type = 'OperationReadyForDispatch') AS ready_events,",
      '(SELECT count(*)::int FROM console_audit.event a WHERE a.operation_id = o.operation_id) AS audit_events',
      'FROM console_operation.operation o WHERE o.operation_id = $1',
    ].join(' '),
    [installReceipt.operationId],
  );
  assert.deepEqual(installEvidence.rows[0], {
    state: 'Planned', state_version: 0, outbox_events: 1, awaiting_events: 1, ready_events: 0, audit_events: 1,
  });

  await admin.query(
    'UPDATE console_identity.browser_session SET revoked_at = NULL, revoke_reason = NULL WHERE session_id = $1',
    ['66666666-6666-4666-8666-666666666666'],
  );
  const approvedInstall = await approval(installReceipt.operationId, {
    reason: 'independent install approval integration review',
    approvalRevision: policyRevision,
    expectedStateVersion: 0,
    confirmation: null,
  }, {
    'x-os-idempotency-key': 'integration-extension-install-approval-0001',
    'x-os-correlation-id': 'integration-extension-install-approval-correlation-0001',
  });
  assert.equal(approvedInstall.status, 202);
  assert.equal((await approvedInstall.json()).state, 'Authorized');

  let installExecution;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const observed = await admin.query(
      [
        'SELECT o.state, o.state_version::int AS state_version,',
        "o.observed_postcondition->>'postcondition' AS postcondition,",
        '(SELECT count(*)::int FROM console_operation.execution_receipt x WHERE x.operation_id = o.operation_id) AS receipts,',
        '(SELECT count(*)::int FROM console_operation.outbox x WHERE x.operation_id = o.operation_id AND x.delivered_at IS NOT NULL) AS delivered_outbox',
        'FROM console_operation.operation o WHERE o.operation_id = $1',
      ].join(' '),
      [installReceipt.operationId],
    );
    if (observed.rows[0].state === 'Applied' && observed.rows[0].receipts === 2) {
      installExecution = observed.rows[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(installExecution, {
    state: 'Applied', state_version: 4, postcondition: 'RegistrationPresent', receipts: 2, delivered_outbox: 2,
  });
  assert.equal(registration?.spec?.packageRef?.name, 'workspace');
  assert.equal(registration?.spec?.desiredState, 'Installed');
  assert.equal(registration?.spec?.installation?.operationId, installReceipt.operationId);

  const verifiedInstall = await verification(
    installReceipt.operationId,
    { expectedStateVersion: 4 },
    {
      'x-os-idempotency-key': 'integration-install-verification-operation-0001',
      'x-os-correlation-id': 'integration-install-verification-correlation-0001',
    },
  );
  assert.equal(verifiedInstall.status, 200);
  const verifiedInstallReceipt = await verifiedInstall.json();
  assert.equal(verifiedInstallReceipt.state, 'Verified');
  assert.equal(verifiedInstallReceipt.stateVersion, 5);
  assert.equal(verifiedInstallReceipt.observedPostcondition.authority, 'KubernetesUIPluginRegistration');
  assert.equal(verifiedInstallReceipt.observedPostcondition.postcondition, 'InstallReady');
  const installVerificationEvidence = await admin.query(
    [
      'SELECT o.state, o.state_version::int AS state_version,',
      "o.observed_postcondition->>'postcondition' AS postcondition,",
      '(SELECT count(*)::int FROM console_operation.verification_receipt v WHERE v.operation_id = o.operation_id) AS verifications,',
      '(SELECT count(*)::int FROM console_operation.execution_receipt x WHERE x.operation_id = o.operation_id) AS owner_receipts',
      'FROM console_operation.operation o WHERE o.operation_id = $1',
    ].join(' '),
    [installReceipt.operationId],
  );
  assert.deepEqual(installVerificationEvidence.rows[0], {
    state: 'Verified', state_version: 5, postcondition: 'InstallReady', verifications: 1, owner_receipts: 2,
  });

  const removeResponse = await fetch(origin + '/api/admin/extensions/remove', {
    method: 'POST',
    headers: {
      cookie: headers.cookie,
      'x-os-csrf-token': csrf,
      'content-type': 'application/json',
      'x-os-idempotency-key': 'integration-extension-remove-0001',
      'x-os-correlation-id': 'integration-extension-remove-correlation-0001',
    },
    body: JSON.stringify({
      descriptorId: 'extension.workspace',
      reason: 'verify exact Registration removal',
      confirmation: 'REMOVE extension.workspace',
    }),
  });
  assert.equal(removeResponse.status, 202);
  const removeReceipt = await removeResponse.json();
  assert.equal(removeReceipt.state, 'Planned');
  assert.equal(removeReceipt.actionId, 'console.extension.remove');
  assert.equal(removeReceipt.targetRef, 'extension.workspace');

  const approvedRemove = await approval(removeReceipt.operationId, {
    reason: 'independent removal approval integration review',
    approvalRevision: policyRevision,
    expectedStateVersion: 0,
    confirmation: null,
  }, {
    'x-os-idempotency-key': 'integration-extension-remove-approval-0001',
    'x-os-correlation-id': 'integration-extension-remove-approval-correlation-0001',
  });
  assert.equal(approvedRemove.status, 202);
  assert.equal((await approvedRemove.json()).state, 'Authorized');

  let removeExecution;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const observed = await admin.query(
      [
        'SELECT o.state, o.state_version::int AS state_version,',
        "o.observed_postcondition->>'postcondition' AS postcondition,",
        '(SELECT count(*)::int FROM console_operation.execution_receipt x WHERE x.operation_id = o.operation_id) AS receipts,',
        '(SELECT count(*)::int FROM console_operation.outbox x WHERE x.operation_id = o.operation_id AND x.delivered_at IS NOT NULL) AS delivered_outbox',
        'FROM console_operation.operation o WHERE o.operation_id = $1',
      ].join(' '),
      [removeReceipt.operationId],
    );
    if (observed.rows[0].state === 'Applied' && observed.rows[0].receipts === 2) {
      removeExecution = observed.rows[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(removeExecution, {
    state: 'Applied', state_version: 4, postcondition: 'RemovalRequested', receipts: 2, delivered_outbox: 2,
  });
  assert.equal(registration, null);

  const verifiedRemove = await verification(
    removeReceipt.operationId,
    { expectedStateVersion: 4 },
    {
      'x-os-idempotency-key': 'integration-remove-verification-operation-0001',
      'x-os-correlation-id': 'integration-remove-verification-correlation-0001',
    },
  );
  assert.equal(verifiedRemove.status, 200);
  const verifiedRemoveReceipt = await verifiedRemove.json();
  assert.equal(verifiedRemoveReceipt.state, 'Verified');
  assert.equal(verifiedRemoveReceipt.stateVersion, 5);
  assert.equal(verifiedRemoveReceipt.observedPostcondition.postcondition, 'RegistrationAbsent');
  const removeVerificationEvidence = await admin.query(
    [
      'SELECT o.state, o.state_version::int AS state_version,',
      "o.observed_postcondition->>'postcondition' AS postcondition,",
      '(SELECT count(*)::int FROM console_operation.verification_receipt v WHERE v.operation_id = o.operation_id) AS verifications,',
      '(SELECT count(*)::int FROM console_operation.execution_receipt x WHERE x.operation_id = o.operation_id) AS owner_receipts',
      'FROM console_operation.operation o WHERE o.operation_id = $1',
    ].join(' '),
    [removeReceipt.operationId],
  );
  assert.deepEqual(removeVerificationEvidence.rows[0], {
    state: 'Verified', state_version: 5, postcondition: 'RegistrationAbsent', verifications: 1, owner_receipts: 2,
  });

  const supabaseStatusResponse = await fetch(origin + '/api/identity/supabase/status', {
    headers: { cookie: headers.cookie, 'x-os-correlation-id': 'integration-supabase-status-0001' },
  });
  assert.equal(supabaseStatusResponse.status, 200);
  const supabaseStatus = await supabaseStatusResponse.json();
  assert.equal(supabaseStatus.authority, 'Supabase');
  assert.equal(supabaseStatus.data.state, 'Degraded');
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'database').state, 'Ready');
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'auth').state, 'Ready');
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'dataApi').state, 'Ready');
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'storage').state, 'Ready');
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'migration').state, 'Ready');
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'migration').baselineRevision, migrationManifest.latestGlobalId);
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'migration').setDigest, migrationManifest.setDigest);
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'migration').migrationCount, migrationManifest.migrationCount);
  assert.equal(supabaseStatus.data.components.find(({ component }) => component === 'rls').state, 'Ready');

  const sessionProjectionResponse = await fetch(origin + '/api/identity/session', {
    headers: { cookie: headers.cookie, 'x-os-correlation-id': 'integration-session-read-0001' },
  });
  assert.equal(sessionProjectionResponse.status, 200);
  const sessionProjection = await sessionProjectionResponse.json();
  assert.equal(sessionProjection.authority, 'SupabaseAuth');
  assert.equal(sessionProjection.data.state, 'Active');
  assert.equal(sessionProjection.data.subjectId, '11111111-1111-4111-8111-111111111111');

  const actorProjectionResponse = await fetch(origin + '/api/identity/me', {
    headers: { cookie: headers.cookie, 'x-os-correlation-id': 'integration-actor-read-0001' },
  });
  assert.equal(actorProjectionResponse.status, 200);
  const actorProjection = await actorProjectionResponse.json();
  assert.equal(actorProjection.authority, 'SupabaseAuth');
  assert.equal(actorProjection.data.permissions.includes('console.audit.read'), true);
  assert.doesNotMatch(JSON.stringify(actorProjection.data), /sessionId|token|cookie|csrf/i);

  const logoutResponse = await fetch(origin + '/api/identity/session', {
    method: 'DELETE',
    headers: {
      cookie: headers.cookie,
      'x-os-csrf-token': csrf,
      'x-os-correlation-id': 'integration-session-revoke-0001',
    },
  });
  assert.equal(logoutResponse.status, 204);
  const expiredCookies = logoutResponse.headers.getSetCookie();
  assert.equal(expiredCookies.length, 2);
  assert.match(expiredCookies[0], /^__Host-opensphere-session=;/);
  assert.match(expiredCookies[1], /^__Host-opensphere_csrf=;/);
  assert.ok(expiredCookies.every((cookie) => cookie.includes('Max-Age=0')));
  const revoked = await mutation(body, { ...headers, 'x-os-idempotency-key': 'integration-registry-operation-0002' });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).code, 'AuthenticationRequired');

  const bulkLogin = async (correlation) => {
    const response = await fetch(origin + '/api/identity/session/login', {
      method: 'POST',
      headers: { origin: publicOrigin, 'content-type': 'application/json', 'x-os-correlation-id': correlation },
      body: JSON.stringify({ email: 'operator@opensphere.test', password: 'integration-password' }),
    });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    return {
      cookie: cookies.find((value) => value.startsWith('__Host-opensphere-session=')).split(';', 1)[0],
      csrf: decodeURIComponent(cookies.find((value) => value.startsWith('__Host-opensphere_csrf='))
        .split(';', 1)[0].split('=', 2)[1]),
    };
  };
  const bulkCurrent = await bulkLogin('integration-session-bulk-login-0001');
  const bulkOther = await bulkLogin('integration-session-bulk-login-0002');
  const bulkRevokeResponse = await fetch(origin + '/api/identity/sessions', {
    method: 'DELETE',
    headers: {
      cookie: bulkCurrent.cookie,
      'x-os-csrf-token': bulkCurrent.csrf,
      'x-os-correlation-id': 'integration-session-owned-revoke-all-0001',
    },
  });
  assert.equal(bulkRevokeResponse.status, 204);
  assert.equal(bulkRevokeResponse.headers.getSetCookie().length, 2);
  for (const cookie of [bulkCurrent.cookie, bulkOther.cookie]) {
    const response = await fetch(origin + '/api/identity/session', {
      headers: { cookie, 'x-os-correlation-id': 'integration-session-bulk-revoked-read-0001' },
    });
    assert.equal(response.status, 401);
  }

  const recoverySessionOne = await bulkLogin('integration-session-recovery-login-0001');
  const recoverySessionTwo = await bulkLogin('integration-session-recovery-login-0002');
  const recoveryBefore = await admin.query(
    [
      'SELECT a.revoke_epoch,',
      '(SELECT count(*)::int FROM console_identity.browser_session s',
      'WHERE s.subject_id = a.subject_id AND s.revoked_at IS NULL) AS active_sessions,',
      '(SELECT count(*)::int FROM console_audit.event e',
      "WHERE e.correlation_id = 'integration-password-recovery-complete-0001') AS recovery_events",
      'FROM console_identity.subject_authority a WHERE a.subject_id = $1',
    ].join(' '),
    [loginSubjectId],
  );
  assert.ok(recoveryBefore.rows[0].active_sessions >= 2);
  assert.equal(recoveryBefore.rows[0].recovery_events, 0);

  const ordinaryRecoveryAttempt = await fetch(origin + '/api/identity/password/recovery', {
    method: 'POST',
    headers: {
      origin: publicOrigin,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-password-recovery-ordinary-token-0001',
    },
    body: JSON.stringify({
      recoveryAccessToken: rotatedLoginAccessToken,
      password: 'rejected-integration-password',
    }),
  });
  assert.equal(ordinaryRecoveryAttempt.status, 401);
  assert.equal((await ordinaryRecoveryAttempt.json()).code, 'RecoveryRejected');
  const ordinaryRecoveryEvidence = await admin.query(
    [
      'SELECT a.revoke_epoch,',
      '(SELECT count(*)::int FROM console_identity.browser_session s',
      'WHERE s.subject_id = a.subject_id AND s.revoked_at IS NULL) AS active_sessions,',
      '(SELECT count(*)::int FROM console_audit.event e',
      "WHERE e.correlation_id = 'integration-password-recovery-ordinary-token-0001') AS recovery_events",
      'FROM console_identity.subject_authority a WHERE a.subject_id = $1',
    ].join(' '),
    [loginSubjectId],
  );
  assert.equal(ordinaryRecoveryEvidence.rows[0].revoke_epoch, recoveryBefore.rows[0].revoke_epoch);
  assert.equal(ordinaryRecoveryEvidence.rows[0].active_sessions, recoveryBefore.rows[0].active_sessions);
  assert.equal(ordinaryRecoveryEvidence.rows[0].recovery_events, 0);

  const recoveryResponse = await fetch(origin + '/api/identity/password/recovery', {
    method: 'POST',
    headers: {
      origin: publicOrigin,
      'content-type': 'application/json',
      'x-os-correlation-id': 'integration-password-recovery-complete-0001',
    },
    body: JSON.stringify({
      recoveryAccessToken,
      password: 'recovered-integration-password',
    }),
  });
  assert.equal(recoveryResponse.status, 204);
  assert.equal(recoveryPasswordChanged, true);
  assert.equal(recoverySessionLoggedOut, true);
  const recoveryCookies = recoveryResponse.headers.getSetCookie();
  assert.equal(recoveryCookies.length, 2);
  assert.ok(recoveryCookies.every((cookie) => cookie.includes('Max-Age=0')));

  const recoveryEvidence = await admin.query(
    [
      'SELECT a.revoke_epoch,',
      '(SELECT count(*)::int FROM console_identity.browser_session s',
      'WHERE s.subject_id = a.subject_id AND s.revoked_at IS NULL) AS active_sessions,',
      '(SELECT count(*)::int FROM console_identity.browser_session s',
      "WHERE s.subject_id = a.subject_id AND s.revoke_reason = 'password-recovery') AS recovered_sessions,",
      '(SELECT count(*)::int FROM console_audit.event e',
      "WHERE e.correlation_id = 'integration-password-recovery-complete-0001'",
      "AND e.action = 'console.identity.password.recovery.sessions_revoked') AS recovery_events,",
      '(SELECT COALESCE(string_agg(e.evidence::text, \'\'), \'\') FROM console_audit.event e',
      "WHERE e.correlation_id = 'integration-password-recovery-complete-0001') AS audit_evidence",
      'FROM console_identity.subject_authority a WHERE a.subject_id = $1',
    ].join(' '),
    [loginSubjectId],
  );
  assert.equal(Number(recoveryEvidence.rows[0].revoke_epoch), Number(recoveryBefore.rows[0].revoke_epoch) + 1);
  assert.equal(recoveryEvidence.rows[0].active_sessions, 0);
  assert.ok(recoveryEvidence.rows[0].recovered_sessions >= recoveryBefore.rows[0].active_sessions);
  assert.equal(recoveryEvidence.rows[0].recovery_events, 1);
  assert.match(recoveryEvidence.rows[0].audit_evidence,
    new RegExp('"revokedCount":\\s*' + recoveryBefore.rows[0].active_sessions));
  assert.doesNotMatch(recoveryEvidence.rows[0].audit_evidence,
    /recovered-integration-password|recoveryAccessToken|integration-signature|operator@opensphere[.]test/i);
  for (const cookie of [recoverySessionOne.cookie, recoverySessionTwo.cookie]) {
    const response = await fetch(origin + '/api/identity/session', {
      headers: { cookie, 'x-os-correlation-id': 'integration-password-recovery-revoked-read-0001' },
    });
    assert.equal(response.status, 401);
  }

  process.stdout.write(JSON.stringify({
    status: 'passed',
    operationId: receipt.operationId,
    durableCounts: evidence.rows[0],
    registryConnectionProjection: true,
    replay: true,
    idempotencyMismatch: true,
    approval: approvalEvidence.rows[0],
    selfApprovalDenied: true,
    revokedApprovalDenied: true,
    extensionExecution: executionEvidence,
    revocationProjection: true,
    verification: verificationEvidence.rows[0],
    auditProjection: true,
    extensionInstallExecution: installExecution,
    extensionInstallVerification: installVerificationEvidence.rows[0],
    extensionRemoveExecution: removeExecution,
    extensionRemoveVerification: removeVerificationEvidence.rows[0],
    supabaseStatusProjection: true,
    supabaseLiveProbes: true,
    migrationLineage: true,
    initialAdministratorBootstrapStatus: true,
    passwordLoginSessionLifecycle: true,
    sessionPreferenceLifecycle: true,
    profileAvatarLifecycle: true,
    ownedPasswordRecoveryLinkLifecycle: true,
    sessionEventHistory: true,
    refreshRotationLifecycle: true,
    activityTouchLifecycle: true,
    sessionInventoryLifecycle: true,
    ownedSessionRevocationLifecycle: true,
    mfaLoginChallengeLifecycle: true,
    mfaEnrollmentLifecycle: true,
    privilegedStepUpLifecycle: true,
    managedIdentityRoleLifecycle: true,
    managedIdentityLifecycle: true,
    identityProjection: true,
    sessionSelfRevoke: true,
    passwordRecoveryLifecycle: true,
    revokeDenied: true,
  }) + '\n');
} finally {
  await admin.query(
    [
      'UPDATE console_identity.browser_session',
      'SET revoked_at = NULL, revoke_reason = NULL',
      'WHERE session_id = $1',
    ].join(' '),
    ['22222222-2222-4222-8222-222222222222'],
  ).catch(() => {});
  await admin.query(
    [
      'UPDATE console_identity.browser_session',
      'SET revoked_at = NULL, revoke_reason = NULL',
      'WHERE session_id = $1',
    ].join(' '),
    ['66666666-6666-4666-8666-666666666666'],
  ).catch(() => {});
  await admin.end().catch(() => {});
  if (extensionChild && extensionChild.exitCode == null) extensionChild.kill('SIGTERM');
  if (extensionChild) {
    await Promise.race([
      new Promise((resolve) => extensionChild.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (extensionChild.exitCode == null) extensionChild.kill('SIGKILL');
  }
  if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
  await new Promise((resolve) => authorityServer.close(resolve));
  await rm(serviceAccountDirectory, { recursive: true, force: true });
}
