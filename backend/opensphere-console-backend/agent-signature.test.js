'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  SCHEME,
  MAX_BODY_BYTES,
  bodyDigest,
  canonicalString,
  sign,
  signatureMatches,
  parseHeartbeatPath,
  createNonceCache,
  MAX_AGENT_KEYS,
  parseAgentKeyDocument,
  createAgentKeyResolver,
  verifyAgentRequest,
} = require('./agent-signature');

const SECRET = '0123456789abcdef0123456789abcdef';
const OTHER_SECRET = 'fedcba9876543210fedcba9876543210';
const NOW = 1774483200;
const allowed = new Set(['cc2']);

function keyDocument(overrides = {}) {
  return JSON.stringify({
    version: 1,
    keys: [
      { keyId: 'cc2-node-a-2026a', secret: SECRET, controlCenterId: 'cc2', hostId: 'node-a', ...overrides },
      { keyId: 'cc2-node-b-2026a', secret: OTHER_SECRET, controlCenterId: 'cc2', hostId: 'node-b' },
      { keyId: 'cc2-node-a-2025z', secret: OTHER_SECRET, controlCenterId: 'cc2', hostId: 'node-a', status: 'revoked' },
    ],
  });
}

function signedRequest(body = '{}', overrides = {}) {
  const raw = Buffer.from(body, 'utf8');
  const base = {
    method: 'POST',
    path: '/api/control-centers/cc2/hosts/node-a/heartbeat',
    keyId: 'cc2-node-a-2026a',
    timestamp: String(NOW),
    nonce: '0123456789abcdef0123456789abcdef',
    controlCenterId: 'cc2',
    hostId: 'node-a',
    bodySha256: bodyDigest(raw),
  };
  const signedFields = { ...base, ...overrides.signed };
  const signature = overrides.signature ?? sign(overrides.secret ?? SECRET, signedFields);
  const headers = {
    'x-rcc-key-id': signedFields.keyId,
    'x-rcc-timestamp': signedFields.timestamp,
    'x-rcc-nonce': signedFields.nonce,
    'x-rcc-control-center': signedFields.controlCenterId,
    'x-rcc-host': signedFields.hostId,
    'x-rcc-agent-version': '0.1.0-cc2',
    'x-rcc-signature': signature,
    ...overrides.headers,
  };
  return {
    req: { method: overrides.method ?? 'POST', url: overrides.url ?? base.path, headers },
    body: raw,
  };
}

function verify(fixture, extra = {}) {
  return verifyAgentRequest({
    req: fixture.req,
    body: fixture.body,
    resolveKey: createAgentKeyResolver(parseAgentKeyDocument(keyDocument())),
    allowedControlCenters: allowed,
    nonceCache: extra.nonceCache ?? createNonceCache(),
    nowSeconds: extra.nowSeconds ?? NOW,
    ...extra.options,
  });
}

test('canonical string matches the Go agent contract byte for byte', () => {
  const canonical = canonicalString({
    method: 'POST',
    path: '/api/control-centers/cc2/hosts/node-a/heartbeat',
    keyId: 'cc2-node-a-2026a',
    timestamp: '1774483200',
    nonce: '0123456789abcdef0123456789abcdef',
    controlCenterId: 'cc2',
    hostId: 'node-a',
    bodySha256: bodyDigest('{}'),
  });
  assert.equal(canonical.split('\n').length, 9);
  assert.equal(canonical.split('\n')[0], SCHEME);
  // Known-answer vector shared with backend/rcc-node-agent signing_test.go.
  assert.equal(sign(SECRET, {
    method: 'POST',
    path: '/api/control-centers/cc2/hosts/node-a/heartbeat',
    keyId: 'cc2-node-a-2026a',
    timestamp: '1774483200',
    nonce: '0123456789abcdef0123456789abcdef',
    controlCenterId: 'cc2',
    hostId: 'node-a',
    bodySha256: bodyDigest('{}'),
  }), 'gahlzCZgpXSuYq8mz8/dMEdwb806H23+MPKdgokRPNI=');
});

