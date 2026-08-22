'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { authorizeR2d2ProxyRequest, originalR2d2Request } = require('./r2d2-proxy-auth');

function request(headers = {}) {
  return { method: 'GET', url: '/api/internal/r2d2-proxy-authn', headers };
}

test('opaque browser session is exchanged server-side for the R2D2 Gateway', async () => {
  const calls = [];
  const result = await authorizeR2d2ProxyRequest(request({
    'x-os-internal-authn-subrequest': 'r2d2-proxy-v1',
    'x-os-original-method': 'GET',
    'x-os-original-uri': '/api/osaa/health',
    cookie: '__Host-opensphere_session=opaque',
  }), {
    authenticateBrowser: async (forwarded) => {
      calls.push([forwarded.method, forwarded.url, forwarded.headers.cookie]);
      return { accessToken: 'short-lived-supabase-token' };
    },
    verifyBearer: async () => { throw new Error('bearer verifier must not run'); },
  });

  assert.deepEqual(calls, [['GET', '/api/osaa/health', '__Host-opensphere_session=opaque']]);
  assert.deepEqual(result, {
    authorization: 'Bearer short-lived-supabase-token',
    source: 'browser-session',
  });
});

test('original R2D2 mutation method and CSRF evidence reach session enforcement', async () => {
  let authenticatedRequest;
  await authorizeR2d2ProxyRequest(request({
    'x-os-internal-authn-subrequest': 'r2d2-proxy-v1',
    'x-os-original-method': 'POST',
    'x-os-original-uri': '/api/osaa/chat',
    'x-os-csrf-token': 'csrf-value',
    origin: 'https://localhost:1114',
  }), {
    authenticateBrowser: async (forwarded) => {
      authenticatedRequest = forwarded;
      return { accessToken: 'short-lived-supabase-token' };
    },
    verifyBearer: async () => undefined,
  });

  assert.equal(authenticatedRequest.method, 'POST');
  assert.equal(authenticatedRequest.headers['x-os-csrf-token'], 'csrf-value');
  assert.equal(authenticatedRequest.headers.origin, 'https://localhost:1114');
});

test('verified CLI bearer is preserved without browser session exchange', async () => {
  let verified;
  const result = await authorizeR2d2ProxyRequest(request({
    'x-os-internal-authn-subrequest': 'r2d2-proxy-v1',
    'x-os-original-method': 'GET',
    authorization: 'Bearer managed-cli-token',
  }), {
    authenticateBrowser: async () => { throw new Error('browser session must not run'); },
    verifyBearer: async (forwarded) => { verified = forwarded.headers.authorization; },
  });

  assert.equal(verified, 'Bearer managed-cli-token');
  assert.equal(result.authorization, 'Bearer managed-cli-token');
  assert.equal(result.source, 'bearer');
});

test('direct calls and unsupported methods fail closed', async () => {
  const deps = {
    authenticateBrowser: async () => ({ accessToken: 'never' }),
    verifyBearer: async () => undefined,
  };
  await assert.rejects(
    authorizeR2d2ProxyRequest(request(), deps),
    (error) => error.code === 403 && /internal only/.test(error.msg),
  );
  assert.throws(
    () => originalR2d2Request(request({ 'x-os-original-method': 'TRACE' })),
    (error) => error.code === 405,
  );
});

test('nginx mediates R2D2 credentials and keeps the opaque cookie out of the Gateway', () => {
  const nginx = fs.readFileSync(path.join(__dirname, '..', '..', 'nginx', 'default.conf.template'), 'utf8');
  assert.match(nginx, /auth_request_set \$r2d2_authorization \$upstream_http_x_os_r2d2_authorization;/);
  assert.match(nginx, /proxy_pass http:\/\/\$console_backend_upstream:8080\/api\/internal\/r2d2-proxy-authn;/);
  assert.match(nginx, /proxy_set_header X-OS-Original-Method \$r2d2_original_method;/);
  const gatewayLocation = nginx.slice(
    nginx.indexOf('location /api/osaa/'),
    nginx.indexOf('location = /_r2d2_authn'),
  );
  assert.ok(gatewayLocation.length > 0, 'R2D2 Gateway proxy location is missing');
  assert.match(gatewayLocation, /proxy_set_header Cookie "";/);
  assert.match(gatewayLocation, /proxy_set_header Authorization \$r2d2_authorization;/);
  assert.doesNotMatch(gatewayLocation, /proxy_set_header Authorization \$http_authorization;/);
});

test('nginx gives the authenticated R2D2 chat endpoint its bounded long-response window', () => {
  const nginx = fs.readFileSync(path.join(__dirname, '..', '..', 'nginx', 'default.conf.template'), 'utf8');
  const chatLocation = nginx.match(/location = \/api\/osaa\/chat \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(chatLocation, /auth_request \/_r2d2_authn;/);
  assert.match(chatLocation, /proxy_read_timeout 120s;/);
  assert.match(chatLocation, /proxy_set_header Cookie "";/);
  assert.match(chatLocation, /proxy_set_header Authorization \$r2d2_authorization;/);
});

test('nginx authenticates Manual browser requests before forwarding them to the OSAA Gateway', () => {
  const nginx = fs.readFileSync(path.join(__dirname, '..', '..', 'nginx', 'default.conf.template'), 'utf8');
  const locations = [
    nginx.match(/location = \/api\/manual \{[\s\S]*?\n    \}/)?.[0] || '',
    nginx.match(/location \/api\/manual\/ \{[\s\S]*?\n    \}/)?.[0] || '',
  ];

  for (const location of locations) {
    assert.match(location, /set \$r2d2_original_method \$request_method;/);
    assert.match(location, /set \$r2d2_original_uri \$request_uri;/);
    assert.match(location, /auth_request \/_r2d2_authn;/);
    assert.match(location, /auth_request_set \$r2d2_authorization \$upstream_http_x_os_r2d2_authorization;/);
    assert.match(location, /proxy_set_header Cookie "";/);
    assert.match(location, /proxy_set_header Authorization \$r2d2_authorization;/);
    assert.doesNotMatch(location, /proxy_set_header Authorization \$http_authorization;/);
  }
});

test('nginx keeps Engineering Remediation proposal writes on Console Backend', () => {
  const nginx = fs.readFileSync(path.resolve(__dirname, '../../nginx/default.conf.template'), 'utf8');
  const location = nginx.match(/location \^~ \/api\/osaa\/remediations\/ \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(location, /opensphere-console-backend/);
  assert.match(location, /proxy_set_header Authorization ""/);
  assert.doesNotMatch(location, /opensphere-console-osaa-gateway/);
});

test('Console Backend runtime image contains the R2D2 authentication mediator', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY opensphere-console-backend\/r2d2-proxy-auth\.js \.\/r2d2-proxy-auth\.js/);
});
