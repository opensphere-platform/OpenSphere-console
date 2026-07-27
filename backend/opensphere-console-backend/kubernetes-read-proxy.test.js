'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createKubernetesReadProxy, parseKubernetesReadRequest } = require('./kubernetes-read-proxy');

const allowed = new Set(['cc2']);

test('parses a bounded CC2 Kubernetes read path', () => {
  assert.deepEqual(
    parseKubernetesReadRequest(
      '/api/control-centers/cc2/k8s/api/v1/namespaces/default/pods/example/log?tailLines=100',
      allowed,
    ),
    {
      controlCenterId: 'cc2',
      path: '/api/v1/namespaces/default/pods/example/log',
      search: '?tailLines=100',
    },
  );
});

test('rejects unknown centers, secrets, encoded bypasses and watch streams', () => {
  assert.throws(
    () => parseKubernetesReadRequest('/api/control-centers/cc1/k8s/api/v1/pods', allowed),
    (error) => error.code === 404,
  );
  assert.throws(
    () => parseKubernetesReadRequest('/api/control-centers/cc2/k8s/api/v1/secrets', allowed),
    (error) => error.code === 403,
  );
  assert.throws(
    () => parseKubernetesReadRequest('/api/control-centers/cc2/k8s/api/v1/sec%72ets', allowed),
    (error) => error.code === 403,
  );
  assert.throws(
    () => parseKubernetesReadRequest('/api/control-centers/cc2/k8s/api/v1/sec%2572ets', allowed),
    (error) => error.code === 400,
  );
  assert.throws(
    () => parseKubernetesReadRequest('/api/control-centers/cc2/k8s/api/v1/pods?watch=true', allowed),
    (error) => error.code === 400,
  );
});

test('proxy verifies the actor, uses its own token and persists an audit event', async () => {
  const calls = [];
  const proxy = createKubernetesReadProxy({
    allowedControlCenters: ['cc2'],
    readToken: () => 'bounded-service-account-token',
    verify: async (_req, controlCenterId) => {
      calls.push(['verify', controlCenterId]);
      return { sub: 'operator-1' };
    },
    audit: async (actor, event) => calls.push(['audit', actor.sub, event]),
    fetch: async (url, init) => {
      calls.push(['fetch', url, init.headers.authorization]);
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || ''); },
  };
  await proxy({
    method: 'GET',
    url: '/api/control-centers/cc2/k8s/api/v1/pods',
    headers: { accept: 'application/json' },
  }, response);

  assert.equal(response.status, 200);
  assert.equal(response.headers['x-polyon-control-center'], 'cc2');
  assert.deepEqual(JSON.parse(response.body), { items: [] });
  assert.deepEqual(calls[0], ['verify', 'cc2']);
  assert.deepEqual(calls[1], ['fetch', 'https://kubernetes.default.svc/api/v1/pods', 'Bearer bounded-service-account-token']);
  assert.equal(calls[2][0], 'audit');
  assert.equal(calls[2][2].status, 200);
});

test('proxy denies every mutation before contacting Kubernetes', async () => {
  let fetched = false;
  const proxy = createKubernetesReadProxy({
    allowedControlCenters: ['cc2'],
    verify: async () => ({ sub: 'operator-1' }),
    audit: async () => undefined,
    readToken: () => 'token',
    fetch: async () => { fetched = true; throw new Error('must not run'); },
  });
  const response = {
    status: 0,
    writeHead(status) { this.status = status; },
    end() {},
  };
  await proxy({
    method: 'PATCH',
    url: '/api/control-centers/cc2/k8s/apis/apps/v1/deployments/example',
    headers: {},
  }, response);
  assert.equal(response.status, 405);
  assert.equal(fetched, false);
});

test('RCC reader authorization uses the canonical Kubernetes read permission', () => {
  const server = readFileSync(resolve(__dirname, 'server.js'), 'utf8');
  // The Kubernetes and Linux host readers share one assignment check so a new
  // control-center surface cannot quietly skip authentication or scoping.
  const reader = server.match(/async function verifyControlCenterReader[\s\S]*?\n}/)?.[0] || '';
  assert.match(reader, /verifyControlCenterAssignment\(req, controlCenterId, 'console\.kubernetes\.read'\)/);
  assert.doesNotMatch(reader, /verifyConsoleAdmin/);

  const shared = server.match(/async function verifyControlCenterAssignment[\s\S]*?\n}/)?.[0] || '';
  assert.match(shared, /verifyAuthed\(req\)/);
  assert.match(shared, /requireActorPermission\(actor, permission\)/);
  assert.match(shared, /operator_control_center/);
  assert.match(shared, /expires_at/);
  assert.doesNotMatch(shared, /verifyConsoleAdmin/);
});

test('RCC host reader requires its own permission, not the Kubernetes one', () => {
  const server = readFileSync(resolve(__dirname, 'server.js'), 'utf8');
  const reader = server.match(/async function verifyHostReader[\s\S]*?\n}/)?.[0] || '';
  assert.match(reader, /verifyControlCenterAssignment\(req, controlCenterId, 'console\.hosts\.read'\)/);
  assert.doesNotMatch(reader, /console\.kubernetes\.read/);
});

test('RCC Kubernetes UI shares scoped host styles with resource views and reports required read failures', () => {
  const page = readFileSync(resolve(__dirname, '../../src/app/features/kubernetes/kubernetes-console-page.ts'), 'utf8');
  const styles = readFileSync(resolve(__dirname, '../../src/app/features/kubernetes/kubernetes-console-page.css'), 'utf8');
  const overview = readFileSync(resolve(__dirname, '../../src/app/features/kubernetes/resources/overview.component.ts'), 'utf8');
  assert.match(page, /encapsulation:\s*ViewEncapsulation\.None/);
  assert.match(styles, /^polyon-kubernetes-console\s*\{/m);
  assert.doesNotMatch(styles, /^:host\s*\{/m);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.os-shell\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.cm-nav\s*\{[\s\S]*?width: 100% !important/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.os-drawer\s*\{\s*width: 100% !important/);
  assert.doesNotMatch(overview, /const safe = .*catchError/);
  assert.match(overview, /nodes:\s*this\.k8s\.list\('\/api\/v1\/nodes'\)/);
  assert.match(overview, /metrics:.*catchError\(\(\) => of\(null\)\)/);
});
