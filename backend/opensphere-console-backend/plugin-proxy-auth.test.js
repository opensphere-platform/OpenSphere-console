'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { authorizePluginProxyRequest, originalPluginRequest } = require('./plugin-proxy-auth');

function request(headers = {}) {
  return { method: 'GET', url: '/api/internal/plugin-proxy-authz', headers };
}

test('opaque browser session is exchanged server-side after release allowlist verification', async () => {
  const calls = [];
  const result = await authorizePluginProxyRequest(request({
    'x-os-internal-authz-subrequest': 'plugin-proxy-v1',
    'x-plugin-id': 'cluster-manager',
    'x-os-original-method': 'GET',
    'x-os-original-uri': '/api/plugins/cluster-manager/api/k8s/api/v1/nodes',
    cookie: '__Host-opensphere_session=opaque',
  }), {
    allowPlugin: async (id) => { calls.push(['allow', id]); return true; },
    authenticateBrowser: async (req) => {
      calls.push(['session', req.method, req.headers.cookie]);
      return { accessToken: 'short-lived-supabase-token' };
    },
    verifyBearer: async () => { throw new Error('bearer verifier must not run'); },
  });

  assert.deepEqual(calls, [
    ['allow', 'cluster-manager'],
    ['session', 'GET', '__Host-opensphere_session=opaque'],
  ]);
  assert.deepEqual(result, {
    pluginId: 'cluster-manager',
    authorization: 'Bearer short-lived-supabase-token',
    source: 'browser-session',
  });
});

test('original mutation method reaches browser-session CSRF enforcement', async () => {
  let authenticatedRequest;
  await authorizePluginProxyRequest(request({
    'x-os-internal-authz-subrequest': 'plugin-proxy-v1',
    'x-plugin-id': 'cluster-manager',
    'x-os-original-method': 'POST',
    'x-os-original-uri': '/api/plugins/cluster-manager/api/his/requests',
    'x-os-csrf-token': 'csrf-value',
    origin: 'https://localhost:1114',
  }), {
    allowPlugin: async () => true,
    authenticateBrowser: async (req) => {
      authenticatedRequest = req;
      return { accessToken: 'token' };
    },
    verifyBearer: async () => undefined,
  });

  assert.equal(authenticatedRequest.method, 'POST');
  assert.equal(authenticatedRequest.headers['x-os-csrf-token'], 'csrf-value');
  assert.equal(authenticatedRequest.headers.origin, 'https://localhost:1114');
});

test('verified CLI bearer is preserved without invoking browser session exchange', async () => {
  let verified;
  const result = await authorizePluginProxyRequest(request({
    'x-os-internal-authz-subrequest': 'plugin-proxy-v1',
    'x-plugin-id': 'cluster-manager',
    'x-os-original-method': 'GET',
    authorization: 'Bearer managed-cli-token',
  }), {
    allowPlugin: async () => true,
    authenticateBrowser: async () => { throw new Error('browser session must not run'); },
    verifyBearer: async (req) => { verified = req.headers.authorization; },
  });

  assert.equal(verified, 'Bearer managed-cli-token');
  assert.equal(result.authorization, 'Bearer managed-cli-token');
  assert.equal(result.source, 'bearer');
});

test('unverified targets and direct calls fail closed before session exchange', async () => {
  let sessionCalls = 0;
  const deps = {
    allowPlugin: async () => false,
    authenticateBrowser: async () => { sessionCalls += 1; return { accessToken: 'never' }; },
    verifyBearer: async () => undefined,
  };

  await assert.rejects(
    authorizePluginProxyRequest(request({
      'x-os-internal-authz-subrequest': 'plugin-proxy-v1',
      'x-plugin-id': 'cluster-manager',
    }), deps),
    (error) => error.code === 403 && /not active and verified/.test(error.msg),
  );
  await assert.rejects(
    authorizePluginProxyRequest(request({ 'x-plugin-id': 'cluster-manager' }), {
      ...deps,
      allowPlugin: async () => true,
    }),
    (error) => error.code === 403 && /internal only/.test(error.msg),
  );
  assert.equal(sessionCalls, 0);
});

test('malformed target and method values are rejected', async () => {
  assert.throws(
    () => originalPluginRequest(request({ 'x-os-original-method': 'TRACE' })),
    (error) => error.code === 405,
  );
  await assert.rejects(
    authorizePluginProxyRequest(request({
      'x-os-internal-authz-subrequest': 'plugin-proxy-v1',
      'x-plugin-id': '../console-backend',
    }), {
      allowPlugin: async () => true,
      authenticateBrowser: async () => ({ accessToken: 'never' }),
      verifyBearer: async () => undefined,
    }),
    (error) => error.code === 403 && /invalid plugin proxy target/.test(error.msg),
  );
});

test('nginx keeps the opaque browser cookie out of plugin workloads', () => {
  const nginx = fs.readFileSync(path.join(__dirname, '..', '..', 'nginx', 'default.conf.template'), 'utf8');
  assert.match(nginx, /auth_request_set \$plugin_authorization \$upstream_http_x_os_plugin_authorization;/);
  assert.match(nginx, /proxy_set_header Cookie "";/);
  assert.match(nginx, /proxy_set_header Authorization \$plugin_authorization;/);
  assert.match(nginx, /proxy_pass http:\/\/\$console_backend_upstream:8080\/api\/internal\/plugin-proxy-authz;/);
  assert.match(nginx, /proxy_set_header X-OS-Original-Method \$plugin_original_method;/);
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(server, /pluginProxyReleaseAllowed\(pluginId, req\.headers\['x-os-original-method'\]/);
  const pluginLocation = nginx.slice(
    nginx.indexOf('location ~ ^/api/plugins/'),
    nginx.indexOf('location = /_plugin_authz'),
  );
  assert.ok(pluginLocation.length > 0, 'plugin proxy location is missing');
  assert.doesNotMatch(
    pluginLocation,
    /proxy_set_header Authorization \$http_authorization;/,
  );
});

test('Console Backend runtime image contains the plugin authorization mediator', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /COPY opensphere-console-backend\/plugin-proxy-auth\.js \.\/plugin-proxy-auth\.js/,
  );
});
