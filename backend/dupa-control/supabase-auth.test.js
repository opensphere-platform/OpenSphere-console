const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createSupabaseVerifier } = require('./supabase-auth');

const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(secret, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const payload = enc({ sub: 'operator-1', iss: 'https://console.example/auth/v1', aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 300, aal: 'aal2', credential_revision: 4, ...overrides });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

test('Supabase verifier requires a live active operator, role, and MFA token', async () => {
  const secret = 'test-secret';
  const verifier = createSupabaseVerifier({
    issuer: 'https://console.example/auth/v1', audience: 'authenticated', jwtSecret: secret,
    restUrl: 'http://rest.example', serviceRoleKey: 'service-role',
    fetch: async (url) => url.includes('/operator?')
      ? new Response(JSON.stringify([{ status: 'active', credential_revision: 4 }]), { status: 200 })
      : new Response(JSON.stringify([{ expires_at: null, role: { code: 'console-admins' } }]), { status: 200 }),
  });
  const actor = await verifier(token(secret));
  assert.equal(actor.provider, 'supabase');
  assert.equal(actor.assurance, 'aal2');
  assert.deepEqual(actor.groups, ['console-admins']);
});
