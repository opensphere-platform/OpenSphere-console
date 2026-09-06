import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createOperationService } from '../src/operation-service.mjs';
import { createRegistryOperations } from '../src/registry-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import installationClient from '../../osaa-gateway/module-installation-client.js';

const policyCatalog = JSON.parse(readFileSync(new URL('../../../packages/contracts/action-policies.json', import.meta.url)));
const subjectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const descriptorId = 'extension.cluster-manager';
const catalogRevision = 'sha256:' + 'a'.repeat(64);
const image = 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:' + 'b'.repeat(64);
const context = { sessionId: 'conversation-http-test', clientRequestId: 'turn-http-test', userInstruction: 'Cluster Manager 설치해' };

async function fixture(t) {
  const session = { sessionId, subjectId, expiresAt: new Date(Date.now() + 3600000).toISOString(), authorityFresh: true,
    permissions: ['console.extension.install'], aal: 'aal1', permissionRevision: 7, revokeEpoch: 2 };
  const calls = []; let record = null; let local = true; let accepts = 0;
  const unexpected = async () => { throw new Error('unexpected mutation'); };
  const store = { approve: unexpected, verify: unexpected,
    async get({ actorRef }) { return actorRef === subjectId ? record : null; },
    async getByRequest({ actorRef, idempotencyKey }) { return record?.actor_ref === actorRef && record.idempotency_key === idempotencyKey ? record : null; },
    async accept(input) {
      accepts++;
      const replayed = record !== null;
      record ||= { operation_id: operationId, action_id: input.actionId, action_version: input.actionVersion,
        actor_ref: input.actorRef, target_ref: input.targetRef, required_permission: input.requiredPermission,
        payload_digest: input.payloadDigest, request_digest: 'sha256:' + 'c'.repeat(64), reason: input.reason, risk: input.risk,
        aal: session.aal, permission_revision: 7, approval_required: input.approvalRequired, plan_revision: input.planRevision,
        idempotency_key: input.idempotencyKey, owner_ref: input.ownerRef, state: 'Authorized', state_version: 0,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), correlation_id: input.correlationId };
      return { operationRecord: record, replayed };
    } };
  const operationService = createOperationService({ store, policyCatalog, moduleInstallationPolicy: async () => local });
  const candidate = { descriptorId, catalogRevision, image, channel: 'edge', evidenceRefs: [] };
  const registryOperations = createRegistryOperations({ operationService, policyRevision: policyCatalog.policyRevision,
    registryResolver: { async readCatalogSnapshot() { return { revision: catalogRevision, observedAt: new Date().toISOString(), descriptors: [{ id: descriptorId, class: 'extension', displayName: 'OpenSphere-Cluster-Manager' }] }; },
      async resolveExtension(input) { assert.equal(input.descriptorId, descriptorId); assert.equal(input.catalogRevision, catalogRevision); return candidate; } } });
  // Authentication is independently tested with the real identity broker. This
  // fixture exercises actual HTTP routing, schemas, policy and Gateway client.
  const server = createServer(createConsoleApiHandler({ operationService, registryOperations, resolveSession: async (request, options) => {
    calls.push({ method: request.method, path: request.url, requireCsrf: options.requireCsrf }); return session;
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const snapshot = { schema: 'opensphere.registry-catalog/v1', stale: false, revision: catalogRevision,
    sources: Object.fromEntries(['extensions.packages', 'extensions.registrations', 'extensions.navigation', 'trust.keys', 'release.inventory'].map(key => [key, { ready: true }])),
    inventory: { descriptors: [{ id: descriptorId, class: 'extension', release: { version: '1.3.18', channel: 'edge' }, installation: { mode: 'extension-controller', eligible: true } }] } };
  const client = installationClient.createModuleInstallationClient({ baseUrl, readRegistry: async () => snapshot,
    observeInstallation: async () => ({ clusterManager: { state: 'NotRegistered' } }) });
  const actor = { subject: subjectId, bearerToken: 'isolated-http-test', permissions: session.permissions };
  return { session, calls, client, actor, baseUrl, record: () => record, accepts: () => accepts, outsideLocal: () => { local = false; } };
}

test('real Gateway/HTTP contract: inspect, accepted request, recovery and advancing owner receipt', async t => {
  const f = await fixture(t);
  const catalog = await fetch(f.baseUrl + '/api/admin/extensions/catalog').then(r => r.json());
  assert.equal(catalog.data.revision, catalogRevision);
  assert.equal(catalog.data.items[0].descriptorId, descriptorId);
  const review = await f.client.inspect(f.actor, { descriptorId });
  const accepted = await f.client.install(f.actor, { descriptorId, catalogRevision: review.catalogRevision }, context);
  assert.equal(accepted.state, 'Authorized'); assert.equal(f.record().approval_required, false);
  assert.equal(f.record().aal, 'aal1', 'development exception must not fabricate MFA');
  assert.equal(f.accepts(), 1);
  const recovered = await f.client.findCurrentRequest(f.actor, context);
  assert.equal(recovered.operationId, accepted.operationId);
  await f.client.install(f.actor, { descriptorId, catalogRevision }, context);
  assert.equal(f.accepts(), 1, 'accepted request must not be resubmitted');
  f.record().state = 'Reconciling'; f.record().state_version++;
  assert.equal((await f.client.getOperation(f.actor, { operationId })).state, 'Reconciling');
  f.record().state = 'Verified'; f.record().state_version++;
  const result = await f.client.getOperation(f.actor, { operationId });
  assert.equal(result.installationVerified, true); assert.equal(result.productFunctionsVerified, false);
  assert.ok(f.calls.filter(c => c.method === 'POST').every(c => c.requireCsrf === true), 'HTTP handler retains browser CSRF intent');
  assert.ok(f.calls.filter(c => c.method === 'GET').every(c => c.requireCsrf === false));
});

test('HTTP contract rejects outside-local AAL1, unknown body, query and stale authority before acceptance', async t => {
  const f = await fixture(t); f.outsideLocal();
  await assert.rejects(f.client.install(f.actor, { descriptorId, catalogRevision }, context), e => e.status === 428);
  assert.equal(f.accepts(), 0);
  let response = await fetch(f.baseUrl + '/api/admin/extensions/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptorId, catalogRevision, image }) });
  assert.equal(response.status, 400);
  response = await fetch(f.baseUrl + '/api/admin/extensions/catalog?actor=someone-else'); assert.equal(response.status, 400);
  response = await fetch(f.baseUrl + '/api/admin/extensions/install-requests/r2d2-install-' + 'a'.repeat(64) + '?actor=someone-else'); assert.equal(response.status, 400);
  f.session.authorityFresh = false;
  response = await fetch(f.baseUrl + '/api/admin/extensions/catalog'); assert.equal(response.status, 403);
  response = await fetch(f.baseUrl + '/api/admin/extensions/install-requests/r2d2-install-' + 'a'.repeat(64)); assert.equal(response.status, 403);
  assert.equal(f.accepts(), 0);
});
