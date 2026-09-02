import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createExtensionManagementHttpHandler, isExtensionManagementRoute } from '../src/extension-management-http.mjs';

const actor = Object.freeze({ subjectId: 'actor', permissions: [], permissionRevision: 1, revokeEpoch: 0, assurance: 'aal2' });

function fixture() {
  const calls = [];
  const operations = {
    async catalog(input) { calls.push(['catalog', input]); return { items: [] }; },
    async registrations(input) { calls.push(['registrations', input]); return { items: [] }; },
    async events(input) { calls.push(['events', input]); return { items: [] }; },
    async bindings(input) { calls.push(['bindings', input]); return { items: [] }; },
    async registrationAction(input) { calls.push(['registrationAction', input]); return { accepted: true, id: input.id }; },
    async bindingAction(input) { calls.push(['bindingAction', input]); return { accepted: true, name: input.name }; },
    async setIcon(input) { calls.push(['setIcon', input]); return { accepted: true, id: input.id }; },
    async setNavigation(input) { calls.push(['setNavigation', input]); return { accepted: true, id: input.id }; },
    async setNavigationOrder(input) { calls.push(['setNavigationOrder', input]); return { accepted: true, ids: input.ids }; },
  };
  const ownerCalls = [];
  const handler = createExtensionManagementHttpHandler({
    operations,
    async ownerAdmission(request) {
      ownerCalls.push(request.url);
      assert.equal(request.headers.authorization, 'Bearer header.payload.signature');
      assert.equal(request.headers['x-os-owner-admission'], 'extension-controller-v1');
      assert.equal(request.headers.cookie, undefined);
      return actor;
    },
  });
  return { handler, calls, ownerCalls };
}

async function serverFixture(t) {
  const state = fixture();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://extension.local');
      if (!await state.handler(request, response, url)) response.writeHead(404).end();
    } catch (error) {
      response.writeHead(error.status || 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: error.code, message: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { ...state, origin: 'http://127.0.0.1:' + server.address().port };
}
const headers = {
  authorization: 'Bearer header.payload.signature',
  'x-os-owner-admission': 'extension-controller-v1',
  'x-os-correlation-id': 'extension-management-correlation-0001',
};

test('management route predicate admits only the exact Web surface', () => {
  const allowed = [
    ['GET', '/api/admin/plugins/catalog'],
    ['GET', '/api/admin/plugins/registrations'],
    ['GET', '/api/admin/plugins/events'],
    ['GET', '/api/admin/bindings'],
    ['POST', '/api/admin/bindings/workforce-cli/enable'],
    ['POST', '/api/admin/plugins/registrations/metrics/disable'],
    ['POST', '/api/admin/plugins/packages/metrics/icon'],
    ['POST', '/api/admin/plugins/packages/metrics/navigation'],
    ['PUT', '/api/admin/plugins/navigation-order'],
  ];
  for (const [method, path] of allowed) assert.equal(isExtensionManagementRoute(method, path), true, path);
  for (const [method, path] of [
    ['POST', '/api/admin/plugins/registrations/metrics/install'],
    ['DELETE', '/api/admin/plugins/registrations/metrics'],
    ['POST', '/api/admin/extensions/install'],
    ['GET', '/api/plugins/metrics/assets/main.js'],
    ['GET', '/api/admin/plugins/catalog/extra'],
  ]) assert.equal(isExtensionManagementRoute(method, path), false, path);
});

test('HTTP management routes preserve exact method, body, actor, and response status', async (t) => {
  const { origin, calls, ownerCalls } = await serverFixture(t);
  for (const path of [
    '/api/admin/plugins/catalog', '/api/admin/plugins/registrations',
    '/api/admin/plugins/events', '/api/admin/bindings',
  ]) {
    const response = await fetch(origin + path, { headers });
    assert.equal(response.status, 200, path);
  }
  let response = await fetch(origin + '/api/admin/plugins/registrations/metrics/rollback', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'restore verified release' }),
  });
  assert.equal(response.status, 202);
  response = await fetch(origin + '/api/admin/bindings/workforce-cli/disable', { method: 'POST', headers });
  assert.equal(response.status, 202);
  response = await fetch(origin + '/api/admin/plugins/packages/metrics/icon', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ icon: 'chart-line' }),
  });
  assert.equal(response.status, 200);
  response = await fetch(origin + '/api/admin/plugins/packages/metrics/navigation', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ labelOverride: 'Metrics' }),
  });
  assert.equal(response.status, 200);
  response = await fetch(origin + '/api/admin/plugins/navigation-order', {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['metrics'] }),
  });
  assert.equal(response.status, 200);

  assert.deepEqual(calls.map(([name]) => name), [
    'catalog', 'registrations', 'events', 'bindings',
    'registrationAction', 'bindingAction', 'setIcon', 'setNavigation', 'setNavigationOrder',
  ]);
  assert.equal(calls[4][1].reason, 'restore verified release');
  assert.equal(calls[4][1].actor, actor);
  assert.deepEqual(calls[8][1].ids, ['metrics']);
  assert.equal(ownerCalls.length, calls.length);
});

test('HTTP management rejects query, unknown fields, and non-JSON mutation before domain operations', async (t) => {
  const { origin, calls, ownerCalls } = await serverFixture(t);
  let response = await fetch(origin + '/api/admin/plugins/catalog?page=2', { headers });
  assert.equal(response.status, 400);
  response = await fetch(origin + '/api/admin/plugins/packages/metrics/icon', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ icon: 'chart-line', secret: 'no' }),
  });
  assert.equal(response.status, 400);
  response = await fetch(origin + '/api/admin/plugins/registrations/metrics/enable', {
    method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(response.status, 400);
  response = await fetch(origin + '/api/admin/extensions/install', { method: 'POST', headers });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
  assert.equal(ownerCalls.length, 2);
});
