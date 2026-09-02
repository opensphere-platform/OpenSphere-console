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

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

function unusedOwnedSessionMethods() {
  return {
    async listOwnedSessions() { throw new Error('session inventory must not run'); },
    async listOwnedSessionEvents() { throw new Error('session event history must not run'); },
    async revokeOwnedSession() { throw new Error('owned session revocation must not run'); },
    async revokeAllOwnedSessions() { throw new Error('all-session revocation must not run'); },
  };
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

test('Supabase session preference uses only the current subject access credential', async () => {
  const accessToken = token();
  const calls = [];
  const client = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', now: () => now,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      assert.equal(init.headers.authorization, 'Bearer ' + accessToken);
      assert.equal(Object.hasOwn(init.headers, 'apikey'), false);
      if (init.method === 'GET') {
        return jsonResponse({ id: subjectId, user_metadata: { console_session_persistence: '4h' } });
      }
      assert.equal(init.method, 'PUT');
      assert.deepEqual(JSON.parse(init.body), { data: { console_session_persistence: '7d' } });
      return jsonResponse({ id: subjectId, user_metadata: { console_session_persistence: '7d' } });
    },
  });
  assert.deepEqual(await client.readSessionPreference({ accessToken, expectedSubjectId: subjectId }), {
    subjectId, duration: '4h',
  });
  assert.deepEqual(await client.updateSessionPreference({
    accessToken, expectedSubjectId: subjectId, duration: '7d',
  }), { subjectId, duration: '7d' });
  assert.equal(calls.length, 2);
  await assert.rejects(client.updateSessionPreference({
    accessToken, expectedSubjectId: subjectId, duration: 'forever',
  }), { code: 'ValidationFailed' });
  assert.equal(calls.length, 2);

  const unconfirmed = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', now: () => now,
    async fetchImpl() { return jsonResponse({ id: subjectId, user_metadata: {} }); },
  });
  await assert.rejects(unconfirmed.updateSessionPreference({
    accessToken, expectedSubjectId: subjectId, duration: '24h',
  }), { code: 'AuthorityUnavailable' });
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

test('Supabase TOTP enrollment replaces only unverified factors and verifies the same subject factor', async () => {
  const accessToken = token();
  const aal2Token = token({ aal: 'aal2', session_id: 'auth-session-enrolled' });
  const calls = [];
  let enrolled = false;
  const client = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', now: () => now,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (url.endsWith('/user')) {
        if (init.headers.authorization === 'Bearer ' + aal2Token) {
          return jsonResponse({
            id: subjectId,
            factors: [{ id: 'factor/new', factor_type: 'totp', status: 'verified' }],
          });
        }
        return jsonResponse({
          id: subjectId,
          factors: [{ id: enrolled ? 'factor/new' : 'factor/old', factor_type: 'totp', status: 'unverified' }],
        });
      }
      if (url.endsWith('/factors/factor%2Fold') && init.method === 'DELETE') return jsonResponse({});
      if (url.endsWith('/factors') && init.method === 'POST') {
        assert.deepEqual(JSON.parse(init.body), { factor_type: 'totp', friendly_name: 'OpenSphere Console' });
        enrolled = true;
        return jsonResponse({
          id: 'factor/new',
          totp: { secret: 'JBSWY3DPEHPK3PXP', qr_code: '<svg>qr</svg>', uri: 'otpauth://totp/OpenSphere' },
        });
      }
      if (url.endsWith('/factors/factor%2Fnew/challenge')) return jsonResponse({ id: 'challenge-enroll' });
      if (url.endsWith('/factors/factor%2Fnew/verify')) {
        assert.deepEqual(JSON.parse(init.body), { challenge_id: 'challenge-enroll', code: '654321' });
        return jsonResponse({ access_token: aal2Token, refresh_token: 'refresh-enrolled' });
      }
      return jsonResponse({}, 404);
    },
  });
  const enrollment = await client.beginTotpEnrollment({
    accessToken, expectedSubjectId: subjectId, friendlyName: 'OpenSphere Console',
  });
  assert.deepEqual(enrollment, {
    factorId: 'factor/new', secret: 'JBSWY3DPEHPK3PXP', qrCode: '<svg>qr</svg>', uri: 'otpauth://totp/OpenSphere',
  });
  const completed = await client.verifyTotpEnrollment({
    accessToken, factorId: enrollment.factorId, code: '654321', expectedSubjectId: subjectId,
  });
  assert.equal(completed.aal, 'aal2');
  assert.equal(completed.authSessionRef, 'auth-session-enrolled');
  assert.equal(calls.some(({ url, init }) => url.endsWith('/factors/factor%2Fold') && init.method === 'DELETE'), true);
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

test('Supabase password recovery accepts only a recovery AMR, changes the same subject, and logs out globally', async () => {
  const recoveryAccessToken = token({ amr: [{ method: 'recovery', timestamp: Math.floor(now.getTime() / 1000) }] });
  const calls = [];
  const client = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', now: () => now,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (url.endsWith('/user') && init.method === 'GET') return jsonResponse({ id: subjectId });
      if (url.endsWith('/user') && init.method === 'PUT') {
        assert.deepEqual(JSON.parse(init.body), { password: 'new-password-value' });
        return jsonResponse({ id: subjectId });
      }
      if (url.endsWith('/logout?scope=global') && init.method === 'POST') return emptyResponse();
      return jsonResponse({}, 404);
    },
  });
  const recovered = await client.completePasswordRecovery({
    recoveryAccessToken, password: 'new-password-value',
  });
  assert.deepEqual(recovered, { subjectId, accessToken: recoveryAccessToken });
  await client.logoutAll(recovered.accessToken);
  assert.deepEqual(calls.map(({ url, init }) => [new URL(url).pathname + new URL(url).search, init.method]), [
    ['/user', 'GET'], ['/user', 'PUT'], ['/logout?scope=global', 'POST'],
  ]);
  assert.equal(calls.every(({ init }) => init.headers.authorization === 'Bearer ' + recoveryAccessToken), true);

  let called = false;
  const ordinaryClient = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', now: () => now,
    async fetchImpl() { called = true; return jsonResponse({ id: subjectId }); },
  });
  await assert.rejects(ordinaryClient.completePasswordRecovery({
    recoveryAccessToken: token({ amr: [{ method: 'password', timestamp: 1 }] }),
    password: 'new-password-value',
  }), { code: 'RecoveryRejected' });
  assert.equal(called, false);
});