test('canonical string fails closed on malformed fields', () => {
  const base = {
    method: 'POST',
    path: '/api/control-centers/cc2/hosts/node-a/heartbeat',
    keyId: 'cc2-node-a-2026a',
    timestamp: '1774483200',
    nonce: '0123456789abcdef0123456789abcdef',
    controlCenterId: 'cc2',
    hostId: 'node-a',
    bodySha256: bodyDigest('{}'),
  };
  for (const patch of [
    { method: 'post' },
    { path: '/api/control-centers/cc2/hosts/node-a/heartbeat?x=1' },
    { path: 'api/hosts' },
    { keyId: '' },
    { timestamp: 'now' },
    { nonce: 'short' },
    { controlCenterId: 'CC2' },
    { hostId: 'node_a' },
    { bodySha256: 'not-a-digest' },
    { keyId: undefined },
  ]) {
    assert.throws(() => canonicalString({ ...base, ...patch }), (e) => e.code === 401, JSON.stringify(patch));
  }
});

test('parses only the bounded heartbeat path', () => {
  assert.deepEqual(parseHeartbeatPath('/api/control-centers/cc2/hosts/node-a/heartbeat', allowed), {
    controlCenterId: 'cc2',
    hostId: 'node-a',
    path: '/api/control-centers/cc2/hosts/node-a/heartbeat',
  });
  for (const [url, code] of [
    ['/api/control-centers/cc2/hosts/node-a/heartbeat?token=abc', 400],
    ['/api/control-centers/cc2/hosts/node-a/heartbeat#x', 400],
    ['/api/control-centers/cc2/hosts/%6Eode-a/heartbeat', 400],
    ['/api/control-centers/cc1/hosts/node-a/heartbeat', 404],
    ['/api/control-centers/cc2/hosts/node-a/exec', 404],
    ['/api/control-centers/cc2/hosts/Node-A/heartbeat', 404],
    ['/api/control-centers/cc2/hosts/../../etc/heartbeat', 404],
    ['/api/control-centers/cc2/k8s/api/v1/pods', 404],
  ]) {
    assert.throws(() => parseHeartbeatPath(url, allowed), (e) => e.code === code, url);
  }
  assert.throws(() => parseHeartbeatPath('/x'.repeat(400), allowed), (e) => e.code === 400);
});

test('accepts a correctly signed heartbeat and returns the binding', () => {
  const result = verify(signedRequest('{"schemaVersion":"rcc.host.snapshot/v1"}'));
  assert.deepEqual(
    { keyId: result.keyId, controlCenterId: result.controlCenterId, hostId: result.hostId, agentVersion: result.agentVersion },
    { keyId: 'cc2-node-a-2026a', controlCenterId: 'cc2', hostId: 'node-a', agentVersion: '0.1.0-cc2' },
  );
  assert.match(result.bodySha256, /^[0-9a-f]{64}$/);
});

test('rejects browser credentials on the agent endpoint', () => {
  for (const headers of [{ authorization: 'Bearer eyJhbGciOi.x.y' }, { cookie: 'sb-access-token=abc' }]) {
    assert.throws(() => verify(signedRequest('{}', { headers })), (e) => e.code === 401);
  }
});

test('rejects non-POST methods', () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    assert.throws(() => verify(signedRequest('{}', { method })), (e) => e.code === 405, method);
  }
});

test('rejects a tampered body, path, host or key binding', () => {
  const fixture = signedRequest('{"a":1}');
  fixture.body = Buffer.from('{"a":2}', 'utf8');
  assert.throws(() => verify(fixture), (e) => e.code === 401);

  // Signature computed for node-a replayed against node-b's path.
  const crossHost = signedRequest('{}');
  crossHost.req.url = '/api/control-centers/cc2/hosts/node-b/heartbeat';
  crossHost.req.headers['x-rcc-host'] = 'node-b';
  assert.throws(() => verify(crossHost), (e) => e.code === 401);

  // Binding headers must match the URL.
  const mismatched = signedRequest('{}', { headers: { 'x-rcc-host': 'node-b' } });
  assert.throws(() => verify(mismatched), (e) => e.code === 401);

  // A valid key for another host must not sign for node-a.
  const wrongKey = signedRequest('{}', {
    secret: OTHER_SECRET,
    signed: { keyId: 'cc2-node-b-2026a' },
    headers: { 'x-rcc-key-id': 'cc2-node-b-2026a' },
  });
  assert.throws(() => verify(wrongKey), (e) => e.code === 401);
});

