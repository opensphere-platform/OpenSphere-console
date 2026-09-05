import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createPlatformChangeTemplateOperations } from '../src/platform-change-template-operations.mjs';

const session = Object.freeze({
  sessionId: '11111111-1111-4111-8111-111111111111',
  subjectId: '22222222-2222-4222-8222-222222222222',
  authorityFresh: true,
  permissionRevision: 4,
  revokeEpoch: 1,
  permissions: Object.freeze(['console.git.change']),
  aal: 'aal1',
});

test('reviewed change template catalog exposes only the two immutable legacy-compatible contracts', () => {
  const operations = createPlatformChangeTemplateOperations();
  const foundation = operations.get({ session, templateId: 'foundation-control-plane-bootstrap' });
  const ceph = operations.get({ session, templateId: 'ceph-rook-prerequisite' });
  assert.equal(foundation.consumerId, 'foundation-bootstrap');
  assert.equal(foundation.desiredState.contract, 'opensphere.foundation.bootstrap/v1');
  assert.equal(ceph.consumerId, 'ceph-prerequisites');
  assert.equal(ceph.desiredState.contract, 'opensphere.ceph.rook-prerequisite/v3');
  foundation.consumerId = 'changed-by-caller';
  assert.equal(operations.get({ session, templateId: foundation.id }).consumerId, 'foundation-bootstrap');
  assert.throws(() => operations.get({ session, templateId: 'unknown-template' }), { code: 'NotFound', status: 404 });
});

test('change template reads require current git-change authority', () => {
  const operations = createPlatformChangeTemplateOperations();
  assert.throws(() => operations.get({ session: { ...session, authorityFresh: false }, templateId: 'ceph-rook-prerequisite' }), {
    code: 'AuthenticationRequired', status: 401,
  });
  assert.throws(() => operations.get({ session: { ...session, permissions: [] }, templateId: 'ceph-rook-prerequisite' }), {
    code: 'PermissionDenied', status: 403,
  });
});

test('HTTP change template route is an authenticated exact-id read with no query surface', async () => {
  const sessionChecks = [];
  const handler = createConsoleApiHandler({
    resolveSession: async (_request, options) => { sessionChecks.push(options); return session; },
    platformChangeTemplateOperations: createPlatformChangeTemplateOperations(),
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/platform/change-templates/ceph-rook-prerequisite`, {
      headers: { 'x-os-correlation-id': 'change-template-correlation-0001' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'ceph-rook-prerequisite');
    assert.deepEqual(sessionChecks, [{ requireCsrf: false, correlationId: 'change-template-correlation-0001' }]);

    const expanded = await fetch(`http://127.0.0.1:${port}/api/platform/change-templates/ceph-rook-prerequisite?source=client`);
    assert.equal(expanded.status, 400);
    assert.equal(sessionChecks.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP native template awaits Registry resolution and does not resolve for unauthorized callers', async () => {
  let calls = 0;
  const operations = createPlatformChangeTemplateOperations({ moduleOwner: {
    async template() { calls++; await Promise.resolve(); return { id: 'console-cluster-manager-install', desiredState: { image: 'verified-image' } }; },
  } });
  assert.throws(() => operations.get({ session: { ...session, permissions: [] }, templateId: 'console-cluster-manager-install' }), { code: 'PermissionDenied' });
  assert.equal(calls, 0);
  const server = createServer(createConsoleApiHandler({ resolveSession: async () => session, platformChangeTemplateOperations: operations }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/platform/change-templates/console-cluster-manager-install`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).desiredState.image, 'verified-image');
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