test('Supabase recovery-link client revalidates the current subject and rewrites only the Auth verify endpoint', async () => {
  const accessToken = token();
  const serviceRoleKey = 'service-role-key-' + 'r'.repeat(64);
  const redirectUrl = 'https://console.example.test/auth/recovery';
  const calls = [];
  const client = createSupabaseAuthClient({
    baseUrl: 'http://127.0.0.1:54321', serviceRoleKey, now: () => now,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (url.endsWith('/user')) {
        assert.equal(init.headers.authorization, 'Bearer ' + accessToken);
        assert.equal(Object.hasOwn(init.headers, 'apikey'), false);
        return jsonResponse({ id: subjectId, email: 'operator@example.test' });
      }
      if (url.endsWith('/admin/generate_link')) {
        assert.equal(init.headers.authorization, 'Bearer ' + serviceRoleKey);
        assert.equal(init.headers.apikey, serviceRoleKey);
        assert.deepEqual(JSON.parse(init.body), {
          type: 'recovery', email: 'operator@example.test', redirect_to: redirectUrl,
        });
        return jsonResponse({
          id: subjectId,
          action_link: 'http://127.0.0.1:54321/verify?token=recovery-token-value&type=recovery&redirect_to='
            + encodeURIComponent(redirectUrl),
        });
      }
      return jsonResponse({}, 404);
    },
  });
  assert.deepEqual(await client.createOwnedPasswordRecoveryLink({
    accessToken, expectedSubjectId: subjectId,
    publicOrigin: 'https://console.example.test', redirectUrl,
  }), {
    subjectId,
    resetUrl: 'https://console.example.test/auth/v1/verify?token=recovery-token-value&type=recovery&redirect_to=https%3A%2F%2Fconsole.example.test%2Fauth%2Frecovery',
  });
  assert.equal(calls.length, 2);
});

test('Supabase initial administrator client confines exercised service credentials to Auth admin create and cleanup', async () => {
  const serviceRoleKey = 'service-role-key-' + 's'.repeat(64);
  const calls = [];
  const client = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', serviceRoleKey, now: () => now,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      assert.equal(init.headers.apikey, serviceRoleKey);
      assert.equal(init.headers.authorization, 'Bearer ' + serviceRoleKey);
      if (url.endsWith('/admin/users') && init.method === 'POST') {
        assert.deepEqual(JSON.parse(init.body), {
          email: 'admin@example.test',
          password: 'initial-password-value',
          email_confirm: true,
          user_metadata: { preferred_username: 'opensphere-admin', display_name: 'OpenSphere Administrator' },
        });
        return jsonResponse({ id: subjectId });
      }
      if (url.endsWith('/admin/users/' + subjectId) && init.method === 'DELETE') return jsonResponse({ id: subjectId });
      return jsonResponse({}, 404);
    },
  });
  assert.deepEqual(await client.createInitialAdministrator({
    username: 'opensphere-admin', displayName: 'OpenSphere Administrator',
    email: 'admin@example.test', password: 'initial-password-value',
  }), { subjectId });
  await client.deleteInitialAdministrator(subjectId);
  assert.equal(calls.length, 2);

  const unavailable = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', now: () => now,
    async fetchImpl() { throw new Error('must not call Auth without administrator authority'); },
  });
  await assert.rejects(unavailable.createInitialAdministrator({
    username: 'opensphere-admin', displayName: 'OpenSphere Administrator',
    email: 'admin@example.test', password: 'initial-password-value',
  }), { code: 'AuthorityUnavailable' });
});

