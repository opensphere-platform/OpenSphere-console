import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtensionController } from '../src/controller.mjs';
import { createExtensionPostgresStore } from '../src/postgres-store.mjs';

const workerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image = 'ghcr.io/opensphere-platform/console@sha256:' + 'c'.repeat(64);
const digest = 'sha256:' + 'd'.repeat(64);
const catalogRevision = 'sha256:' + 'e'.repeat(64);
const installImage = 'ghcr.io/opensphere-platform/opensphere-plugin-workspace@sha256:' + 'f'.repeat(64);
const candidate = {
  kind: 'extension', descriptorId: 'extension.workspace', id: 'workspace', image: installImage,
  digest: 'sha256:' + 'f'.repeat(64), channel: 'edge', catalogRevision,
  descriptorRevision: catalogRevision, executionRevision: installImage,
  sourceRevision: 'a'.repeat(40), manifestDigest: 'sha256:' + 'b'.repeat(64),
  compatibilityVersion: '1.0.0', keyId: 'release-key', evidenceRefs: ['oci:provenance', 'oci:sbom'],
  packageResourceVersion: '17', packageGeneration: 1,
  verification: { catalog: 'Verified', manifest: 'Verified', signature: 'Verified', permissions: 'Approved' },
};

function fixture(claim) {
  const calls = [];
  const store = {
    async claim(input) { calls.push({ method: 'claim', input }); return claim; },
    async renew(input) { calls.push({ method: 'renew', input }); return new Date().toISOString(); },
    async applyRevocation(input) {
      calls.push({ method: 'applyRevocation', input });
      return { evidenceDigest: digest, inserted: true };
    },
    async applyInstall(input) {
      calls.push({ method: 'applyInstall', input });
      return { evidenceDigest: digest };
    },
  };
  const registryResolver = {
    async resolveExtension(input) { calls.push({ method: 'resolveExtension', input }); return candidate; },
  };
  const registrationWriter = {
    async applyInstall(input) {
      calls.push({ method: 'applyRegistration', input });
      return {
        registrationName: 'workspace', registrationUid: 'registration-uid',
        registrationResourceVersion: '18', packageResourceVersion: '17',
        packageGeneration: 1, created: true,
      };
    },
  };
  return { calls, controller: createExtensionController({ store, registryResolver, registrationWriter, workerId, leaseSeconds: 30 }) };
}

test('idle poll has no owner side effect', async () => {
  const { calls, controller } = fixture(null);
  assert.deepEqual(await controller.runOnce(), { state: 'Idle' });
  assert.deepEqual(calls.map((call) => call.method), ['claim']);
});

test('typed revocation renews its fence before one idempotent apply', async () => {
  const { calls, controller } = fixture({
    outboxId: 17, operationId, actionId: 'console.extension.revocation.create',
    actionVersion: '1.0', targetRef: image, payloadDigest: digest, ownerRef: 'C_EXT',
    claimEpoch: 4, resumeMode: 'reconcile', state: 'Submitted', stateVersion: 2,
  });
  const result = await controller.runOnce();
  assert.equal(result.state, 'Applied');
  assert.equal(result.claimEpoch, 4);
  assert.deepEqual(calls.map((call) => call.method), ['claim', 'renew', 'applyRevocation']);
  assert.equal(calls[2].input.targetRef, image);
  assert.equal(calls[2].input.payloadDigest, digest);
});

test('typed install re-resolves C_REG before one idempotent Registration apply', async () => {
  const { calls, controller } = fixture({
    outboxId: 19, operationId, actionId: 'console.extension.install', actionVersion: '1.0',
    targetRef: installImage, payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 5,
    executionPlan: {
      schemaVersion: '1.0', authority: 'OpenSphereRegistry', descriptorId: 'extension.workspace',
      catalogRevision, image: installImage,
    },
    actorRef: '11111111-1111-4111-8111-111111111111', reason: 'install workspace extension',
    correlationId: 'extension-install-correlation-0001',
  });
  const result = await controller.runOnce();
  assert.equal(result.state, 'Applied');
  assert.equal(result.actionId, 'console.extension.install');
  assert.deepEqual(calls.map((call) => call.method), [
    'claim', 'resolveExtension', 'renew', 'applyRegistration', 'applyInstall',
  ]);
  assert.equal(calls[1].input.catalogRevision, catalogRevision);
  assert.equal(calls[3].input.candidate.packageResourceVersion, '17');
  assert.equal(calls[4].input.registrationUid, 'registration-uid');
});

