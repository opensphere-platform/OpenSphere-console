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
        return jsonResponse({
          id: subjectId,
          user_metadata: { console_session_persistence: '7d' },
          factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
        });
      }
      if (url.endsWith('/logout')) return jsonResponse({});
      return jsonResponse({}, 404);
    },
  });
  const result = await client.authenticatePassword({ email: 'operator@example.test', password: 'correct horse battery staple' });
  assert.equal(result.subjectId, subjectId);
  assert.equal(result.verifiedTotpFactorId, 'factor-1');
  assert.equal(result.authSessionRef, 'auth-session-0001');
  assert.equal(result.sessionPersistence, '7d');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[1].init.headers.authorization, 'Bearer ' + accessToken);
});

test('Supabase MFA client binds the verified factor and returns only an aal2 session', async () => {
  const accessToken = token();
  const aal2Token = token({ aal: 'aal2', session_id: 'auth-session-aal2' });
  const calls = [];
  const client = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test',
    now: () => now,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (url.endsWith('/user')) {
        const bearer = init.headers.authorization;
        return jsonResponse({
          id: subjectId,
          factors: bearer === 'Bearer ' + accessToken
            ? [{ id: 'factor/1', factor_type: 'totp', status: 'verified' }]
            : [],
        });
      }
      if (url.endsWith('/factors/factor%2F1/challenge')) return jsonResponse({ id: 'challenge-1' });
      if (url.endsWith('/factors/factor%2F1/verify')) {
        assert.deepEqual(JSON.parse(init.body), { challenge_id: 'challenge-1', code: '123456' });
        return jsonResponse({ access_token: aal2Token, refresh_token: 'refresh-aal2' });
      }
      return jsonResponse({}, 404);
    },
  });
  const completed = await client.completeTotp({ accessToken, code: '123456', expectedSubjectId: subjectId });
  assert.equal(completed.aal, 'aal2');
  assert.equal(completed.authSessionRef, 'auth-session-aal2');
  assert.equal(completed.refreshToken, 'refresh-aal2');
  assert.equal(calls.filter(({ url }) => url.endsWith('/user')).length, 2);
});

test('Supabase refresh client rotates only to the same verified subject', async () => {
  const rotatedAccessToken = token({ exp: Math.floor(now.getTime() / 1000) + 3600, session_id: 'auth-session-rotated' });
  const client = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', now: () => now,
    async fetchImpl(url, init) {
      assert.ok(url.endsWith('/token?grant_type=refresh_token'));
      assert.deepEqual(JSON.parse(init.body), { refresh_token: 'refresh-before-rotation' });
      return jsonResponse({
        access_token: rotatedAccessToken,
        refresh_token: 'refresh-after-rotation',
        user: { id: subjectId },
      });
    },
  });
  const refreshed = await client.refreshSession({ refreshToken: 'refresh-before-rotation', expectedSubjectId: subjectId });
  assert.equal(refreshed.authSessionRef, 'auth-session-rotated');
  assert.equal(refreshed.refreshToken, 'refresh-after-rotation');
  assert.equal(refreshed.accessTokenExpiresAt, '2026-09-02T01:00:00.000Z');
});