test('initial administrator bootstrap creates Auth identity before one atomic Console authority claim', async () => {
  const calls = [];
  const store = {
    async resolveSession() { throw new Error('session resolution must not run during bootstrap'); },
    async issueSession() { throw new Error('login must not run during bootstrap'); },
    async getPendingMfa() { throw new Error('MFA must not run during bootstrap'); },
    async activateMfa() { throw new Error('MFA must not run during bootstrap'); },
    async getRefreshCredentials() { throw new Error('refresh must not run during bootstrap'); },
    async rotateCredentials() { throw new Error('refresh must not run during bootstrap'); },
    async rejectRefresh() { throw new Error('refresh must not run during bootstrap'); },
    async touchActivity() { throw new Error('activity touch must not run during bootstrap'); },
    ...unusedOwnedSessionMethods(),
    async getInitialAdministratorBootstrapStatus() { return { state: 'required' }; },
    async claimInitialAdministrator(input) {
      calls.push(['claim', input]);
      return { state: 'complete', subjectId, permissionRevision: 1, permissionCount: 8 };
    },
  };
  const authClient = {
    async authenticatePassword() { throw new Error('login must not run during bootstrap'); },
    async completeTotp() { throw new Error('MFA must not run during bootstrap'); },
    async refreshSession() { throw new Error('refresh must not run during bootstrap'); },
    async logout() {},
    async createInitialAdministrator(input) { calls.push(['create', input]); return { subjectId }; },
    async deleteInitialAdministrator(value) { calls.push(['delete', value]); },
  };
  const broker = createIdentitySessionBroker({
    store, authClient,
    credentialCipher: createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 12) }),
    publicOrigin: 'https://console.example.test', clock: () => now,
  });
  assert.deepEqual(await broker.initialAdministratorStatus(), { state: 'required' });
  assert.deepEqual(await broker.bootstrapInitialAdministrator({
    body: {
      username: 'OpenSphere-Admin', displayName: 'OpenSphere Administrator',
      email: 'ADMIN@example.test', password: 'initial-password-value', passwordConfirm: 'initial-password-value',
    },
    requestOrigin: 'https://console.example.test',
    correlationId: 'initial-administrator-bootstrap-0001',
  }), { state: 'complete' });
  assert.deepEqual(calls.map(([name]) => name), ['create', 'claim']);
  assert.deepEqual(calls[0][1], {
    username: 'opensphere-admin', displayName: 'OpenSphere Administrator',
    email: 'admin@example.test', password: 'initial-password-value',
  });
  assert.deepEqual(calls[1][1], { subjectId, correlationId: 'initial-administrator-bootstrap-0001' });

  store.claimInitialAdministrator = async () => {
    throw Object.assign(new Error('already complete'), { code: 'BootstrapComplete', status: 409 });
  };
  await assert.rejects(broker.bootstrapInitialAdministrator({
    body: {
      username: 'other-admin', displayName: 'Other Administrator', email: 'other@example.test',
      password: 'another-password-value', passwordConfirm: 'another-password-value',
    },
    requestOrigin: 'https://console.example.test', correlationId: 'initial-administrator-bootstrap-0002',
  }), { code: 'BootstrapComplete' });
  assert.deepEqual(calls.at(-1), ['delete', subjectId]);
  await assert.rejects(broker.bootstrapInitialAdministrator({
    body: {
      username: 'other-admin', displayName: 'Other Administrator', email: 'other@example.test',
      password: 'another-password-value', passwordConfirm: 'another-password-value',
    },
    requestOrigin: 'https://attacker.example.test', correlationId: 'initial-administrator-bootstrap-0003',
  }), { code: 'PermissionDenied' });
});

test('session preference reuses the encrypted current-subject credential and persists intent before update', async () => {
  const calls = [];
  const handle = 'opaque-session-preference-handle-value';
  const csrf = 'csrf-session-preference-proof-value';
  const cipher = createSessionCredentialCipher({
    encryptionKey, randomBytes: (size) => Buffer.alloc(size, 18),
  });
  const accessToken = token();
  const store = {
    async resolveSession() {
      return {
        sessionId, subjectId, expiresAt: '2026-09-02T12:00:00.000Z',
        idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
        persistence: '24h', accessTokenExpiresAt: '2026-09-02T01:00:00.000Z', revokedAt: null,
        authorityFresh: true, permissions: [], permissionRevision: 1, revokeEpoch: 0, aal: 'aal2',
      };
    },
    async issueSession() { throw new Error('login must not run'); },
    async getPendingMfa() { throw new Error('MFA must not run'); },
    async activateMfa() { throw new Error('MFA must not run'); },
    async getRefreshCredentials() { throw new Error('refresh must not run'); },
    async rotateCredentials() { throw new Error('refresh must not run'); },
    async rejectRefresh() { throw new Error('refresh must not run'); },
    async touchActivity() { throw new Error('activity touch must not run'); },
    ...unusedOwnedSessionMethods(),
    async getSessionPreferenceCredentials(input) {
      calls.push(['read-context', input]);
      return { sessionId, subjectId, accessTokenCiphertext: cipher.encrypt(accessToken) };
    },
    async prepareSessionPreferenceUpdate(input) {
      calls.push(['prepare-update', input]);
      return {
        sessionId, subjectId, accessTokenCiphertext: cipher.encrypt(accessToken),
        auditEventId: '33333333-3333-4333-8333-333333333333',
      };
    },
  };
  const authClient = {
    async authenticatePassword() { throw new Error('login must not run'); },
    async completeTotp() { throw new Error('MFA must not run'); },
    async refreshSession() { throw new Error('refresh must not run'); },
    async logout() {},
    async readSessionPreference(input) {
      calls.push(['read-auth', input]);
      return { subjectId, duration: '4h' };
    },
    async updateSessionPreference(input) {
      calls.push(['update-auth', input]);
      return { subjectId, duration: input.duration };
    },
  };
  const broker = createIdentitySessionBroker({
    store, authClient, credentialCipher: cipher,
    publicOrigin: 'https://console.example.test', clock: () => now,
  });
  const request = { headers: {
    cookie: `__Host-opensphere-session=${handle}`,
    'x-os-csrf-token': csrf,
  } };
  assert.deepEqual(await broker.getSessionPreference(request, {
    correlationId: 'session-preference-read-0001',
  }), { duration: '4h', defaultDuration: '24h', idleTimeoutHours: 12, appliesTo: 'next-login' });
  assert.deepEqual(await broker.updateSessionPreference(request, {
    body: { duration: '7d' }, correlationId: 'session-preference-update-0001',
  }), { duration: '7d', defaultDuration: '24h', idleTimeoutHours: 12, appliesTo: 'next-login' });
  assert.deepEqual(calls.map(([name]) => name), ['read-context', 'read-auth', 'prepare-update', 'update-auth']);
  assert.equal(calls[1][1].accessToken, accessToken);
  assert.equal(calls[3][1].accessToken, accessToken);
  assert.equal(calls[2][1].duration, '7d');
  assert.equal(calls[2][1].tokenDigest.length, 32);
  assert.equal(calls[2][1].csrfTokenDigest.length, 32);
  await assert.rejects(broker.updateSessionPreference(request, {
    body: { duration: 'forever' }, correlationId: 'session-preference-update-0002',
  }), { code: 'ValidationFailed' });
  assert.equal(calls.length, 4);
});