test('rejects unknown and revoked keys identically', () => {
  const unknown = signedRequest('{}', {
    signed: { keyId: 'cc2-node-z-9999a' },
    headers: { 'x-rcc-key-id': 'cc2-node-z-9999a' },
  });
  const revoked = signedRequest('{}', {
    secret: OTHER_SECRET,
    signed: { keyId: 'cc2-node-a-2025z' },
    headers: { 'x-rcc-key-id': 'cc2-node-a-2025z' },
  });
  for (const fixture of [unknown, revoked]) {
    assert.throws(() => verify(fixture), (e) => e.code === 401 && e.msg === 'agent key is not accepted');
  }
});

test('rejects stale and future timestamps', () => {
  assert.throws(() => verify(signedRequest('{}'), { nowSeconds: NOW + 301 }), (e) => e.code === 401);
  assert.throws(() => verify(signedRequest('{}'), { nowSeconds: NOW - 301 }), (e) => e.code === 401);
  assert.ok(verify(signedRequest('{}'), { nowSeconds: NOW + 299 }));
  assert.ok(verify(signedRequest('{}'), { nowSeconds: NOW - 299 }));
});

test('rejects a replayed nonce but allows a fresh one', () => {
  const nonceCache = createNonceCache();
  assert.ok(verify(signedRequest('{}'), { nonceCache }));
  assert.throws(() => verify(signedRequest('{}'), { nonceCache }), (e) => e.code === 409);

  const fresh = signedRequest('{}', { signed: { nonce: 'ffffffffffffffffffffffffffffffff' } });
  fresh.req.headers['x-rcc-nonce'] = 'ffffffffffffffffffffffffffffffff';
  assert.ok(verify(fresh, { nonceCache }));
});

test('an invalid signature never claims a nonce', () => {
  const nonceCache = createNonceCache();
  const forged = signedRequest('{}', { secret: OTHER_SECRET });
  assert.throws(() => verify(forged, { nonceCache }), (e) => e.code === 401);
  assert.equal(nonceCache.size(), 0);
  assert.ok(verify(signedRequest('{}'), { nonceCache }));
});

test('nonce cache is bounded and evicts oldest first', () => {
  const cache = createNonceCache({ capacity: 4 });
  for (let i = 0; i < 40; i += 1) {
    assert.equal(cache.claim('k', `nonce${String(i).padStart(16, '0')}`, NOW), true);
  }
  assert.ok(cache.sizeFor('k') <= 4, `partition grew to ${cache.sizeFor('k')}`);
});

test('one key flooding the cache cannot evict another key nonce', () => {
  const cache = createNonceCache({ capacity: 4 });
  const victim = 'aaaaaaaaaaaaaaaa';
  assert.equal(cache.claim('quiet-host', victim, NOW), true);

  // A compromised or merely chatty host signs far more than its own budget.
  for (let i = 0; i < 500; i += 1) {
    assert.equal(cache.claim('noisy-host', `nonce${String(i).padStart(16, '0')}`, NOW), true);
  }

  // The quiet host's nonce must still be claimed, so its captured request
  // cannot be replayed on the back of another key's traffic.
  assert.equal(cache.claim('quiet-host', victim, NOW), false);
  assert.equal(cache.sizeFor('quiet-host'), 1);
  assert.ok(cache.sizeFor('noisy-host') <= 4);
});

test('nonce partitions are bounded and excess keys are refused, not evicted', () => {
  const cache = createNonceCache({ capacity: 4, maxKeys: 3 });
  const accepted = [];
  for (let i = 0; i < 50; i += 1) {
    if (cache.claim(`key-${i}`, 'aaaaaaaaaaaaaaaa', NOW)) accepted.push(i);
  }
  // Only the first maxKeys keys get a partition; the rest are refused so no
  // live nonce is ever discarded to make room.
  assert.deepEqual(accepted, [0, 1, 2]);
  assert.equal(cache.keyCount(), 3);
  assert.ok(cache.size() <= 12);
});

