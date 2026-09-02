import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createOwnerAdmissionOperations } from '../src/owner-admission-operations.mjs';

function fixture() {
  const exchanges = [];
  const operations = createOwnerAdmissionOperations({
    identitySessionBroker: {
      async exchangeOwnerAccessCredential(request, options) {
        exchanges.push({ request, options });
        return { authorization: 'Bearer header.payload.signature', expiresAt: '2026-09-03T00:00:00.000Z' };
      },
    },
  });
  return { operations, exchanges };
}

test('OSAA owner admission binds the original family, method, session proof, and CSRF policy', async () => {
  const { operations, exchanges } = fixture();
  const headers = {
    'x-os-internal-authn-subrequest': 'r2d2-proxy-v1',
    'x-os-original-method': 'POST',
    'x-os-original-uri': '/api/osaa/chat?mode=operator',
    cookie: '__Host-opensphere-session=opaque',
    'x-os-csrf-token': 'csrf-proof',
  };
  const result = await operations.authorizeOsaa({ headers }, { correlationId: 'owner-admission-0001' });
  assert.equal(result.authorization, 'Bearer header.payload.signature');
  assert.equal(exchanges[0].request.method, 'POST');
  assert.equal(exchanges[0].request.url, '/api/osaa/chat?mode=operator');
  assert.deepEqual(exchanges[0].options, { requireCsrf: true, correlationId: 'owner-admission-0001' });
});

test('OSAA owner admission rejects external, bearer, and cross-family requests', async () => {
  const { operations } = fixture();
  for (const headers of [
    { 'x-os-original-method': 'GET', 'x-os-original-uri': '/api/osaa/health' },
    { 'x-os-internal-authn-subrequest': 'r2d2-proxy-v1', 'x-os-original-method': 'GET', 'x-os-original-uri': '/api/osaa/health', authorization: 'Bearer supplied' },
    { 'x-os-internal-authn-subrequest': 'r2d2-proxy-v1', 'x-os-original-method': 'GET', 'x-os-original-uri': '/api/admin/plugins/catalog' },
  ]) {
    await assert.rejects(operations.authorizeOsaa({ headers }), { status: 403 });
  }
});

test('internal OSAA auth_request returns only the exchanged bearer header', async (t) => {
  const { operations } = fixture();
  const server = createServer(createConsoleApiHandler({ resolveSession: async () => ({}), ownerAdmissionOperations: operations }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/r2d2-proxy-authn`, {
    headers: {
      'x-os-internal-authn-subrequest': 'r2d2-proxy-v1',
      'x-os-original-method': 'GET',
      'x-os-original-uri': '/api/manual/documents',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('x-os-r2d2-authorization'), 'Bearer header.payload.signature');
  assert.equal(await response.text(), '');
});