test('session event history is current-subject scoped, bounded, and no-secret', async () => {
  const handle = 'opaque-session-event-history-handle';
  const calls = [];
  const store = {
    async resolveSession() {
      return {
        sessionId, subjectId, expiresAt: '2026-09-02T12:00:00.000Z',
        idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
        persistence: '24h', accessTokenExpiresAt: '2026-09-02T01:00:00.000Z', revokedAt: null,
        authorityFresh: true, permissions: [], permissionRevision: 1, revokeEpoch: 0, aal: 'aal2',
      };
    },
    async issueSession() { throw new Error('login must not run'); },
    async getPendingMfa() { throw new Error('MFA must not run'); },
    async activateMfa() { throw new Error('MFA must not run'); },
    async getRefreshCredentials() { throw new Error('refresh must not run'); },
    async rotateCredentials() { throw new Error('refresh must not run'); },
    async rejectRefresh() { throw new Error('refresh must not run'); },
    async touchActivity() { throw new Error('activity touch must not run'); },
    ...unusedOwnedSessionMethods(),
    async listOwnedSessionEvents(input) {
      calls.push(input);
      return { items: [{
        id: 17, session_id: sessionId, event: 'refresh_rejected', result: 'rejected',
        occurred_at: '2026-09-01T23:59:00.000Z', evidence: { token: 'must-not-project' },
      }] };
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
    credentialCipher: createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 19) }),
    publicOrigin: 'https://console.example.test', clock: () => now,
  });
  const result = await broker.listSessionEvents({ headers: {
    cookie: `__Host-opensphere-session=${handle}`,
  } }, { limit: '2' });
  assert.deepEqual(result, { items: [{
    id: 17, session_id: sessionId, event: 'refresh_rejected', result: 'rejected',
    occurred_at: '2026-09-01T23:59:00.000Z',
  }] });
  assert.equal(calls[0].limit, 2);
  assert.equal(calls[0].tokenDigest.length, 32);
  await assert.rejects(broker.listSessionEvents({ headers: {
    cookie: `__Host-opensphere-session=${handle}`,
  } }, { limit: '101' }), { code: 'ValidationFailed' });
  assert.equal(calls.length, 1);
});

test('password recovery revokes the verified subject Console sessions before closing the recovery session', async () => {
  const calls = [];
  const recoveryAccessToken = token({ amr: [{ method: 'recovery', timestamp: 1 }] });
  const broker = createIdentitySessionBroker({
    store: {
      async resolveSession() { throw new Error('session resolution must not run during recovery'); },
      async issueSession() { throw new Error('login must not run during recovery'); },
      async getPendingMfa() { throw new Error('MFA must not run during recovery'); },
      async activateMfa() { throw new Error('MFA must not run during recovery'); },
      async getRefreshCredentials() { throw new Error('refresh must not run during recovery'); },
      async rotateCredentials() { throw new Error('refresh must not run during recovery'); },
      async rejectRefresh() { throw new Error('refresh must not run during recovery'); },
      async touchActivity() { throw new Error('activity touch must not run during recovery'); },
      ...unusedOwnedSessionMethods(),
      async revokeRecoveredSubjectSessions(input) {
        calls.push(['revoke', input]);
        return { subjectId, revokedCount: 3, revokeEpoch: 9 };
      },
    },
    authClient: {
      async authenticatePassword() { throw new Error('login must not run during recovery'); },
      async completeTotp() { throw new Error('MFA must not run during recovery'); },
      async refreshSession() { throw new Error('refresh must not run during recovery'); },
      async completePasswordRecovery(input) {
        calls.push(['password', input]);
        return { subjectId, accessToken: recoveryAccessToken };
      },
      async logoutAll(value) { calls.push(['logout', value]); },
      async logout() {},
    },
    credentialCipher: createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 15) }),
    publicOrigin: 'https://console.example.test', clock: () => now,
  });
  const result = await broker.completePasswordRecovery({
    body: { recoveryAccessToken, password: 'new-password-value' },
    requestOrigin: 'https://console.example.test',
    correlationId: 'password-recovery-correlation-0001',
  });
  assert.deepEqual(result, { completed: true, revokedSessions: 3 });
  assert.deepEqual(calls.map(([name]) => name), ['password', 'revoke', 'logout']);
  assert.deepEqual(calls[1][1], { subjectId, correlationId: 'password-recovery-correlation-0001' });
  assert.equal(calls[2][1], recoveryAccessToken);
  await assert.rejects(broker.completePasswordRecovery({
    body: { recoveryAccessToken, password: 'new-password-value' },
    requestOrigin: 'https://attacker.example.test',
    correlationId: 'password-recovery-correlation-0002',
  }), { code: 'PermissionDenied' });
});