test('expired partitions are dropped without disturbing live keys', () => {
  const cache = createNonceCache({ ttlSeconds: 60 });
  assert.equal(cache.claim('gone', 'aaaaaaaaaaaaaaaa', NOW), true);
  assert.equal(cache.claim('live', 'bbbbbbbbbbbbbbbb', NOW + 120), true);
  assert.equal(cache.keyCount(), 1, 'the expired key partition should be reclaimed');
  assert.equal(cache.claim('live', 'bbbbbbbbbbbbbbbb', NOW + 130), false);
});

test('nonce cache expires entries outside the window', () => {
  const cache = createNonceCache({ ttlSeconds: 60 });
  assert.equal(cache.claim('k', 'aaaaaaaaaaaaaaaa', NOW), true);
  assert.equal(cache.claim('k', 'aaaaaaaaaaaaaaaa', NOW + 10), false);
  assert.equal(cache.claim('k', 'aaaaaaaaaaaaaaaa', NOW + 120), true);
});

test('rejects malformed signature encodings without throwing', () => {
  const signed = {
    method: 'POST',
    path: '/api/control-centers/cc2/hosts/node-a/heartbeat',
    keyId: 'cc2-node-a-2026a',
    timestamp: String(NOW),
    nonce: '0123456789abcdef0123456789abcdef',
    controlCenterId: 'cc2',
    hostId: 'node-a',
    bodySha256: bodyDigest('{}'),
  };
  for (const bad of ['', 'not base64!!', 'AAAA', null, undefined, 42, 'A'.repeat(43) + '=']) {
    assert.equal(signatureMatches(SECRET, signed, bad), false);
  }
  assert.equal(signatureMatches(SECRET, signed, sign(SECRET, signed)), true);
});

test('rejects oversized payloads', () => {
  const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
  const fixture = signedRequest('{}');
  fixture.body = big;
  assert.throws(() => verify(fixture), (e) => e.code === 413);
});

test('rejects malformed header values before touching key material', () => {
  for (const [headers, code] of [
    [{ 'x-rcc-key-id': 'bad key' }, 401],
    [{ 'x-rcc-key-id': '' }, 401],
    [{ 'x-rcc-timestamp': 'yesterday' }, 401],
    [{ 'x-rcc-nonce': 'tooshort' }, 401],
    [{ 'x-rcc-nonce': 'not-hex-and-way-too-long'.repeat(10) }, 401],
  ]) {
    assert.throws(
      () =>
        verifyAgentRequest({
          ...signedRequest('{}', { headers }),
          resolveKey: () => {
            throw new Error('key material must not be resolved for malformed headers');
          },
          allowedControlCenters: allowed,
          nonceCache: createNonceCache(),
          nowSeconds: NOW,
        }),
      (e) => e.code === code,
      JSON.stringify(headers),
    );
  }
});

test('fails closed when no key material is configured', () => {
  assert.throws(
    () =>
      verifyAgentRequest({
        ...signedRequest('{}'),
        resolveKey: null,
        allowedControlCenters: allowed,
        nonceCache: createNonceCache(),
        nowSeconds: NOW,
      }),
    (e) => e.code === 503,
  );
});

test('key document parsing supports rotation and rejects weak or malformed entries', () => {
  const keys = parseAgentKeyDocument(keyDocument());
  assert.equal(keys.size, 3);
  assert.equal(keys.get('cc2-node-a-2025z').status, 'revoked');
  // Two active keys for the same host is a valid rotation state.
  const rotating = JSON.stringify({
    version: 1,
    keys: [
      { keyId: 'cc2-node-a-2026a', secret: SECRET, controlCenterId: 'cc2', hostId: 'node-a' },
      { keyId: 'cc2-node-a-2026b', secret: OTHER_SECRET, controlCenterId: 'cc2', hostId: 'node-a' },
    ],
  });
  assert.equal(parseAgentKeyDocument(rotating).size, 2);

  for (const bad of [
    'not json',
    JSON.stringify({ version: 2, keys: [] }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, keys: [{ keyId: 'k', secret: 'short', controlCenterId: 'cc2', hostId: 'node-a' }] }),
    JSON.stringify({ version: 1, keys: [{ keyId: 'bad id', secret: SECRET, controlCenterId: 'cc2', hostId: 'node-a' }] }),
    JSON.stringify({ version: 1, keys: [{ keyId: 'k1', secret: SECRET, controlCenterId: 'CC2', hostId: 'node-a' }] }),
    JSON.stringify({ version: 1, keys: [{ keyId: 'k1', secret: SECRET, controlCenterId: 'cc2', hostId: 'Node' }] }),
    JSON.stringify({ version: 1, keys: [{ keyId: 'k1', secret: SECRET, controlCenterId: 'cc2', hostId: 'node-a', status: 'maybe' }] }),
    JSON.stringify({
      version: 1,
      keys: [
        { keyId: 'k1', secret: SECRET, controlCenterId: 'cc2', hostId: 'node-a' },
        { keyId: 'k1', secret: OTHER_SECRET, controlCenterId: 'cc2', hostId: 'node-a' },
      ],
    }),
  ]) {
    assert.throws(() => parseAgentKeyDocument(bad), /agent key|not valid JSON|must be/, bad.slice(0, 60));
  }
});

