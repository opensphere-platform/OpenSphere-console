'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserSessionManager, sha256 } = require('./browser-session');

function harness({ verifiedFactor = false, operatorStatus = 'active' } = {}) {
  let row = null;
  const additionalRows = [];
  let currentTime = '2026-07-27T00:00:00.000Z';
  let authorityOutage = false;
  let verifierMode = 'normal';
  let refreshMode = 'success';
  let refreshCalls = 0;
  const events = [];
  const restRequest = async (resource, options = {}) => {
    if (authorityOutage) throw { code: 503, msg: 'Supabase unavailable' };
    if (resource === 'session_event') {
      if (options.method === 'POST') events.push(...options.body);
      return [];
    }
    if (resource === 'operator') return [{
      user_id: '22222222-2222-4222-8222-222222222222',
      status: operatorStatus,
      disabled_at: operatorStatus === 'disabled' ? currentTime : null,
      credential_revision: 0,
    }];
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
      const id = decodeURIComponent(String(options.query).match(/id=eq\.([^&]+)/)?.[1] || '');
      const target = [row, ...additionalRows].find((item) => item?.id === id) || row;
      if (!target || !['active', 'pending_mfa'].includes(target.status)) return [];
      Object.assign(target, options.body);
      return options.prefer === 'return=representation' ? [{ id: target.id, ...options.body }] : [];
    }
    if (String(options.query).includes('handle_hash=eq.')) {
      const expected = String(options.query).match(/handle_hash=eq\.([^&]+)/)?.[1];
      return row && row.handle_hash === expected ? [row] : [];
    }
    if (String(options.query).includes('owner_id=eq.')) return row ? [row, ...additionalRows] : [];
    return [];
  };
  const verifyToken = async (token) => {
    if (verifierMode === 'outage') throw { code: 503, msg: 'Supabase authorization unavailable' };
    if (verifierMode === 'expired' && token === 'access-a') {
      throw { code: 401, reason: 'token_expired', msg: 'token expired' };
    }
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
      refreshCalls += 1;
      if (refreshMode === 'outage') throw { code: 500, msg: 'database unavailable' };
      if (refreshMode === 'rejected') throw { code: 400, msg: 'invalid refresh token' };
      if (refreshMode === 'concurrent') {
        if (refreshCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 40));
          throw { code: 400, msg: 'refresh token already rotated' };
        }
      }
      assert.ok(['legacy-refresh', 'refresh-a'].includes(options.body.refresh_token));
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
    now: () => new Date(currentTime),
    logger: { info() {}, warn() {}, error() {} },
  });
  return {
    manager,
    row: () => row,
    events: () => events,
    refreshCalls: () => refreshCalls,
    setAuthorityOutage: (value) => { authorityOutage = value; },
    setVerifierMode: (value) => { verifierMode = value; },
    setRefreshMode: (value) => { refreshMode = value; },
    setNow: (value) => { currentTime = value; },
    addSession: (value) => { additionalRows.push(value); },
  };
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

test('durable execution independently rejects a disabled operator even with an active session token', async () => {
  const active = harness();
  await active.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com', password: 'not-persisted', duration: '24h',
  });
  assert.equal((await active.manager.resolveForDurableExecution(
    active.row().id, '22222222-2222-4222-8222-222222222222',
  )).active, true);

  const disabled = harness({ operatorStatus: 'disabled' });
  await disabled.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com', password: 'not-persisted', duration: '24h',
  });
  const denied = await disabled.manager.resolveForDurableExecution(
    disabled.row().id, '22222222-2222-4222-8222-222222222222',
  );
  assert.deepEqual(denied, {
    active: false, actorId: '22222222-2222-4222-8222-222222222222', code: 'OperatorInactive',
  });
});

test('uses a 24-hour default without removing shorter or trusted-device choices', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
  });
  assert.equal(created.session.persistence, '24h');
  assert.equal(created.session.idleExpiresAt, '2026-07-27T12:00:00.000Z');
  assert.equal(created.session.absoluteExpiresAt, '2026-07-28T00:00:00.000Z');
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

test('background authentication does not extend idle time while explicit user activity does', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  const cookie = `__Host-opensphere_session=${encodeURIComponent(handle)}`;
  const originalIdle = h.row().idle_expires_at;
  h.setNow('2026-07-27T00:10:00.000Z');
  await h.manager.authenticate(request({ cookie }));
  assert.equal(h.row().last_seen_at, '2026-07-27T00:00:00.000Z');
  assert.equal(h.row().idle_expires_at, originalIdle);
  const touched = await h.manager.touch(request({
    cookie,
    csrf: created.csrfToken,
    method: 'POST',
  }));
  assert.equal(touched.session.lastSeenAt, '2026-07-27T00:10:00.000Z');
  assert.equal(touched.session.idleExpiresAt, '2026-07-27T12:10:00.000Z');
});