test('owned password recovery-link request persists one intent before issuing a same-subject link', async () => {
  const calls = [];
  const handle = 'opaque-owned-password-recovery-handle';
  const csrf = 'csrf-owned-password-recovery-proof';
  const accessToken = token();
  const cipher = createSessionCredentialCipher({
    encryptionKey, randomBytes: (size) => Buffer.alloc(size, 20),
  });
  let duplicate = false;
  const broker = createIdentitySessionBroker({
    store: {
      async resolveSession() {
        return {
          sessionId, subjectId, expiresAt: '2026-09-02T12:00:00.000Z',
          idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
          persistence: '24h', accessTokenExpiresAt: '2026-09-02T01:00:00.000Z', revokedAt: null,
          authorityFresh: true, permissions: [], permissionRevision: 1, revokeEpoch: 0, aal: 'aal2',
        };
      },
      async issueSession() { throw new Error('login must not run'); },
      async getPendingMfa() { throw new Error('MFA must not run'); },
      async activateMfa() { throw new Error('MFA must not run'); },
      async getRefreshCredentials() { throw new Error('refresh must not run'); },
      async rotateCredentials() { throw new Error('refresh must not run'); },
      async rejectRefresh() { throw new Error('refresh must not run'); },
      async touchActivity() { throw new Error('activity touch must not run'); },
      ...unusedOwnedSessionMethods(),
      async prepareOwnedPasswordRecoveryLink(input) {
        calls.push(['prepare', input]);
        if (duplicate) return { state: 'duplicate', subjectId };
        return {
          state: 'prepared', sessionId, subjectId,
          accessTokenCiphertext: cipher.encrypt(accessToken),
          auditEventId: '33333333-3333-4333-8333-333333333333',
        };
      },
    },
    authClient: {
      async authenticatePassword() { throw new Error('login must not run'); },
      async completeTotp() { throw new Error('MFA must not run'); },
      async refreshSession() { throw new Error('refresh must not run'); },
      async logout() {},
      async createOwnedPasswordRecoveryLink(input) {
        calls.push(['auth', input]);
        return {
          subjectId,
          resetUrl: 'https://console.example.test/auth/v1/verify?token=recovery-token-value&type=recovery',
        };
      },
    },
    credentialCipher: cipher,
    publicOrigin: 'https://console.example.test', clock: () => now,
  });
  const request = { headers: {
    cookie: `__Host-opensphere-session=${handle}`,
    'x-os-csrf-token': csrf,
  } };
  assert.deepEqual(await broker.requestOwnedPasswordRecoveryLink(request, {
    body: { reason: 'self-service password change' },
    idempotencyKey: 'owned-password-recovery-key-0001',
    correlationId: 'owned-password-recovery-correlation-0001',
  }), {
    ok: true,
    resetUrl: 'https://console.example.test/auth/v1/verify?token=recovery-token-value&type=recovery',
  });
  assert.equal(calls[0][1].tokenDigest.length, 32);
  assert.equal(calls[0][1].csrfTokenDigest.length, 32);
  assert.equal(calls[0][1].reason, 'self-service password change');
  assert.equal(calls[1][1].accessToken, accessToken);
  assert.equal(calls[1][1].redirectUrl, 'https://console.example.test/auth/recovery');
  duplicate = true;
  await assert.rejects(broker.requestOwnedPasswordRecoveryLink(request, {
    body: { reason: 'self-service password change' },
    idempotencyKey: 'owned-password-recovery-key-0001',
    correlationId: 'owned-password-recovery-correlation-0002',
  }), { code: 'IdempotencyReplayUnavailable', status: 409, sideEffect: 'unknown' });
  assert.deepEqual(calls.map(([name]) => name), ['prepare', 'auth', 'prepare']);
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
      ...unusedOwnedSessionMethods(),
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
      ...unusedOwnedSessionMethods(),
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
      ...unusedOwnedSessionMethods(),
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
      ...unusedOwnedSessionMethods(),
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

test('active-session TOTP enrollment keeps setup material out of the store and promotes by access-CAS', async () => {
  const cipher = createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 13) });
  const accessTokenCiphertext = cipher.encrypt('active-aal1-access');
  const completions = [];
  const sessionRecord = {
    sessionId, subjectId,
    idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
    persistence: '24h', lastSeenAt: now.toISOString(), createdAt: now.toISOString(), revokedAt: null,
    authorityFresh: true, permissions: [], permissionRevision: '1', revokeEpoch: '0',
    aal: 'aal1', accessTokenExpiresAt: '2026-09-02T01:00:00.000Z',
  };
  const store = {
    async resolveSession() { return { ...sessionRecord }; },
    async issueSession() { throw new Error('login must not run during enrollment'); },
    async getPendingMfa() { throw new Error('pending MFA must not run during enrollment'); },
    async activateMfa() { throw new Error('pending MFA must not run during enrollment'); },
    async getTotpEnrollmentCredentials(input) {
      assert.equal(input.tokenDigest.length, 32);
      assert.equal(input.csrfTokenDigest.length, 32);
      return { sessionId, subjectId, accessTokenCiphertext };
    },
    async completeTotpEnrollment(input) {
      completions.push(input);
      sessionRecord.aal = 'aal2';
      return { sessionId, subjectId, state: 'active', aal: 'aal2' };
    },
    async getRefreshCredentials() { throw new Error('refresh must not run during enrollment'); },
    async rotateCredentials() { throw new Error('refresh must not run during enrollment'); },
    async rejectRefresh() { throw new Error('refresh must not run during enrollment'); },
    async touchActivity() { throw new Error('touch must not run during enrollment'); },
    ...unusedOwnedSessionMethods(),
  };
  const authClient = {
    async authenticatePassword() { throw new Error('login must not run during enrollment'); },
    async completeTotp() { throw new Error('pending MFA must not run during enrollment'); },
    async beginTotpEnrollment(input) {
      assert.deepEqual(input, {
        accessToken: 'active-aal1-access', expectedSubjectId: subjectId, friendlyName: 'OpenSphere Console administrator',
      });
      return { factorId: 'factor/enroll', secret: 'JBSWY3DPEHPK3PXP', qrCode: '', uri: 'otpauth://totp/OpenSphere' };
    },
    async verifyTotpEnrollment(input) {
      assert.deepEqual(input, {
        accessToken: 'active-aal1-access', factorId: 'factor/enroll', code: '123456', expectedSubjectId: subjectId,
      });
      return {
        subjectId, accessToken: 'enrolled-aal2-access', refreshToken: 'enrolled-aal2-refresh',
        authSessionRef: 'auth-session-enrolled', aal: 'aal2', accessTokenExpiresAt: '2026-09-02T01:00:00.000Z',
      };
    },
    async refreshSession() { throw new Error('refresh must not run during enrollment'); },
    async logout() { throw new Error('logout must not run after enrollment success'); },
  };
  const broker = createIdentitySessionBroker({
    store, authClient, credentialCipher: cipher, publicOrigin: 'https://console.example.test', clock: () => now,
  });
  const request = { headers: {
    cookie: '__Host-opensphere-session=opaque-session-handle-for-totp-enrollment',
    'x-os-csrf-token': 'csrf-proof-for-totp-enrollment',
  } };
  const enrollment = await broker.beginTotpEnrollment({
    request, body: { friendlyName: 'OpenSphere Console administrator' }, correlationId: 'totp-enrollment-begin-0001',
  });
  assert.equal(enrollment.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(JSON.stringify(store).includes('JBSWY3DPEHPK3PXP'), false);
  const verified = await broker.verifyTotpEnrollment({
    request, body: { factorId: enrollment.factorId, code: '123456' }, correlationId: 'totp-enrollment-verify-0001',
  });
  assert.deepEqual(verified, { assurance: 'aal2', sessionId });
  assert.equal(completions.length, 1);
  assert.equal(completions[0].expectedAccessCiphertextDigest.length, 32);
  assert.equal(cipher.decrypt(completions[0].accessTokenCiphertext), 'enrolled-aal2-access');
  assert.equal(cipher.decrypt(completions[0].refreshTokenCiphertext), 'enrolled-aal2-refresh');
  assert.equal(Object.hasOwn(completions[0], 'factorId'), false);
  assert.equal(Object.hasOwn(completions[0], 'secret'), false);
});

