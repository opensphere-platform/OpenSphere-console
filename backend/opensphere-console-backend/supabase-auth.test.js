'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('crypto');
const { createSupabaseVerifier } = require('./supabase-auth');

const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(secret, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'HS256', typ: 'JWT' });
  const p = enc({ sub: '11111111-1111-4111-8111-111111111111', email: 'admin@example.test', iss: 'https://console.test/auth/v1', aud: 'authenticated', role: 'authenticated', aal: 'aal2', iat: now, exp: now + 300, credential_revision: 2, ...overrides });
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('Supabase verifier joins live operator and role state', async () => {
  const secret = 'test-secret-at-least-32-bytes-long';
  const verifier = createSupabaseVerifier({
    issuer: 'https://console.test/auth/v1', jwtSecret: secret,
    restUrl: 'http://rest.test', serviceRoleKey: 'server-only',
    fetch: async (url) => url.includes('/operator?')
      ? response([{ status: 'active', credential_revision: 2 }])
      : response([{ expires_at: null, role: { code: 'console-admins' } }]),
  });
  const actor = await verifier(token(secret));
  assert.equal(actor.provider, 'supabase');
  assert.equal(actor.assurance, 'aal2');
  assert.deepEqual(actor.groups, ['console-admins']);
});
test('Supabase verifier rejects disabled operators and revoked credential revisions', async () => {
  const secret = 'test-secret-at-least-32-bytes-long';
  const disabled = createSupabaseVerifier({
    issuer: 'https://console.test/auth/v1', jwtSecret: secret,
    restUrl: 'http://rest.test', serviceRoleKey: 'server-only',
    fetch: async (url) => url.includes('/operator?')
      ? response([{ status: 'disabled', credential_revision: 2 }]) : response([]),
  });
  await assert.rejects(disabled(token(secret)), (error) => error.code === 401);

  const revoked = createSupabaseVerifier({
    issuer: 'https://console.test/auth/v1', jwtSecret: secret,
    restUrl: 'http://rest.test', serviceRoleKey: 'server-only',
    fetch: async (url) => url.includes('/operator?')
      ? response([{ status: 'active', credential_revision: 3 }]) : response([]),
  });
  await assert.rejects(revoked(token(secret)), (error) => error.msg === 'credential revision revoked');
});

test('Supabase verifier fails closed when authorization state is unavailable', async () => {
  const secret = 'test-secret-at-least-32-bytes-long';
  const verifier = createSupabaseVerifier({
    issuer: 'https://console.test/auth/v1', jwtSecret: secret,
    restUrl: 'http://rest.test', serviceRoleKey: 'server-only',
    fetch: async () => response({}, 503),
  });
  await assert.rejects(verifier(token(secret)), (error) => error.code === 503);
});
