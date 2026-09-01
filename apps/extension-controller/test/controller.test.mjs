import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtensionController } from '../src/controller.mjs';
import { createExtensionPostgresStore } from '../src/postgres-store.mjs';

const workerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image = 'ghcr.io/opensphere-platform/console@sha256:' + 'c'.repeat(64);
const digest = 'sha256:' + 'd'.repeat(64);

function fixture(claim) {
  const calls = [];
  const store = {
    async claim(input) { calls.push({ method: 'claim', input }); return claim; },
    async renew(input) { calls.push({ method: 'renew', input }); return new Date().toISOString(); },
    async applyRevocation(input) {
      calls.push({ method: 'applyRevocation', input });
      return { evidenceDigest: digest, inserted: true };
    },
  };
  return { calls, controller: createExtensionController({ store, workerId, leaseSeconds: 30 }) };
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
      return { rows: [{ execution_record: { evidenceDigest: digest, inserted: true } }] };
    },
  });
  await store.claim({ workerId, ownerRef: 'C_EXT', supportedActions: ['console.extension.revocation.create'], leaseSeconds: 30 });
  await store.renew({ workerId, outboxId: 17, claimEpoch: 4, leaseSeconds: 30 });
  await store.applyRevocation({ workerId, outboxId: 17, claimEpoch: 4, operationId, targetRef: image, payloadDigest: digest });
  await store.recordFailure({
    workerId, outboxId: 18, claimEpoch: 5, operationId,
    errorCode: 'OwnerRejected', errorDigest: digest, sideEffectUnknown: false,
  });
  assert.match(calls[0].sql, /claim_owner_operation/);
  assert.deepEqual(calls[0].values[2], ['console.extension.revocation.create']);
  assert.match(calls[1].sql, /renew_owner_claim/);
  assert.match(calls[2].sql, /apply_revocation/);
  assert.equal(calls[2].values.length, 6);
  assert.match(calls[3].sql, /record_execution_failure/);
  assert.equal(calls[3].values.length, 7);
});