test('privileged-action step-up records fresh aal2 on the same session by access-CAS', async () => {
  const cipher = createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 14) });
  const accessTokenCiphertext = cipher.encrypt('step-up-aal1-access');
  let completion;
  const broker = createIdentitySessionBroker({
    store: {
      async resolveSession() { return {
        sessionId, subjectId, aal: 'aal1', accessTokenExpiresAt: '2026-09-02T01:00:00.000Z',
        idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
        persistence: '24h', authorityFresh: true, permissions: [],
      }; },
      async issueSession() { throw new Error('unused'); }, async getPendingMfa() { throw new Error('unused'); },
      async activateMfa() { throw new Error('unused'); }, async getRefreshCredentials() { throw new Error('unused'); },
      async rotateCredentials() { throw new Error('unused'); }, async rejectRefresh() { throw new Error('unused'); },
      async touchActivity() { throw new Error('unused'); }, ...unusedOwnedSessionMethods(),
      async getStepUpCredentials() { return { sessionId, subjectId, accessTokenCiphertext }; },
      async completeStepUp(input) {
        completion = input;
        return { sessionId, subjectId, state: 'active', aal: 'aal2', reauthenticatedAt: now.toISOString() };
      },
    },
    authClient: {
      async authenticatePassword() { throw new Error('unused'); },
      async completeTotp(input) {
        assert.deepEqual(input, { accessToken: 'step-up-aal1-access', code: '123456', expectedSubjectId: subjectId });
        return { subjectId, accessToken: 'step-up-aal2-access', refreshToken: 'step-up-aal2-refresh',
          authSessionRef: 'auth-step-up-2', aal: 'aal2', accessTokenExpiresAt: '2026-09-02T01:00:00.000Z' };
      },
      async refreshSession() { throw new Error('unused'); }, async logout() { throw new Error('unused'); },
    },
    credentialCipher: cipher, publicOrigin: 'https://console.example.test', clock: () => now,
  });
  const result = await broker.stepUp({
    request: { headers: { cookie: '__Host-opensphere-session=opaque-step-up-session-handle-long',
      'x-os-csrf-token': 'opaque-step-up-csrf-proof' } },
    body: { code: '123456' }, correlationId: 'step-up-correlation-0001',
  });
  assert.deepEqual(result, { assurance: 'aal2', reauthenticatedAt: now.toISOString() });
  assert.equal(completion.expectedAccessCiphertextDigest.length, 32);
  assert.equal(cipher.decrypt(completion.accessTokenCiphertext), 'step-up-aal2-access');
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
    ...unusedOwnedSessionMethods(),
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
    ...unusedOwnedSessionMethods(),
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

