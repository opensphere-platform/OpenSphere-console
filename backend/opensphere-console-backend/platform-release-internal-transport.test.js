'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const tls = require('node:tls');
const {
  INTERNAL_AUTHORITY_CA_FILE,
  INTERNAL_AUTHORITY_HOST,
  INTERNAL_AUTHORITY_ORIGIN,
  exactAuthorityUrl,
  requestJson,
} = require('./platform-release-internal-transport');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function requestFixture({ statusCode = 200, response = { ok: true } } = {}) {
  const observed = {};
  const request = (url, options, callback) => {
    observed.url = url;
    observed.options = options;
    const req = new EventEmitter();
    req.setTimeout = (timeout, handler) => { observed.timeout = timeout; observed.timeoutHandler = handler; };
    req.destroy = (error) => req.emit('error', error);
    req.end = (payload) => {
      observed.payload = payload;
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.destroy = (error) => req.emit('error', error);
      callback(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(JSON.stringify(response)));
        res.emit('end');
      });
    };
    return req;
  };
  return { observed, request };
}

test('release workers use one exact TLS 1.3 authority with CA and SNI verification', async () => {
  const fixture = requestFixture();
  const ca = Buffer.from(`-----BEGIN CERTIFICATE-----\n${'A'.repeat(160)}\n-----END CERTIFICATE-----`);
  const result = await requestJson('/api/platform/reconcile/next', {
    method: 'POST', body: { reconciler: 'platform-release-reconciler', limit: 1 },
    authorization: 'Bearer projected-token', request: fixture.request,
    readFile: (path) => { assert.equal(path, INTERNAL_AUTHORITY_CA_FILE); return ca; },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(fixture.observed.url.origin, INTERNAL_AUTHORITY_ORIGIN);
  assert.equal(fixture.observed.options.servername, INTERNAL_AUTHORITY_HOST);
  assert.equal(fixture.observed.options.rejectUnauthorized, true);
  assert.equal(fixture.observed.options.minVersion, 'TLSv1.3');
  assert.equal(fixture.observed.options.maxVersion, 'TLSv1.3');
  assert.equal(fixture.observed.options.checkServerIdentity, tls.checkServerIdentity);
  assert.equal(fixture.observed.options.authorization, undefined);
  assert.equal(fixture.observed.options.headers.authorization, 'Bearer projected-token');
  assert.deepEqual(JSON.parse(fixture.observed.payload.toString('utf8')),
    { reconciler: 'platform-release-reconciler', limit: 1 });
});

test('plaintext, alternate host, redirect-like and unknown routes fail before transport', async () => {
  assert.throws(() => exactAuthorityUrl('/api/platform/reconcile/next',
    'http://opensphere-platform-release-authority.opensphere-console.svc.cluster.local:8446'),
  /not canonical/);
  assert.throws(() => exactAuthorityUrl('/api/platform/reconcile/next',
    'https://attacker.invalid:8446'), /not canonical/);
  assert.throws(() => exactAuthorityUrl('//attacker.invalid'), /not allowed/);
  assert.throws(() => exactAuthorityUrl('/api/platform/reconcile/unknown'), /not allowed/);
  assert.throws(() => requestJson('/api/platform/reconcile/next', {
    caFile: 'C:\\attacker-ca.pem', request: requestFixture().request,
  }), /CA path is not canonical/);
});

test('non-success response returns a stable error without redirect following', async () => {
  const fixture = requestFixture({ statusCode: 403, response: { error: 'identity denied' } });
  await assert.rejects(requestJson('/api/platform/reconcile/receipt', {
    method: 'POST', body: {}, request: fixture.request,
    readFile: () => Buffer.alloc(256, 1),
  }), (error) => error.status === 403 && error.message === 'identity denied');
  assert.equal(fixture.observed.options.maxRedirects, undefined);
});

test('Backend exposes release identities only on the dedicated TLS 1.3 listener', () => {
  assert.match(serverSource, /platformReleaseAuthorityServer = https\.createServer/);
  assert.match(serverSource, /minVersion: 'TLSv1\.3',[\s\S]+?maxVersion: 'TLSv1\.3'/);
  assert.match(serverSource, /platformReleaseAuthorityServer\.listen\(8446, '0\.0\.0\.0'/);
  assert.match(serverSource, /PLATFORM_RELEASE_AUTHORITY_CERT_FILE/);
  assert.match(serverSource, /PLATFORM_RELEASE_AUTHORITY_KEY_FILE/);
  assert.match(serverSource, /projectReconcileManifestForWorker/);
  assert.match(serverSource, /if \(isInternalReleaseReconciler\(String\(body\?\.reconciler/);
  assert.match(serverSource, /res\.writeHead\(404, \{ 'cache-control': 'no-store' \}\)/);
  assert.doesNotMatch(serverSource,
    /platformReleaseAuthorityServer[\s\S]+?\/api\/platform\/gitea\/webhook/);
});
