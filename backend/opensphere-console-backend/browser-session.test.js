'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserSessionManager, sha256 } = require('./browser-session');

function harness({ verifiedFactor = false } = {}) {
  let row = null;
  const restRequest = async (resource, options = {}) => {
    assert.equal(resource, 'browser_session');
    if (options.method === 'POST') {
      row = {
        id: '11111111-1111-4111-8111-111111111111',
        created_at: '2026-07-27T00:00:00.000Z',
        last_seen_at: '2026-07-27T00:00:00.000Z',
        ...options.body[0],
      };
      return [row];
    }
    if (options.method === 'PATCH') {
      Object.assign(row, options.body);
      return options.prefer === 'return=representation' ? [{ id: row.id }] : [];
    }
    if (String(options.query).includes('handle_hash=eq.')) {
      const expected = String(options.query).match(/handle_hash=eq\.([^&]+)/)?.[1];
      return row && row.handle_hash === expected ? [row] : [];
    }
    if (String(options.query).includes('owner_id=eq.')) return row ? [row] : [];
    return [];
  };
  const verifyToken = async (token) => {
    if (!['access-a', 'access-aal2', 'access-refreshed'].includes(token)) throw { code: 401, msg: 'expired' };
    return {
      sub: '22222222-2222-4222-8222-222222222222',
      username: 'operator@example.com',
      assurance: token === 'access-aal2' ? 'aal2' : 'aal1',
      authSessionId: 'supabase-session',
      credentialRevision: 0,
      groups: ['console-admins'],
    };
  };
  const authRequest = async (path, options = {}) => {
    if (path === '/token' && options.query === 'grant_type=password') {
      return { access_token: 'access-a', refresh_token: 'refresh-a', user: { id: 'user' } };
    }
    if (path === '/token' && options.query === 'grant_type=refresh_token') {
      assert.equal(options.body.refresh_token, 'legacy-refresh');
      return { access_token: 'access-refreshed', refresh_token: 'refresh-rotated', user: { id: 'user' } };
    }
    if (path === '/user') {
      return {
        factors: verifiedFactor
          ? [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }]
          : [],
      };
    }
    if (path.endsWith('/challenge')) return { id: 'challenge-1' };
    if (path.endsWith('/verify')) return { access_token: 'access-aal2', refresh_token: 'refresh-aal2' };
    throw new Error(`unexpected auth request ${path}`);
  };
  const manager = createBrowserSessionManager({
    restRequest,
    verifyToken,
    authRequest,
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    publicOrigin: 'https://console.example.test',
    now: () => new Date('2026-07-27T00:00:00.000Z'),
  });
  return { manager, row: () => row };
}

function request({ cookie = '', csrf = '', method = 'GET' } = {}) {
  return {
    method,
    headers: {
      cookie,
      origin: 'https://console.example.test',
      'x-os-csrf-token': csrf,
      'user-agent': 'OpenSphere test browser',
      'x-forwarded-for': '10.10.1.44',
    },
    socket: {},
  };
}

test('creates an opaque Secure browser session and encrypts Supabase tokens', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: '24h',
  });
  assert.equal(created.mfaRequired, false);
  assert.equal(created.session.persistence, '24h');
  assert.match(created.cookies[0], /^__Host-opensphere_session=/);
  assert.match(created.cookies[0], /HttpOnly/);
  assert.match(created.cookies[0], /Secure/);
  assert.match(created.cookies[0], /SameSite=Strict/);
  assert.match(created.cookies[1], /^__Host-opensphere_csrf=/);
  assert.doesNotMatch(h.row().access_token_ciphertext, /access-a/);
  assert.doesNotMatch(h.row().refresh_token_ciphertext, /refresh-a/);
  assert.equal(h.row().network_digest, sha256('10.10.1'));
});

test('authenticates through the opaque cookie and rejects a mutation without CSRF', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: '8h',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  const cookie = `__Host-opensphere_session=${encodeURIComponent(handle)}`;
  const authenticated = await h.manager.authenticate(request({ cookie }));
  assert.equal(authenticated.actor.sub, '22222222-2222-4222-8222-222222222222');
  await assert.rejects(
    h.manager.authenticate(request({ cookie, method: 'POST' })),
    (error) => error.code === 403 && /CSRF/.test(error.msg),
  );
  const accepted = await h.manager.authenticate(request({
    cookie,
    csrf: created.csrfToken,
    method: 'POST',
  }));
  assert.equal(accepted.actor.provider, 'supabase-browser-session');
});

test('keeps a verified TOTP login pending until an aal2 challenge succeeds', async () => {
  const h = harness({ verifiedFactor: true });
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: 'browser',
  });
  assert.equal(created.mfaRequired, true);
  assert.equal(h.row().status, 'pending_mfa');
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  const completed = await h.manager.completeMfa(request({
    cookie: `__Host-opensphere_session=${encodeURIComponent(handle)}`,
    csrf: created.csrfToken,
    method: 'POST',
  }), '123456');
  assert.equal(completed.assurance, 'aal2');
  assert.equal(h.row().status, 'active');
  assert.equal(h.row().assurance, 'aal2');
});

test('refreshes recent aal2 proof through the active browser session without exposing tokens', async () => {
  const h = harness({ verifiedFactor: true });
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: '8h',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  const req = request({
    cookie: `__Host-opensphere_session=${encodeURIComponent(handle)}`,
    csrf: created.csrfToken,
    method: 'POST',
  });
  await h.manager.completeMfa(req, '123456');
  const steppedUp = await h.manager.stepUp(req, '654321');
  assert.equal(steppedUp.assurance, 'aal2');
  assert.equal(h.row().last_reauthenticated_at, '2026-07-27T00:00:00.000Z');
  assert.doesNotMatch(h.row().access_token_ciphertext, /access-aal2/);
});

test('adopts one legacy browser session by rotating its refresh credential once', async () => {
  const h = harness();
  const adopted = await h.manager.adoptLegacy(request({ method: 'POST' }), {
    refreshToken: 'legacy-refresh',
  });
  assert.equal(adopted.mfaRequired, false);
  assert.match(adopted.cookies[0], /^__Host-opensphere_session=/);
  assert.equal(h.row().persistence, 'browser');
  assert.doesNotMatch(h.row().refresh_token_ciphertext, /legacy-refresh|refresh-rotated/);
});