test('owned session inventory and revocation send only opaque proof digests', async () => {
  const otherSessionId = '33333333-3333-4333-8333-333333333333';
  const calls = { list: [], revoke: [], revokeAll: [] };
  const store = {
    async resolveSession() { throw new Error('generic resolution must not run'); },
    async issueSession() { throw new Error('login must not run'); },
    async getPendingMfa() { throw new Error('MFA must not run'); },
    async activateMfa() { throw new Error('MFA must not run'); },
    async getRefreshCredentials() { throw new Error('refresh must not run'); },
    async rotateCredentials() { throw new Error('refresh must not run'); },
    async rejectRefresh() { throw new Error('refresh must not run'); },
    async touchActivity() { throw new Error('touch must not run'); },
    async listOwnedSessions(input) {
      calls.list.push(input);
      return { items: [
        {
          id: sessionId, current: true, status: 'active', assurance: 'aal2', persistence: '24h',
          createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
          idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
          userAgentDigest: null,
        },
        {
          id: otherSessionId, current: false, status: 'pending_mfa', assurance: 'aal1', persistence: 'browser',
          createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
          idleExpiresAt: '2026-09-02T00:05:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
          userAgentDigest: null,
        },
      ] };
    },
    async revokeOwnedSession(input) {
      calls.revoke.push(input);
      return { sessionId: input.targetSessionId, current: false, revokedAt: now.toISOString() };
    },
    async revokeAllOwnedSessions(input) {
      calls.revokeAll.push(input);
      return { current: true, revokedCount: 2, revokedAt: now.toISOString() };
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
    credentialCipher: createSessionCredentialCipher({ encryptionKey, randomBytes: (size) => Buffer.alloc(size, 13) }),
    publicOrigin: 'https://console.example.test',
    clock: () => now,
  });
  const request = { headers: {
    cookie: '__Host-opensphere-session=opaque-owned-session-handle-long-enough',
    'x-os-csrf-token': 'opaque-owned-session-csrf-proof',
  } };
  const inventory = await broker.listSessions(request);
  assert.equal(inventory.items.length, 2);
  assert.equal(inventory.items[0].current, true);
  assert.deepEqual(Object.keys(inventory.items[0]).sort(), [
    'absoluteExpiresAt', 'assurance', 'createdAt', 'current', 'id', 'idleExpiresAt',
    'lastSeenAt', 'persistence', 'status', 'userAgentDigest',
  ]);
  assert.equal(calls.list[0].tokenDigest.length, 32);
  assert.doesNotMatch(JSON.stringify(calls.list[0]), /opaque-owned-session/);

  const revoked = await broker.revokeSession(request, {
    targetSessionId: otherSessionId,
    correlationId: 'owned-session-revoke-correlation-0001',
  });
  assert.equal(revoked.current, false);
  assert.equal(calls.revoke[0].tokenDigest.length, 32);
  assert.equal(calls.revoke[0].csrfTokenDigest.length, 32);
  assert.equal(calls.revoke[0].targetSessionId, otherSessionId);
  assert.doesNotMatch(JSON.stringify(calls.revoke[0]), /opaque-owned-session/);

  const revokedAll = await broker.revokeAllSessions(request, {
    correlationId: 'owned-session-revoke-all-correlation-0001',
  });
  assert.equal(revokedAll.revokedCount, 2);
  assert.equal(calls.revokeAll[0].tokenDigest.length, 32);
  assert.equal(calls.revokeAll[0].csrfTokenDigest.length, 32);
  assert.doesNotMatch(JSON.stringify(calls.revokeAll[0]), /opaque-owned-session/);
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
      'x-os-correlation-id': 'session-login-http-0001',
    },
    body: JSON.stringify({ email: 'operator@example.test', password: 'valid-password' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(calls[0].requestOrigin, 'https://console.example.test');
  assert.deepEqual(calls[0].body, { email: 'operator@example.test', password: 'valid-password' });
});

test('HTTP password recovery uses the target C_API route and clears stale Console cookies', async (t) => {
  const calls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('session resolution must not run during recovery'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async completePasswordRecovery(input) { calls.push(input); return { completed: true, revokedSessions: 2 }; },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/identity/password/recovery', {
    method: 'POST',
    headers: {
      origin: 'https://console.example.test',
      'content-type': 'application/json',
      'x-os-correlation-id': 'password-recovery-http-0001',
    },
    body: JSON.stringify({ recoveryAccessToken: token({ amr: ['recovery'] }), password: 'new-password-value' }),
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(calls[0].requestOrigin, 'https://console.example.test');
  assert.equal(calls[0].body.password, 'new-password-value');
  assert.equal(calls[0].correlationId, 'password-recovery-http-0001');
});

test('HTTP owned password recovery-link route requires canonical control headers and preserves unknown replay state', async (t) => {
  const calls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('generic session resolution must not run'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async requestOwnedPasswordRecoveryLink(request, input) {
        calls.push({ request, input });
        if (input.idempotencyKey === 'owned-password-recovery-replay') {
          throw Object.assign(new Error('prior one-time link cannot be replayed'), {
            code: 'IdempotencyReplayUnavailable', status: 409, sideEffect: 'unknown',
          });
        }
        return {
          ok: true,
          resetUrl: 'https://console.example.test/auth/v1/verify?token=recovery-token-value&type=recovery',
        };
      },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/identity/me/password';
  const request = (idempotencyHeader, idempotencyKey) => fetch(endpoint, {
    method: 'POST',
    headers: {
      cookie: '__Host-opensphere-session=opaque-owned-password-recovery',
      'x-os-csrf-token': 'csrf-owned-password-recovery-proof',
      'x-os-correlation-id': 'owned-password-recovery-http-0001',
      [idempotencyHeader]: idempotencyKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'self-service password change' }),
  });
  const response = await request('x-os-idempotency-key', 'owned-password-recovery-key-0001');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(calls[0].input.idempotencyKey, 'owned-password-recovery-key-0001');
  assert.equal(calls[0].input.correlationId, 'owned-password-recovery-http-0001');

  const retiredAlias = await request('idempotency-key', 'owned-password-recovery-key-0002');
  assert.equal(retiredAlias.status, 400);
  assert.equal((await retiredAlias.json()).code, 'ValidationFailed');
  assert.equal(calls.length, 1);

  const replay = await request('x-os-idempotency-key', 'owned-password-recovery-replay');
  assert.equal(replay.status, 409);
  const replayBody = await replay.json();
  assert.equal(replayBody.code, 'IdempotencyReplayUnavailable');
  assert.equal(replayBody.sideEffect, 'unknown');
});

test('HTTP initial administrator routes expose safe status and forward only the closed bootstrap body', async (t) => {
  const calls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('session resolution must not run during bootstrap'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async initialAdministratorStatus() { return { state: 'required' }; },
      async bootstrapInitialAdministrator(input) { calls.push(input); return { state: 'complete' }; },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/identity/bootstrap';
  const status = await fetch(base + '/status');
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { state: 'required' });
  const body = {
    username: 'opensphere-admin', displayName: 'OpenSphere Administrator', email: 'admin@example.test',
    password: 'initial-password-value', passwordConfirm: 'initial-password-value',
  };
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      origin: 'https://console.example.test', 'content-type': 'application/json',
      'x-os-correlation-id': 'initial-administrator-http-0001',
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { state: 'complete' });
  assert.deepEqual(calls[0], {
    body, requestOrigin: 'https://console.example.test', correlationId: 'initial-administrator-http-0001',
  });
});

test('HTTP session preference routes preserve the current opaque session and CSRF proof', async (t) => {
  const calls = [];
  const projection = { duration: '7d', defaultDuration: '24h', idleTimeoutHours: 12, appliesTo: 'next-login' };
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('generic session resolution must not run'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async getSessionPreference(request, input) { calls.push(['get', request, input]); return projection; },
      async updateSessionPreference(request, input) { calls.push(['put', request, input]); return projection; },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/identity/session/preference';
  const headers = {
    cookie: '__Host-opensphere-session=opaque-session-preference',
    'x-os-csrf-token': 'csrf-session-preference-proof',
    'x-os-correlation-id': 'session-preference-http-0001',
  };
  const read = await fetch(endpoint, { headers: { cookie: headers.cookie } });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), projection);
  const update = await fetch(endpoint, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ duration: '7d' }),
  });
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), projection);
  assert.equal(calls[0][1].headers.cookie, headers.cookie);
  assert.equal(calls[1][1].headers['x-os-csrf-token'], headers['x-os-csrf-token']);
  assert.deepEqual(calls[1][2].body, { duration: '7d' });
  assert.equal(calls[1][2].correlationId, headers['x-os-correlation-id']);
});

