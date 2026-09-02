import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createOwnerAdmissionOperations } from '../src/owner-admission-operations.mjs';

const id = '33333333-3333-4333-8333-333333333333';
const families = Object.freeze([
  { name: 'OSAA', operation: 'authorizeOsaa', endpoint: '/api/internal/r2d2-proxy-authn', internalMarker: 'r2d2-proxy-v1', ownerMarker: 'osaa-gateway-v1', safe: '/api/manual/documents', unsafe: '/api/osaa/chat' },
  { name: 'Notification', operation: 'authorizeNotification', endpoint: '/api/internal/notification-owner-authn', internalMarker: 'notification-dispatcher-v1', ownerMarker: 'notification-dispatcher-v1', safe: '/api/notifications/channels', unsafe: `/api/notifications/channels/${id}/test` },
  { name: 'External Channel', operation: 'authorizeExternalChannel', endpoint: '/api/internal/external-channel-owner-authn', internalMarker: 'external-channel-executor-v1', ownerMarker: 'external-channel-executor-v1', safe: '/api/external-channels/backups', unsafe: `/api/external-channels/backups/${id}/restore-preview` },
  { name: 'OS Shell', operation: 'authorizeOsShell', endpoint: '/api/internal/os-shell-authn', internalMarker: 'os-shell-v1', ownerMarker: 'os-shell-control-v1', safe: `/api/os-shell/sessions/${id}/attach`, unsafe: `/api/os-shell/sessions/${id}/attach-ticket` },
  { name: 'Extension', operation: 'authorizeExtension', endpoint: '/api/internal/plugin-proxy-authz', internalMarker: 'plugin-proxy-v1', ownerMarker: 'extension-controller-v1', safe: '/api/plugins/metrics/assets/main.js', unsafe: '/api/plugins/metrics/api/settings' },
  { name: 'Extension Management', operation: 'authorizeExtensionManagement', endpoint: '/api/internal/extension-management-authn', internalMarker: 'extension-management-v1', ownerMarker: 'extension-controller-v1', safe: '/api/admin/plugins/catalog', unsafe: `/api/admin/plugins/registrations/${id}/enable` },
]);

function fixture(authorization = 'Bearer header.payload.signature') {
  const exchanges = [];
  const operations = createOwnerAdmissionOperations({
    identitySessionBroker: {
      async exchangeOwnerAccessCredential(request, options) {
        exchanges.push({ request, options });
        return { authorization, expiresAt: '2026-09-03T00:00:00.000Z' };
      },
    },
  });
  return { operations, exchanges };
}

function headers(family, method, uri) {
  return {
    'x-os-internal-authn-subrequest': family.internalMarker,
    'x-os-original-method': method,
    'x-os-original-uri': uri,
    cookie: '__Host-opensphere-session=opaque',
    'x-os-csrf-token': 'csrf-proof',
  };
}

test('each Owner admission binds only its exact routes, method, browser session, and CSRF policy', async () => {
  for (const family of families) {
    const { operations, exchanges } = fixture();
    const safe = await operations[family.operation]({ headers: headers(family, 'GET', family.safe + '?page=1') }, { correlationId: `${family.operation}-safe` });
    const unsafe = await operations[family.operation]({ headers: headers(family, 'POST', family.unsafe) }, { correlationId: `${family.operation}-unsafe` });
    assert.deepEqual(safe, { authorization: 'Bearer header.payload.signature', ownerMarker: family.ownerMarker, csrfVerified: false });
    assert.deepEqual(unsafe, { authorization: 'Bearer header.payload.signature', ownerMarker: family.ownerMarker, csrfVerified: true });
    assert.equal(exchanges[0].request.method, 'GET');
    assert.equal(exchanges[0].request.url, family.safe + '?page=1');
    assert.deepEqual(exchanges[0].options, { requireCsrf: false, correlationId: `${family.operation}-safe` });
    assert.equal(exchanges[1].request.method, 'POST');
    assert.equal(exchanges[1].request.url, family.unsafe);
    assert.deepEqual(exchanges[1].options, { requireCsrf: true, correlationId: `${family.operation}-unsafe` });
  }
});