test('module never logs or returns raw key material', () => {
  const source = readFileSync(resolve(__dirname, 'agent-signature.js'), 'utf8');
  assert.ok(!/console\.(log|info|warn|error)/.test(source), 'agent signature module must not log');
  const result = verify(signedRequest('{}'));
  assert.ok(!Object.values(result).some((v) => typeof v === 'string' && v.includes(SECRET)));
});

test('a key document larger than the replay cache is rejected at parse time', () => {
  const key = (i) => ({
    keyId: `cc2-node-${String(i).padStart(4, '0')}`,
    secret: SECRET,
    controlCenterId: 'cc2',
    hostId: `node-${String(i).padStart(4, '0')}`,
  });

  const atLimit = { version: 1, keys: Array.from({ length: MAX_AGENT_KEYS }, (_, i) => key(i)) };
  assert.equal(parseAgentKeyDocument(JSON.stringify(atLimit)).size, MAX_AGENT_KEYS, 'the boundary itself must be accepted');

  const overLimit = { version: 1, keys: Array.from({ length: MAX_AGENT_KEYS + 1 }, (_, i) => key(i)) };
  assert.throws(
    () => parseAgentKeyDocument(JSON.stringify(overLimit)),
    /replay cache retains at most/,
    'an over-limit document must be refused rather than silently degrading replay protection',
  );
});

test('the replay cache never evicts a key partition to admit a new key', () => {
  const cache = createNonceCache({ capacity: 4, maxKeys: 2 });
  assert.equal(cache.claim('key-a', 'aaaaaaaaaaaaaaaa', NOW), true);
  assert.equal(cache.claim('key-b', 'bbbbbbbbbbbbbbbb', NOW), true);

  // A third key cannot be admitted, and admitting it must not cost key-a its
  // nonce; refusing is fail-closed, evicting would reopen replay for key-a.
  assert.equal(cache.claim('key-c', 'cccccccccccccccc', NOW), false);
  assert.equal(cache.keyCount(), 2);
  assert.equal(cache.claim('key-a', 'aaaaaaaaaaaaaaaa', NOW), false, 'key-a must still detect its own replay');
  assert.equal(cache.claim('key-b', 'bbbbbbbbbbbbbbbb', NOW), false, 'key-b must still detect its own replay');
});

test('partition budget frees up only when a partition genuinely expires', () => {
  const cache = createNonceCache({ capacity: 4, maxKeys: 1, ttlSeconds: 60 });
  assert.equal(cache.claim('old', 'aaaaaaaaaaaaaaaa', NOW), true);
  assert.equal(cache.claim('new', 'bbbbbbbbbbbbbbbb', NOW), false, 'budget is full while the first key is live');
  // Past the TTL the first partition holds nothing replayable, so reclaiming it
  // cannot weaken protection.
  assert.equal(cache.claim('new', 'bbbbbbbbbbbbbbbb', NOW + 120), true);
  assert.equal(cache.keyCount(), 1);
});

test('the key document bound and the nonce partition bound agree', () => {
  // If these drift apart, a valid key document could exhaust the partitions.
  const cache = createNonceCache();
  for (let i = 0; i < MAX_AGENT_KEYS; i += 1) {
    assert.equal(cache.claim(`key-${i}`, 'aaaaaaaaaaaaaaaa', NOW), true, `key ${i} must fit`);
  }
  assert.equal(cache.keyCount(), MAX_AGENT_KEYS);
});