test('HTTP session event history forwards one bounded query and rejects query ambiguity', async (t) => {
  const calls = [];
  const projection = { items: [{
    id: 17, session_id: sessionId, event: 'login', result: 'ok', occurred_at: now.toISOString(),
  }] };
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('generic session resolution must not run'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async listSessionEvents(request, input) { calls.push([request, input]); return projection; },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/identity/session/events';
  const headers = {
    cookie: '__Host-opensphere-session=opaque-session-events',
    'x-os-correlation-id': 'session-events-http-0001',
  };
  const response = await fetch(endpoint + '?limit=50', { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), projection);
  assert.equal(calls[0][0].headers.cookie, headers.cookie);
  assert.deepEqual(calls[0][1], { limit: '50', correlationId: headers['x-os-correlation-id'] });
  assert.equal((await fetch(endpoint + '?limit=10&limit=20', { headers })).status, 400);
  assert.equal((await fetch(endpoint + '?cursor=1', { headers })).status, 400);
  assert.equal(calls.length, 1);
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
      'x-os-correlation-id': 'session-mfa-http-0001',
    },
    body: JSON.stringify({ code: '123456' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(calls[0].request.headers['x-os-csrf-token'], 'csrf-proof-for-mfa-completion');
  assert.deepEqual(calls[0].body, { code: '123456' });
});

test('HTTP TOTP enrollment routes preserve exact Web paths, bodies, CSRF proof, and status codes', async (t) => {
  const calls = { begin: [], verify: [] };
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('generic resolution must not run'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async beginTotpEnrollment(input) {
        calls.begin.push(input);
        return { factorId: 'factor-1', secret: 'JBSWY3DPEHPK3PXP', qrCode: '', uri: 'otpauth://totp/OpenSphere' };
      },
      async verifyTotpEnrollment(input) {
        calls.verify.push(input);
        return { assurance: 'aal2', sessionId };
      },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/identity/session/totp';
  const headers = {
    cookie: '__Host-opensphere-session=opaque',
    'x-os-csrf-token': 'csrf-proof-for-totp-enrollment',
    'content-type': 'application/json',
    'x-os-correlation-id': 'totp-enrollment-http-0001',
  };
  const enrollment = await fetch(base + '/enrollment', {
    method: 'POST', headers, body: JSON.stringify({ friendlyName: 'OpenSphere Console' }),
  });
  assert.equal(enrollment.status, 201);
  assert.equal((await enrollment.json()).factorId, 'factor-1');
  assert.deepEqual(calls.begin[0].body, { friendlyName: 'OpenSphere Console' });
  assert.equal(calls.begin[0].request.headers['x-os-csrf-token'], headers['x-os-csrf-token']);
  const verification = await fetch(base + '/verification', {
    method: 'POST', headers, body: JSON.stringify({ factorId: 'factor-1', code: '123456' }),
  });
  assert.equal(verification.status, 200);
  assert.deepEqual(await verification.json(), { assurance: 'aal2', sessionId });
  assert.deepEqual(calls.verify[0].body, { factorId: 'factor-1', code: '123456' });
  assert.equal(calls.verify[0].request.headers['x-os-csrf-token'], headers['x-os-csrf-token']);
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

test('HTTP owned-session routes preserve the CSRF boundary and clear cookies only for the current session', async (t) => {
  const otherSessionId = '33333333-3333-4333-8333-333333333333';
  const calls = { list: [], revoke: [], revokeAll: [] };
  const projection = {
    items: [{
      id: sessionId, current: true, status: 'active', assurance: 'aal1', persistence: '24h',
      createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
      idleExpiresAt: '2026-09-02T12:00:00.000Z', absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
      userAgentDigest: null,
    }],
  };
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('generic resolution must not run'); },
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {
      async listSessions(request) { calls.list.push(request); return projection; },
      async revokeSession(request, input) { calls.revoke.push({ request, input }); return { current: false }; },
      async revokeAllSessions(request, input) { calls.revokeAll.push({ request, input }); return { current: true, revokedCount: 2 }; },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/identity/sessions';
  const proofHeaders = {
    cookie: '__Host-opensphere-session=opaque',
    'x-os-csrf-token': 'csrf-proof-for-owned-session-revocation',
    'x-os-correlation-id': 'owned-session-http-correlation-0001',
  };

  const inventory = await fetch(base, { headers: { cookie: proofHeaders.cookie } });
  assert.equal(inventory.status, 200);
  assert.deepEqual(await inventory.json(), projection);
  assert.equal(calls.list.length, 1);

  const targeted = await fetch(base + '/' + otherSessionId, { method: 'DELETE', headers: proofHeaders });
  assert.equal(targeted.status, 204);
  assert.equal(targeted.headers.getSetCookie().length, 0);
  assert.equal(calls.revoke[0].input.targetSessionId, otherSessionId);
  assert.equal(calls.revoke[0].request.headers['x-os-csrf-token'], proofHeaders['x-os-csrf-token']);

  const all = await fetch(base, { method: 'DELETE', headers: proofHeaders });
  assert.equal(all.status, 204);
  assert.equal(all.headers.getSetCookie().length, 2);
  assert.equal(calls.revokeAll[0].request.headers['x-os-csrf-token'], proofHeaders['x-os-csrf-token']);
});