test('Owner admission rejects external calls, bearer input, wrong internal markers, and cross-family replay', async () => {
  const { operations } = fixture();
  for (const family of families) {
    const base = headers(family, 'GET', family.safe);
    for (const invalid of [
      { ...base, 'x-os-internal-authn-subrequest': undefined },
      { ...base, 'x-os-internal-authn-subrequest': 'wrong-owner-v1' },
      { ...base, authorization: 'Bearer browser.supplied.token' },
      { ...base, 'x-os-original-uri': '/api/not-admitted' },
      { ...base, 'x-os-original-uri': 'http://attacker.invalid' + family.safe },
      { ...base, 'x-os-original-method': 'TRACE' },
    ]) {
      await assert.rejects(operations[family.operation]({ headers: invalid }), (error) => [400, 403].includes(error.status));
    }
  }
});

test('Extension Management admission allows only the target management surface', async () => {
  const { operations } = fixture();
  const family = families.at(-1);
  const allowed = [
    ['GET', '/api/admin/plugins/catalog'],
    ['GET', '/api/admin/plugins/registrations'],
    ['GET', '/api/admin/plugins/events'],
    ['GET', '/api/admin/bindings'],
    ['POST', `/api/admin/bindings/${id}/disable`],
    ['POST', `/api/admin/plugins/registrations/${id}/rollback`],
    ['POST', `/api/admin/plugins/packages/${id}/icon`],
    ['POST', `/api/admin/plugins/packages/${id}/navigation`],
    ['PUT', '/api/admin/plugins/navigation-order'],
  ];
  for (const [method, uri] of allowed) {
    const result = await operations.authorizeExtensionManagement({ headers: headers(family, method, uri) });
    assert.equal(result.ownerMarker, 'extension-controller-v1');
    assert.equal(result.csrfVerified, method !== 'GET');
  }
  for (const [method, uri] of [
    ['POST', `/api/admin/plugins/registrations/${id}/install`],
    ['DELETE', `/api/admin/plugins/registrations/${id}`],
    ['POST', '/api/admin/extensions/install'],
    ['GET', '/api/plugins/metrics/assets/main.js'],
    ['GET', '/api/admin/plugins/catalog/extra'],
  ]) {
    await assert.rejects(
      operations.authorizeExtensionManagement({ headers: headers(family, method, uri) }),
      { code: 'PermissionDenied', status: 403 },
    );
  }
});

test('Owner admission rejects a malformed credential exchange result', async () => {
  const { operations } = fixture('Bearer not-a-jwt');
  await assert.rejects(
    operations.authorizeNotification({ headers: headers(families[1], 'GET', families[1].safe) }),
    { code: 'AuthorityUnavailable', status: 503 },
  );
});

test('internal auth_request endpoints return only exchanged Owner headers', async (t) => {
  const { operations } = fixture();
  const server = createServer(createConsoleApiHandler({ resolveSession: async () => ({}), ownerAdmissionOperations: operations }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (const family of families) {
    for (const [method, uri, csrfVerified] of [['GET', family.safe, false], ['POST', family.unsafe, true]]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${family.endpoint}`, {
        headers: headers(family, method, uri),
      });
      assert.equal(response.status, 204, family.name);
      assert.equal(response.headers.get('x-os-owner-authorization'), 'Bearer header.payload.signature');
      assert.equal(response.headers.get('x-os-owner-admission'), family.ownerMarker);
      assert.equal(response.headers.get('x-os-owner-csrf-verified'), csrfVerified ? 'true' : null);
      if (family.name === 'OSAA') assert.equal(response.headers.get('x-os-r2d2-authorization'), 'Bearer header.payload.signature');
      assert.equal(await response.text(), '');
    }
  }
});
