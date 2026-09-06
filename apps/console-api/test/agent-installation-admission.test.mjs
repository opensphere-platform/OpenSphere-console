import assert from 'node:assert/strict';
import test from 'node:test';
import { agentInstallationRoute } from '../src/agent-installation-admission.mjs';
import { createRegistryOperations } from '../src/registry-operations.mjs';
import { createPostgresOperationStore } from '../src/postgres-operation-store.mjs';

const marker = 'osaa-gateway-v1';
const operation = '/api/platform/operations/11111111-1111-4111-8111-111111111111';
test('agent installation admission permits only install contracts and read-only own-request recovery', () => {
  for (const path of ['/api/admin/extensions/inspect', '/api/admin/extensions/install']) assert.equal(agentInstallationRoute('POST', path, marker), true);
  assert.equal(agentInstallationRoute('GET', operation, marker), true);
  assert.equal(agentInstallationRoute('GET', '/api/admin/extensions/install-requests/r2d2-install-'+'a'.repeat(64), marker), true);
  assert.equal(agentInstallationRoute('POST', '/api/admin/extensions/install-requests/r2d2-install-'+'a'.repeat(64), marker), false);
  for (const path of ['/api/admin/extensions/remove', '/api/platform/operations', operation + '/approvals', '/api/identity/users', '/api/internal/cluster-manager/events']) assert.equal(agentInstallationRoute('POST', path, marker), false);
  for (const other of ['', 'extension-controller-v1', 'os-shell-control-v1']) assert.equal(agentInstallationRoute('POST', '/api/admin/extensions/install', other), false);
});
test('installation catalog requires current install permission and does not grant eligibility', async () => {
  let reads = 0;
  const operations = createRegistryOperations({ operationService: { accept() {} }, registryResolver: { async readCatalogSnapshot() {
    reads++;
    return { revision: 'sha256:' + 'a'.repeat(64), observedAt: '2026-09-06T00:00:00Z', descriptors: [
      { id: 'extension.cluster-manager', class: 'extension', displayName: 'OpenSphere-Cluster-Manager' },
      { id: 'core.supabase', class: 'coreService', displayName: 'Supabase' },
    ] };
  } } });
  await assert.rejects(operations.getInstallationCatalog({ session: { authorityFresh: true, permissions: [] } }), { code: 'PermissionDenied' });
  assert.equal(reads, 0);
  const result = await operations.getInstallationCatalog({ session: { authorityFresh: true, permissions: ['console.extension.install'] } });
  assert.equal(result.data.installationEligibility, 'InspectRequired');
  assert.deepEqual(result.data.items, [{ descriptorId: 'extension.cluster-manager', displayName: 'OpenSphere-Cluster-Manager' }]);
});

test('unknown database lookup result must not mean no previous installation', async () => {
  for (const result of [{}, { rows: [] }, { rows: [{}] }]) {
    const store = createPostgresOperationStore({ query: async () => result });
    await assert.rejects(store.getByRequest({}), { status: 503 });
  }
  const store = createPostgresOperationStore({ query: async () => ({ rows: [{ operation_record: null }] }) });
  assert.equal(await store.getByRequest({}), null);
});