test('password login issues only opaque cookies and persists encrypted credentials', async () => {
  const issued = [];
  const cipher = createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 9) });
  let randomCounter = 20;
  const broker = createIdentitySessionBroker({
    store: {
      async resolveSession() { throw new Error('session resolution must not run during password login'); },
      async issueSession(input) {
        issued.push(input);
        return {
          sessionId, subjectId, state: 'active', aal: 'aal1',
          persistence: input.persistence,
          createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
          idleExpiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
          absoluteExpiresAt: input.absoluteExpiresAt,
        };
      },
      async getPendingMfa() { throw new Error('pending MFA read must not run during password login'); },
      async activateMfa() { throw new Error('MFA activation must not run during password login'); },
      async getRefreshCredentials() { throw new Error('refresh read must not run during password login'); },
      async rotateCredentials() { throw new Error('refresh rotation must not run during password login'); },
      async rejectRefresh() { throw new Error('refresh rejection must not run during password login'); },
      async touchActivity() { throw new Error('activity touch must not run during password login'); },
    },
    authClient: {
      async authenticatePassword() {
        return {
          subjectId, accessToken: 'access-secret', refreshToken: 'refresh-secret',
          authSessionRef: 'auth-session-0001', aal: 'aal1',
          accessTokenExpiresAt: '2026-09-02T01:00:00.000Z', verifiedTotpFactorId: null,
        };
      },
      async completeTotp() { throw new Error('MFA completion must not run during password login'); },
      async refreshSession() { throw new Error('refresh must not run during password login'); },
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
  assert.equal(issued[0].persistence, '24h');
  assert.equal(issued[0].absoluteExpiresAt, '2026-09-03T00:00:00.000Z');
  assert.equal(result.body.session.idleExpiresAt, '2026-09-02T12:00:00.000Z');
  assert.equal(result.body.session.absoluteExpiresAt, '2026-09-03T00:00:00.000Z');
  assert.match(result.cookies[0], /Max-Age=86400/);
});

test('browser persistence keeps cookies session-only while retaining a bounded 24-hour authority lifetime', async () => {
  let issuedInput;
  const broker = createIdentitySessionBroker({
    store: {
      async resolveSession() { throw new Error('resolve must not run'); },
      async issueSession(input) {
        issuedInput = input;
        return {
          sessionId, subjectId, state: 'active', aal: 'aal1', persistence: input.persistence,
          createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
          idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: input.absoluteExpiresAt,
        };
      },
      async getPendingMfa() { throw new Error('MFA must not run'); },
      async activateMfa() { throw new Error('MFA must not run'); },
      async getRefreshCredentials() { throw new Error('refresh must not run'); },
      async rotateCredentials() { throw new Error('refresh must not run'); },
      async rejectRefresh() { throw new Error('refresh must not run'); },
      async touchActivity() { throw new Error('touch must not run'); },
    },
    authClient: {
      async authenticatePassword() {
        return {
          subjectId, accessToken: 'access-secret', refreshToken: 'refresh-secret',
          authSessionRef: 'auth-session-browser', aal: 'aal1',
          accessTokenExpiresAt: '2026-09-02T01:00:00.000Z', sessionPersistence: 'browser',
          verifiedTotpFactorId: null,
        };
      },
      async completeTotp() { throw new Error('MFA must not run'); },
      async refreshSession() { throw new Error('refresh must not run'); },
      async logout() {},
    },
    credentialCipher: createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 11) }),
    publicOrigin: 'https://console.example.test',
    randomBytes: (size) => Buffer.alloc(size, 12),
    clock: () => now,
  });
  const result = await broker.login({
    body: { email: 'operator@example.test', password: 'valid-password' },
    requestOrigin: 'https://console.example.test',
    correlationId: 'session-login-browser-policy-0001',
  });
  assert.equal(issuedInput.persistence, 'browser');
  assert.equal(issuedInput.absoluteExpiresAt, '2026-09-03T00:00:00.000Z');
  assert.equal(result.body.session.idleExpiresAt, '2026-09-02T12:00:00.000Z');
  assert.equal(result.cookies.every((value) => !value.includes('Max-Age=')), true);
});