test('install plan or C_REG drift fails before lease renewal and Kubernetes write', async () => {
  for (const patch of [
    { executionPlan: null },
    { executionPlan: { schemaVersion: '1.0', authority: 'OpenSphereRegistry', descriptorId: 'extension.other', catalogRevision, image: installImage } },
  ]) {
    const { calls, controller } = fixture({
      outboxId: 19, operationId, actionId: 'console.extension.install', actionVersion: '1.0',
      targetRef: installImage, payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 5,
      actorRef: '11111111-1111-4111-8111-111111111111', reason: 'install workspace extension',
      correlationId: 'extension-install-correlation-0001', ...patch,
    });
    await assert.rejects(controller.runOnce(), { code: patch.executionPlan ? 'StaleAuthorityRevision' : 'ClaimBindingMismatch' });
    assert.equal(calls.some((call) => ['renew', 'applyRegistration', 'applyInstall'].includes(call.method)), false);
  }
});

test('owner, action, target and digest substitution fail before apply', async () => {
  for (const patch of [
    { ownerRef: 'C_API' },
    { actionId: 'console.registry.connection.replace' },
    { targetRef: 'registry-connection:opensphere-ghcr' },
    { payloadDigest: 'not-a-digest' },
  ]) {
    const { calls, controller } = fixture({
      outboxId: 17, operationId, actionId: 'console.extension.revocation.create',
      actionVersion: '1.0', targetRef: image, payloadDigest: digest, ownerRef: 'C_EXT',
      claimEpoch: 4, ...patch,
    });
    await assert.rejects(controller.runOnce(), { code: 'ClaimBindingMismatch' });
    assert.deepEqual(calls.map((call) => call.method), ['claim']);
  }
});

test('PostgreSQL store binds claim, renewal and execution coordinates', async () => {
  const calls = [];
  const store = createExtensionPostgresStore({
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('claim_owner_operation')) return { rows: [{ claim_record: null }] };
      if (sql.includes('renew_owner_claim')) return { rows: [{ lease_expires_at: new Date() }] };
      if (sql.includes('record_execution_failure')) return { rows: [{ operation_record: { state: 'Failed' } }] };
      if (sql.includes('apply_install_registration')) return { rows: [{ execution_record: { evidenceDigest: digest } }] };
      return { rows: [{ execution_record: { evidenceDigest: digest, inserted: true } }] };
    },
  });
  await store.claim({ workerId, ownerRef: 'C_EXT', supportedActions: ['console.extension.install', 'console.extension.revocation.create'], leaseSeconds: 30 });
  await store.renew({ workerId, outboxId: 17, claimEpoch: 4, leaseSeconds: 30 });
  await store.applyRevocation({ workerId, outboxId: 17, claimEpoch: 4, operationId, targetRef: image, payloadDigest: digest });
  await store.applyInstall({
    workerId, outboxId: 19, claimEpoch: 5, operationId, targetRef: installImage, payloadDigest: digest,
    executionPlan: { schemaVersion: '1.0' }, registrationName: 'workspace', registrationUid: 'registration-uid',
    registrationResourceVersion: '18', packageResourceVersion: '17', packageGeneration: 1, created: true,
  });
  await store.recordFailure({
    workerId, outboxId: 18, claimEpoch: 5, operationId,
    errorCode: 'OwnerRejected', errorDigest: digest, sideEffectUnknown: false,
  });
  assert.match(calls[0].sql, /claim_owner_operation/);
  assert.deepEqual(calls[0].values[2], ['console.extension.install', 'console.extension.revocation.create']);
  assert.match(calls[1].sql, /renew_owner_claim/);
  assert.match(calls[2].sql, /apply_revocation/);
  assert.equal(calls[2].values.length, 6);
  assert.match(calls[3].sql, /apply_install_registration/);
  assert.equal(calls[3].values.length, 13);
  assert.match(calls[4].sql, /record_execution_failure/);
  assert.equal(calls[4].values.length, 7);
});
