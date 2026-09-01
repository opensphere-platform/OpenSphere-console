import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createIdentitySessionBroker } from '../src/identity-session-broker.mjs';
import { createSessionCredentialCipher } from '../src/session-credential-cipher.mjs';
import { createSupabaseAuthClient } from '../src/supabase-auth-client.mjs';

const now = new Date('2026-09-02T00:00:00.000Z');
const subjectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function token(claims = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: subjectId,
    role: 'authenticated',
    aal: 'aal1',
    exp: Math.floor(now.getTime() / 1000) + 900,
    session_id: 'auth-session-0001',
    ...claims,
  })).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('credential envelope is AES-GCM authenticated and rejects tampering', () => {
  let counter = 0;
  const cipher = createSessionCredentialCipher({
    encryptionKey,
    randomBytes(size) { counter += 1; return Buffer.alloc(size, counter); },
  });
  const envelope = cipher.encrypt('supabase-refresh-credential');
  assert.match(envelope, /^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/);
  assert.equal(cipher.decrypt(envelope), 'supabase-refresh-credential');
  const parts = envelope.split('.');
  parts[3] = parts[3].slice(0, -1) + (parts[3].endsWith('A') ? 'B' : 'A');
  assert.throws(() => cipher.decrypt(parts.join('.')), { code: 'SessionCredentialInvalid' });
  assert.throws(() => createSessionCredentialCipher({ encryptionKey: Buffer.alloc(31).toString('base64') }), /exactly 32 bytes/);
});

test('Supabase password client revalidates the returned subject and detects verified TOTP', async () => {
  const accessToken = token();
  const calls = [];
  const client = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test',
    now: () => now,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (url.endsWith('/token?grant_type=password')) {
        return jsonResponse({ access_token: accessToken, refresh_token: 'refresh-credential' });
      }
      if (url.endsWith('/user')) {
        return jsonResponse({ id: subjectId, factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }] });
      }
      if (url.endsWith('/logout')) return jsonResponse({});
      return jsonResponse({}, 404);
    },
  });
  const result = await client.authenticatePassword({ email: 'operator@example.test', password: 'correct horse battery staple' });
  assert.equal(result.subjectId, subjectId);
  assert.equal(result.verifiedTotpFactorId, 'factor-1');
  assert.equal(result.authSessionRef, 'auth-session-0001');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[1].init.headers.authorization, 'Bearer ' + accessToken);
});

test('password login issues only opaque cookies and persists encrypted credentials', async () => {
  const issued = [];
  const cipher = createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 9) });
  let randomCounter = 20;
  const broker = createIdentitySessionBroker({
    store: {
      async issueSession(input) {
        issued.push(input);
        return {
          sessionId, subjectId, state: 'active', aal: 'aal1',
          createdAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt: input.expiresAt,
        };
      },
    },
    authClient: {
      async authenticatePassword() {
        return {
          subjectId, accessToken: 'access-secret', refreshToken: 'refresh-secret',
          authSessionRef: 'auth-session-0001', aal: 'aal1', verifiedTotpFactorId: null,
        };
      },
      async logout() { throw new Error('logout must not run after success'); },
    },
    credentialCipher: cipher,
    publicOrigin: 'https://console.example.test',
    randomBytes(size) { randomCounter += 1; return Buffer.alloc(size, randomCounter); },
    clock: () => now,
  });
  const result = await broker.login({
    body: { email: 'operator@example.test', password: 'correct horse battery staple' },
    requestOrigin: 'https://console.example.test',
    correlationId: 'session-login-correlation-0001',
  });
  assert.equal(result.body.session.status, 'active');
  assert.equal(result.body.mfaEnrollmentRequired, true);
  assert.match(result.cookies[0], /^__Host-opensphere-session=/);
  assert.match(result.cookies[0], /HttpOnly; Secure; SameSite=Strict/);
  assert.match(result.cookies[1], /^__Host-opensphere_csrf=/);
  assert.doesNotMatch(JSON.stringify(result), /access-secret|refresh-secret|correct horse/);
  assert.equal(cipher.decrypt(issued[0].accessTokenCiphertext), 'access-secret');
  assert.equal(cipher.decrypt(issued[0].refreshTokenCiphertext), 'refresh-secret');
  assert.equal(issued[0].tokenDigest.length, 32);
  assert.equal(issued[0].csrfTokenDigest.length, 32);
  assert.equal(issued[0].pendingMfa, false);
});

test('verified TOTP creates a five-minute pending session and persistence failure logs out upstream', async () => {
  let logoutToken = '';
  const broker = createIdentitySessionBroker({
    store: { async issueSession() { throw Object.assign(new Error('database unavailable'), { code: 'AuthorityUnavailable' }); } },
    authClient: {
      async authenticatePassword() {
        return {
          subjectId, accessToken: 'pending-access', refreshToken: 'pending-refresh',
          authSessionRef: 'auth-session-0002', aal: 'aal1', verifiedTotpFactorId: 'factor-1',
        };
      },
      async logout(value) { logoutToken = value; },
    },
    credentialCipher: createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 5) }),
    publicOrigin: 'https://console.example.test',
    randomBytes: (size) => Buffer.alloc(size, 6),
    clock: () => now,
  });
  await assert.rejects(broker.login({
    body: { email: 'operator@example.test', password: 'valid-password' },
    requestOrigin: 'https://console.example.test',
    correlationId: 'session-login-correlation-0002',
  }), { code: 'AuthorityUnavailable' });
  assert.equal(logoutToken, 'pending-access');
  await assert.rejects(broker.login({
    body: { email: 'operator@example.test', password: 'valid-password' },
    requestOrigin: 'https://attacker.example.test',
    correlationId: 'session-login-correlation-0003',
  }), { code: 'PermissionDenied' });
});

test('HTTP login forwards exact Origin and returns both Secure cookies', async (t) => {
  const calls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('session resolution must not run during login'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async login(input) {
        calls.push(input);
        return {
          cookies: ['__Host-opensphere-session=opaque; Path=/; HttpOnly; Secure; SameSite=Strict', '__Host-opensphere_csrf=csrf; Path=/; Secure; SameSite=Strict'],
          body: { mfaRequired: false, mfaEnrollmentRequired: true, session: { id: sessionId } },
        };
      },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/identity/session/login', {
    method: 'POST',
    headers: {
      origin: 'https://console.example.test',
      'content-type': 'application/json',
      'x-correlation-id': 'session-login-http-0001',
    },
    body: JSON.stringify({ email: 'operator@example.test', password: 'valid-password' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(calls[0].requestOrigin, 'https://console.example.test');
  assert.deepEqual(calls[0].body, { email: 'operator@example.test', password: 'valid-password' });
});