test('records exact expiry cause and removes stale sessions from active inventory', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  h.addSession({
    id: '33333333-3333-4333-8333-333333333333',
    owner_id: h.row().owner_id,
    status: 'active',
    assurance: 'aal2',
    persistence: '8h',
    created_at: '2026-07-26T00:00:00.000Z',
    last_seen_at: '2026-07-26T00:10:00.000Z',
    idle_expires_at: '2026-07-26T00:40:00.000Z',
    absolute_expires_at: '2026-07-26T08:00:00.000Z',
    user_agent_digest: null,
  });
  const result = await h.manager.list(request({
    cookie: `__Host-opensphere_session=${encodeURIComponent(handle)}`,
  }));
  assert.deepEqual(result.items.map((item) => item.id), [h.row().id]);
  assert.equal(h.events().some((event) => event.event === 'expired_absolute'), true);
});

test('keeps only a previously verified GET session during authority outage and fails mutations closed', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: '8h',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  const cookie = `__Host-opensphere_session=${encodeURIComponent(handle)}`;
  const live = await h.manager.authenticate(request({ cookie }));
  assert.equal(live.authorityDegraded, undefined);
  h.setAuthorityOutage(true);
  const degraded = await h.manager.authenticate(request({ cookie }));
  assert.equal(degraded.authorityDegraded, true);
  assert.equal(degraded.actor.sub, live.actor.sub);
  assert.equal(h.manager.cachedActorForAccessToken(degraded.accessToken).authorityDegraded, true);
  await assert.rejects(
    h.manager.authenticate(request({ cookie, csrf: created.csrfToken, method: 'POST' })),
    (error) => error.code === 503,
  );
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

test('rehydrates recent aal2 only for the exact token forwarded by an owner service', async () => {
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

  const verifiedActor = {
    sub: '22222222-2222-4222-8222-222222222222',
    username: 'operator@example.com',
    assurance: 'aal2',
    authSessionId: 'supabase-session',
    credentialRevision: 0,
    groups: ['console-admins'],
  };
  const delegated = await h.manager.actorForForwardedAccessToken('access-aal2', verifiedActor);
  assert.equal(delegated.provider, 'supabase-browser-owner-delegation');
  assert.equal(delegated.lastReauthenticatedAt, '2026-07-27T00:00:00.000Z');
  assert.equal(delegated.browserSessionId, h.row().id);

  assert.equal(await h.manager.actorForForwardedAccessToken('access-a', {
    ...verifiedActor,
    assurance: 'aal1',
  }), null);
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

test('does not rotate or revoke a valid browser session when live authorization is unavailable', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: '8h',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  h.setVerifierMode('outage');
  await assert.rejects(
    h.manager.authenticate(request({
      cookie: `__Host-opensphere_session=${encodeURIComponent(handle)}`,
    })),
    (error) => error.code === 503,
  );
  assert.equal(h.refreshCalls(), 0);
  assert.equal(h.row().status, 'active');
  assert.equal(h.events().some((event) => event.event === 'reuse_detected'), false);
});

test('preserves an expired browser session when Supabase refresh has a transient 5xx', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: '8h',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  h.setVerifierMode('expired');
  h.setRefreshMode('outage');
  await assert.rejects(
    h.manager.authenticate(request({
      cookie: `__Host-opensphere_session=${encodeURIComponent(handle)}`,
    })),
    (error) => error.code === 503 && /preserved/.test(error.msg),
  );
  assert.equal(h.refreshCalls(), 1);
  assert.equal(h.row().status, 'active');
  assert.equal(h.events().some((event) => event.event === 'refresh_rejected'), false);
});

test('two concurrent refresh callers adopt the peer rotation instead of revoking the session', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: '8h',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  const req = request({
    cookie: `__Host-opensphere_session=${encodeURIComponent(handle)}`,
  });
  h.setVerifierMode('expired');
  h.setRefreshMode('concurrent');
  const results = await Promise.all([
    h.manager.authenticate(req),
    h.manager.authenticate(req),
  ]);
  assert.equal(results.every((result) => result.actor.sub === '22222222-2222-4222-8222-222222222222'), true);
  assert.equal(h.refreshCalls(), 2);
  assert.equal(h.row().status, 'active');
  assert.equal(h.events().some((event) => event.event === 'refresh_rejected'), false);
});

test('revokes only after an explicit refresh rejection remains current after peer recheck', async () => {
  const h = harness();
  const created = await h.manager.create(request({ method: 'POST' }), {
    email: 'operator@example.com',
    password: 'not-persisted',
    duration: '8h',
  });
  const handle = decodeURIComponent(created.cookies[0].match(/^__Host-opensphere_session=([^;]+)/)[1]);
  h.setVerifierMode('expired');
  h.setRefreshMode('rejected');
  await assert.rejects(
    h.manager.authenticate(request({
      cookie: `__Host-opensphere_session=${encodeURIComponent(handle)}`,
    })),
    (error) => error.code === 401 && /explicitly rejected/.test(error.msg),
  );
  assert.equal(h.row().status, 'revoked');
  assert.equal(h.events().some((event) => event.event === 'refresh_rejected'), true);
  assert.equal(h.events().some((event) => event.event === 'reuse_detected'), false);
});