test('verified TOTP creates a five-minute pending session and persistence failure logs out upstream', async () => {
  let logoutToken = '';
  const broker = createIdentitySessionBroker({
    store: {
      async resolveSession() { throw new Error('session resolution must not run during password login'); },
      async issueSession() { throw Object.assign(new Error('database unavailable'), { code: 'AuthorityUnavailable' }); },
      async getPendingMfa() { throw new Error('pending MFA read must not run during password login'); },
      async activateMfa() { throw new Error('MFA activation must not run during password login'); },
      async getRefreshCredentials() { throw new Error('refresh read must not run during password login'); },
      async rotateCredentials() { throw new Error('refresh rotation must not run during password login'); },
      async rejectRefresh() { throw new Error('refresh rejection must not run during password login'); },
      async touchActivity() { throw new Error('activity touch must not run during password login'); },
    },
    authClient: {
      async authenticatePassword() {
        return {
          subjectId, accessToken: 'pending-access', refreshToken: 'pending-refresh',
          authSessionRef: 'auth-session-0002', aal: 'aal1',
          accessTokenExpiresAt: '2026-09-02T01:00:00.000Z', verifiedTotpFactorId: 'factor-1',
        };
      },
      async completeTotp() { throw new Error('MFA completion must not run during password login'); },
      async refreshSession() { throw new Error('refresh must not run during password login'); },
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

test('pending MFA completion activates the same opaque session and extends both cookies', async () => {
  const cipher = createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 8) });
  const pendingAccessCiphertext = cipher.encrypt('pending-access');
  const activated = [];
  const broker = createIdentitySessionBroker({
    store: {
      async resolveSession() { throw new Error('session resolution must not run during MFA completion'); },
      async issueSession() { throw new Error('password login must not run during MFA completion'); },
      async getPendingMfa(input) {
        assert.equal(input.tokenDigest.length, 32);
        assert.equal(input.csrfTokenDigest.length, 32);
        return {
          sessionId,
          subjectId,
          accessTokenCiphertext: pendingAccessCiphertext,
          refreshTokenCiphertext: cipher.encrypt('pending-refresh'),
          authSessionRef: 'auth-session-pending',
          aal: 'aal1',
          persistence: '24h',
          absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
        };
      },
      async activateMfa(input) {
        activated.push(input);
        return {
          sessionId,
          subjectId,
          state: 'active',
          aal: 'aal2',
          persistence: '24h',
          idleExpiresAt: '2026-09-02T12:00:00.000Z',
          absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
        };
      },
      async getRefreshCredentials() { throw new Error('refresh read must not run during MFA completion'); },
      async rotateCredentials() { throw new Error('refresh rotation must not run during MFA completion'); },
      async rejectRefresh() { throw new Error('refresh rejection must not run during MFA completion'); },
      async touchActivity() { throw new Error('activity touch must not run during MFA completion'); },
    },
    authClient: {
      async authenticatePassword() { throw new Error('password login must not run during MFA completion'); },
      async completeTotp(input) {
        assert.deepEqual(input, { accessToken: 'pending-access', code: '123456', expectedSubjectId: subjectId });
        return {
          subjectId,
          accessToken: 'aal2-access',
          refreshToken: 'aal2-refresh',
          authSessionRef: 'auth-session-aal2',
          aal: 'aal2',
          accessTokenExpiresAt: '2026-09-02T01:00:00.000Z',
        };
      },
      async refreshSession() { throw new Error('refresh must not run during MFA completion'); },
      async logout() { throw new Error('logout must not run after success'); },
    },
    credentialCipher: cipher,
    publicOrigin: 'https://console.example.test',
    clock: () => now,
  });
  const result = await broker.completeMfa({
    request: {
      headers: {
        cookie: '__Host-opensphere-session=opaque-session-handle-for-mfa-completion',
        'x-os-csrf-token': 'csrf-proof-for-mfa-completion',
      },
    },
    body: { code: '123456' },
    correlationId: 'session-mfa-correlation-0001',
  });
  assert.deepEqual(result.body, { assurance: 'aal2', sessionId });
  assert.equal(result.cookies.length, 2);
  assert.match(result.cookies[0], /Max-Age=86400/);
  assert.match(result.cookies[1], /Max-Age=86400/);
  assert.equal(activated.length, 1);
  assert.equal(activated[0].expectedAccessCiphertextDigest.length, 32);
  assert.equal(cipher.decrypt(activated[0].accessTokenCiphertext), 'aal2-access');
  assert.equal(cipher.decrypt(activated[0].refreshTokenCiphertext), 'aal2-refresh');
  assert.equal(activated[0].authSessionRef, 'auth-session-aal2');
  assert.equal(Object.hasOwn(activated[0], 'expiresAt'), false);
});

function refreshBrokerFixture({ refreshResult, wait } = {}) {
  const cipher = createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 4) });
  const record = {
    sessionId, subjectId,
    idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
    persistence: '24h', lastSeenAt: now.toISOString(), createdAt: now.toISOString(), revokedAt: null,
    authorityFresh: true, permissions: ['console.audit.read'], permissionRevision: '7', revokeEpoch: '2',
    aal: 'aal1', accessTokenExpiresAt: '2026-09-01T23:59:59.000Z',
  };
  const refreshCiphertext = cipher.encrypt('refresh-before-rotation');
  const calls = { rotate: [], reject: [] };
  const store = {
    async issueSession() { throw new Error('login must not run during refresh'); },
    async getPendingMfa() { throw new Error('MFA must not run during refresh'); },
    async activateMfa() { throw new Error('MFA must not run during refresh'); },
    async resolveSession() { return { ...record }; },
    async getRefreshCredentials() {
      return { sessionId, subjectId, refreshTokenCiphertext: refreshCiphertext };
    },
    async rotateCredentials(input) {
      calls.rotate.push(input);
      record.accessTokenExpiresAt = input.accessTokenExpiresAt;
      record.aal = input.aal;
      return { outcome: 'rotated' };
    },
    async rejectRefresh(input) { calls.reject.push(input); return { outcome: 'rejected' }; },
    async touchActivity() { throw new Error('activity touch must not run during refresh'); },
  };
  const authClient = {
    async authenticatePassword() { throw new Error('login must not run during refresh'); },
    async completeTotp() { throw new Error('MFA must not run during refresh'); },
    async refreshSession(input) {
      assert.deepEqual(input, { refreshToken: 'refresh-before-rotation', expectedSubjectId: subjectId });
      if (refreshResult instanceof Error) throw refreshResult;
      return refreshResult || {
        subjectId, accessToken: 'access-after-rotation', refreshToken: 'refresh-after-rotation',
        authSessionRef: 'auth-session-rotated', aal: 'aal1',
        accessTokenExpiresAt: '2026-09-02T01:00:00.000Z',
      };
    },
    async logout() {},
  };
  return {
    broker: createIdentitySessionBroker({
      store, authClient, credentialCipher: cipher, publicOrigin: 'https://console.example.test',
      clock: () => now, ...(wait ? { wait } : {}),
    }),
    record, calls, cipher,
  };
}

test('expired access credential rotates server-side before returning the session projection', async () => {
  const { broker, calls, cipher } = refreshBrokerFixture();
  const resolved = await broker.resolveSession({
    headers: { cookie: '__Host-opensphere-session=opaque-session-handle-for-refresh-rotation' },
  }, { requireCsrf: false, correlationId: 'session-refresh-correlation-0001' });
  assert.equal(resolved.subjectId, subjectId);
  assert.equal(resolved.accessTokenExpiresAt, '2026-09-02T01:00:00.000Z');
  assert.equal(calls.rotate.length, 1);
  assert.equal(calls.reject.length, 0);
  assert.equal(cipher.decrypt(calls.rotate[0].accessTokenCiphertext), 'access-after-rotation');
  assert.equal(cipher.decrypt(calls.rotate[0].refreshTokenCiphertext), 'refresh-after-rotation');
  assert.equal(calls.rotate[0].expectedRefreshCiphertextDigest.length, 32);
});

test('transient refresh outage preserves the active browser session without a database mutation', async () => {
  const error = Object.assign(new Error('Supabase unavailable'), { code: 'AuthorityUnavailable', status: 503 });
  const { broker, calls } = refreshBrokerFixture({ refreshResult: error });
  await assert.rejects(broker.resolveSession({
    headers: { cookie: '__Host-opensphere-session=opaque-session-handle-for-refresh-outage' },
  }, { requireCsrf: false, correlationId: 'session-refresh-outage-0001' }), { code: 'AuthorityUnavailable' });
  assert.equal(calls.rotate.length, 0);
  assert.equal(calls.reject.length, 0);
});

test('explicit refresh rejection adopts a peer rotation before considering revocation', async () => {
  const error = Object.assign(new Error('refresh rejected'), { code: 'RefreshRejected', status: 401 });
  let fixture;
  fixture = refreshBrokerFixture({
    refreshResult: error,
    async wait() { fixture.record.accessTokenExpiresAt = '2026-09-02T01:00:00.000Z'; },
  });
  const resolved = await fixture.broker.resolveSession({
    headers: { cookie: '__Host-opensphere-session=opaque-session-handle-for-peer-refresh' },
  }, { requireCsrf: false, correlationId: 'session-refresh-peer-0001' });
  assert.equal(resolved.accessTokenExpiresAt, '2026-09-02T01:00:00.000Z');
  assert.equal(fixture.calls.reject.length, 0);
});

test('explicit refresh rejection revokes only when the durable ciphertext is still current', async () => {
  const error = Object.assign(new Error('refresh rejected'), { code: 'RefreshRejected', status: 401 });
  const { broker, calls } = refreshBrokerFixture({ refreshResult: error, wait: async () => {} });
  await assert.rejects(broker.resolveSession({
    headers: { cookie: '__Host-opensphere-session=opaque-session-handle-for-rejected-refresh' },
  }, { requireCsrf: false, correlationId: 'session-refresh-rejected-0001' }), { code: 'AuthenticationRequired' });
  assert.equal(calls.rotate.length, 0);
  assert.equal(calls.reject.length, 1);
  assert.equal(calls.reject[0].expectedRefreshCiphertextDigest.length, 32);
});

test('trusted activity touch sends only opaque proof digests and returns bounded expiry fields', async () => {
  let proof;
  const cipher = createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 3) });
  const store = {
    async resolveSession() { throw new Error('resolve must not run'); },
    async issueSession() { throw new Error('login must not run'); },
    async getPendingMfa() { throw new Error('MFA must not run'); },
    async activateMfa() { throw new Error('MFA must not run'); },
    async getRefreshCredentials() { throw new Error('refresh must not run'); },
    async rotateCredentials() { throw new Error('refresh must not run'); },
    async rejectRefresh() { throw new Error('refresh must not run'); },
    async touchActivity(input) {
      proof = input;
      return {
        sessionId, subjectId, state: 'active', aal: 'aal1', persistence: '7d',
        createdAt: now.toISOString(), lastSeenAt: '2026-09-02T00:02:00.000Z',
        idleExpiresAt: '2026-09-02T12:02:00.000Z', absoluteExpiresAt: '2026-09-09T00:00:00.000Z',
      };
    },
  };
  const broker = createIdentitySessionBroker({
    store,
    authClient: {
      async authenticatePassword() { throw new Error('login must not run'); },
      async completeTotp() { throw new Error('MFA must not run'); },
      async refreshSession() { throw new Error('refresh must not run'); },
      async logout() {},
    },
    credentialCipher: cipher,
    publicOrigin: 'https://console.example.test',
    clock: () => now,
  });
  const session = await broker.touchActivity({ headers: {
    cookie: '__Host-opensphere-session=opaque-activity-handle-that-is-long-enough',
    'x-os-csrf-token': 'opaque-activity-csrf-proof',
  } });
  assert.equal(proof.tokenDigest.length, 32);
  assert.equal(proof.csrfTokenDigest.length, 32);
  assert.doesNotMatch(JSON.stringify(proof), /opaque-activity/);
  assert.equal(session.persistence, '7d');
  assert.equal(session.idleExpiresAt, '2026-09-02T12:02:00.000Z');
  assert.equal(session.absoluteExpiresAt, '2026-09-09T00:00:00.000Z');
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

test('HTTP MFA completion preserves the request proof and returns refreshed cookies', async (t) => {
  const calls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('active session resolution must not run for pending MFA'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async completeMfa(input) {
        calls.push(input);
        return {
          cookies: ['__Host-opensphere-session=opaque; Path=/; HttpOnly; Secure; SameSite=Strict', '__Host-opensphere_csrf=csrf; Path=/; Secure; SameSite=Strict'],
          body: { assurance: 'aal2', sessionId },
        };
      },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/identity/session/mfa', {
    method: 'POST',
    headers: {
      cookie: '__Host-opensphere-session=opaque',
      'x-os-csrf-token': 'csrf-proof-for-mfa-completion',
      'content-type': 'application/json',
      'x-correlation-id': 'session-mfa-http-0001',
    },
    body: JSON.stringify({ code: '123456' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(calls[0].request.headers['x-os-csrf-token'], 'csrf-proof-for-mfa-completion');
  assert.deepEqual(calls[0].body, { code: '123456' });
});

test('HTTP activity touch requires an exact empty body and forwards the CSRF-bound request', async (t) => {
  const calls = [];
  const projection = {
    id: sessionId, current: true, status: 'active', assurance: 'aal1', persistence: '24h',
    createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
    idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
    userAgentDigest: null,
  };
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('generic resolution must not run during touch'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async touchActivity(request) { calls.push(request); return projection; },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/identity/session/touch';
  const valid = await fetch(endpoint, {
    method: 'POST',
    headers: {
      cookie: '__Host-opensphere-session=opaque',
      'x-os-csrf-token': 'csrf-proof-for-activity-touch',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { session: projection });
  assert.equal(calls[0].headers['x-os-csrf-token'], 'csrf-proof-for-activity-touch');
  const invalid = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"extend":true}',
  });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 1);
});
