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

function fixture(claim, observationResult = null, writerOverrides = {}, controllerOverrides = {}) {
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
    async recordInstallObservation(input) {
      calls.push({ method: 'recordInstallObservation', input });
      return { evidenceDigest: digest };
    },
    async applyRemove(input) {
      calls.push({ method: 'applyRemove', input });
      return { evidenceDigest: digest };
    },
    async recordRemoveObservation(input) {
      calls.push({ method: 'recordRemoveObservation', input });
      return { evidenceDigest: digest };
    },
    async recordFailure(input) {
      calls.push({ method: 'recordFailure', input });
      return { state: input.sideEffect === 'unknown' ? 'Unknown' : 'Failed' };
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
        manifestDigest: candidate.manifestDigest, sourceRevision: candidate.sourceRevision,
        compatibilityVersion: candidate.compatibilityVersion, keyId: candidate.keyId,
      };
    },
    async observeInstall(input) {
      calls.push({ method: 'observeRegistration', input });
      return observationResult || {
        state: 'Ready',
        observation: {
          package: { name: 'workspace' }, registration: { name: 'workspace' },
          workload: { phase: 'Ready' }, verification: { manifest: 'Verified' },
          serving: { phase: 'Current' }, revalidation: { phase: 'Passed' },
        },
      };
    },
    async applyRemove(input) {
      calls.push({ method: 'applyRemoval', input });
      return {
        descriptorId: 'extension.workspace', registrationName: 'workspace', registrationUid: 'registration-uid',
        registrationResourceVersionBefore: '19', registrationResourceVersion: '20', registrationGeneration: 4,
        packageResourceVersion: '17', packageGeneration: 1, packageScope: 'workspace-extension', changed: true,
      };
    },
    async observeRemove(input) {
      calls.push({ method: 'observeRemoval', input });
      return observationResult || {
        state: 'Removed',
        observation: { registration: { name: 'workspace', uid: 'registration-uid', phase: 'Absent' } },
      };
    },
    ...writerOverrides,
  };
  return {
    calls,
    controller: createExtensionController({
      store, registryResolver, registrationWriter, workerId, leaseSeconds: 30, ...controllerOverrides,
    }),
  };
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

test('install observation preserves Applied until exact Kubernetes readiness is recorded', async () => {
  const dispatchPayload = {
    schemaVersion: '1.0', eventType: 'ExtensionInstallObservationRequested', operationId,
    descriptorId: 'extension.workspace', image: installImage, packageResourceVersion: '17',
    packageGeneration: 1, manifestDigest: candidate.manifestDigest, sourceRevision: candidate.sourceRevision,
    compatibilityVersion: candidate.compatibilityVersion, keyId: candidate.keyId,
    registrationName: 'workspace', registrationUid: 'registration-uid', appliedReceiptDigest: digest,
  };
  const { calls, controller } = fixture({
    outboxId: 20, operationId, actionId: 'console.extension.install', actionVersion: '1.0',
    targetRef: installImage, payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 1,
    dispatchPhase: 'observe', dispatchPayload, attemptCount: 1,
    executionPlan: {
      schemaVersion: '1.0', authority: 'OpenSphereRegistry', descriptorId: 'extension.workspace',
      catalogRevision, image: installImage,
    },
  });
  const result = await controller.runOnce();
  assert.equal(result.state, 'Observed');
  assert.equal(result.postcondition, 'InstallReady');
  assert.deepEqual(calls.map((call) => call.method), [
    'claim', 'renew', 'observeRegistration', 'recordInstallObservation',
  ]);
  assert.equal(calls[2].input.registrationUid, 'registration-uid');
  assert.equal(calls[3].input.appliedReceiptDigest, digest);
});

test('pending install observation does not record readiness or change operation state', async () => {
  const dispatchPayload = {
    schemaVersion: '1.0', eventType: 'ExtensionInstallObservationRequested', operationId,
    descriptorId: 'extension.workspace', image: installImage, packageResourceVersion: '17',
    packageGeneration: 1, manifestDigest: candidate.manifestDigest, sourceRevision: candidate.sourceRevision,
    compatibilityVersion: candidate.compatibilityVersion, keyId: candidate.keyId,
    registrationName: 'workspace', registrationUid: 'registration-uid', appliedReceiptDigest: digest,
  };
  const { calls, controller } = fixture({
    outboxId: 20, operationId, actionId: 'console.extension.install', actionVersion: '1.0',
    targetRef: installImage, payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 1,
    dispatchPhase: 'observe', dispatchPayload, attemptCount: 1,
    executionPlan: {
      schemaVersion: '1.0', authority: 'OpenSphereRegistry', descriptorId: 'extension.workspace',
      catalogRevision, image: installImage,
    },
  }, { state: 'Pending', reason: 'RegistrationNotReady' });
  const result = await controller.runOnce();
  assert.deepEqual(result, {
    state: 'Pending', actionId: 'console.extension.install', operationId,
    claimEpoch: 1, reason: 'RegistrationNotReady', attemptCount: 1,
  });
  assert.deepEqual(calls.map((call) => call.method), ['claim', 'renew', 'observeRegistration']);
});

test('last pending install observation closes durably as Unknown without another queue', async () => {
  const dispatchPayload = {
    schemaVersion: '1.0', eventType: 'ExtensionInstallObservationRequested', operationId,
    descriptorId: 'extension.workspace', image: installImage, packageResourceVersion: '17',
    packageGeneration: 1, manifestDigest: candidate.manifestDigest, sourceRevision: candidate.sourceRevision,
    compatibilityVersion: candidate.compatibilityVersion, keyId: candidate.keyId,
    registrationName: 'workspace', registrationUid: 'registration-uid', appliedReceiptDigest: digest,
  };
  const { calls, controller } = fixture({
    outboxId: 20, operationId, actionId: 'console.extension.install', actionVersion: '1.0',
    targetRef: installImage, payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 2,
    dispatchPhase: 'observe', dispatchPayload, attemptCount: 2,
    executionPlan: {
      schemaVersion: '1.0', authority: 'OpenSphereRegistry', descriptorId: 'extension.workspace',
      catalogRevision, image: installImage,
    },
  }, { state: 'Pending', reason: 'RegistrationNotReady' }, {}, { maxObservationAttempts: 2 });
  const result = await controller.runOnce();
  assert.deepEqual(result, {
    state: 'Unknown', actionId: 'console.extension.install', operationId,
    claimEpoch: 2, errorCode: 'ObservationTimeout', attemptCount: 2,
  });
  assert.deepEqual(calls.map((call) => call.method), [
    'claim', 'renew', 'observeRegistration', 'recordFailure',
  ]);
  assert.equal(calls[3].input.sideEffect, 'unknown');
});

test('irrecoverable install observation identity loss closes immediately as Unknown', async () => {
  const dispatchPayload = {
    schemaVersion: '1.0', eventType: 'ExtensionInstallObservationRequested', operationId,
    descriptorId: 'extension.workspace', image: installImage, packageResourceVersion: '17',
    packageGeneration: 1, manifestDigest: candidate.manifestDigest, sourceRevision: candidate.sourceRevision,
    compatibilityVersion: candidate.compatibilityVersion, keyId: candidate.keyId,
    registrationName: 'workspace', registrationUid: 'registration-uid', appliedReceiptDigest: digest,
  };
  const missing = Object.assign(new Error('registration disappeared'), {
    code: 'ResourceNotFound', sideEffect: 'unknown',
  });
  const { calls, controller } = fixture({
    outboxId: 20, operationId, actionId: 'console.extension.install', actionVersion: '1.0',
    targetRef: installImage, payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 1,
    dispatchPhase: 'observe', dispatchPayload, attemptCount: 1,
    executionPlan: {
      schemaVersion: '1.0', authority: 'OpenSphereRegistry', descriptorId: 'extension.workspace',
      catalogRevision, image: installImage,
    },
  }, null, { async observeInstall() { throw missing; } }, { maxObservationAttempts: 20 });
  const result = await controller.runOnce();
  assert.equal(result.state, 'Unknown');
  assert.equal(result.errorCode, 'ResourceNotFound');
  assert.deepEqual(calls.map((call) => call.method), ['claim', 'renew', 'recordFailure']);
  assert.equal(calls[2].input.sideEffect, 'unknown');
});

test('typed removal applies Uninstalled intent before recording its fenced receipt', async () => {
  const { calls, controller } = fixture({
    outboxId: 21, operationId, actionId: 'console.extension.remove', actionVersion: '1.0',
    targetRef: 'extension.workspace', payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 2,
    actorRef: '11111111-1111-4111-8111-111111111111', reason: 'remove retired workspace extension',
  });
  const result = await controller.runOnce();
  assert.equal(result.state, 'Applied');
  assert.equal(result.actionId, 'console.extension.remove');
  assert.deepEqual(calls.map((call) => call.method), ['claim', 'renew', 'applyRemoval', 'applyRemove']);
  assert.equal(calls[2].input.descriptorId, 'extension.workspace');
  assert.equal(calls[3].input.registrationUid, 'registration-uid');
});

test('removal observation records success only after the exact Registration is absent', async () => {
  const dispatchPayload = {
    schemaVersion: '1.0', eventType: 'ExtensionRemovalObservationRequested', operationId,
    descriptorId: 'extension.workspace', registrationName: 'workspace',
    registrationUid: 'registration-uid', appliedReceiptDigest: digest,
  };
  const { calls, controller } = fixture({
    outboxId: 22, operationId, actionId: 'console.extension.remove', actionVersion: '1.0',
    targetRef: 'extension.workspace', payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 1,
    dispatchPhase: 'observe', dispatchPayload, attemptCount: 1,
  });
  const result = await controller.runOnce();
  assert.equal(result.state, 'Observed');
  assert.equal(result.postcondition, 'RegistrationAbsent');
  assert.deepEqual(calls.map((call) => call.method), [
    'claim', 'renew', 'observeRemoval', 'recordRemoveObservation',
  ]);
  assert.equal(calls[3].input.appliedReceiptDigest, digest);
});

test('known no-side-effect removal denial closes as a typed failure', async () => {
  const terminal = Object.assign(new Error('core Extension'), { code: 'OwnerRejected', terminal: true });
  const { calls, controller } = fixture({
    outboxId: 21, operationId, actionId: 'console.extension.remove', actionVersion: '1.0',
    targetRef: 'extension.workspace', payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 2,
    actorRef: '11111111-1111-4111-8111-111111111111', reason: 'remove retired workspace extension',
  }, null, { async applyRemove() { throw terminal; } });
  const result = await controller.runOnce();
  assert.equal(result.state, 'Failed');
  assert.equal(result.errorCode, 'OwnerRejected');
  assert.deepEqual(calls.map((call) => call.method), ['claim', 'renew', 'recordFailure']);
  assert.match(calls[2].input.errorDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(calls[2].input.sideEffect, 'none');
});

test('terminal removal observation closes as Failed with known side effect', async () => {
  const dispatchPayload = {
    schemaVersion: '1.0', eventType: 'ExtensionRemovalObservationRequested', operationId,
    descriptorId: 'extension.workspace', registrationName: 'workspace',
    registrationUid: 'registration-uid', appliedReceiptDigest: digest,
  };
  const terminal = Object.assign(new Error('terminal removal failure'), {
    code: 'OwnerRejected', terminal: true, sideEffect: 'present',
  });
  const { calls, controller } = fixture({
    outboxId: 22, operationId, actionId: 'console.extension.remove', actionVersion: '1.0',
    targetRef: 'extension.workspace', payloadDigest: digest, ownerRef: 'C_EXT', claimEpoch: 1,
    dispatchPhase: 'observe', dispatchPayload, attemptCount: 1,
  }, null, { async observeRemove() { throw terminal; } });
  const result = await controller.runOnce();
  assert.deepEqual(result, {
    state: 'Failed', actionId: 'console.extension.remove', operationId,
    claimEpoch: 1, errorCode: 'OwnerRejected', attemptCount: 1,
  });
  assert.deepEqual(calls.map((call) => call.method), ['claim', 'renew', 'recordFailure']);
  assert.equal(calls[2].input.sideEffect, 'present');
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
      if (sql.includes('record_install_observation')) return { rows: [{ execution_record: { evidenceDigest: digest } }] };
      if (sql.includes('record_remove_observation')) return { rows: [{ execution_record: { evidenceDigest: digest } }] };
      if (sql.includes('apply_remove_registration')) return { rows: [{ execution_record: { evidenceDigest: digest } }] };
      if (sql.includes('apply_install_registration')) return { rows: [{ execution_record: { evidenceDigest: digest } }] };
      return { rows: [{ execution_record: { evidenceDigest: digest, inserted: true } }] };
    },
  });
  await store.claim({
    workerId, ownerRef: 'C_EXT',
    supportedActions: ['console.extension.install', 'console.extension.remove', 'console.extension.revocation.create'],
    leaseSeconds: 30,
  });
  await store.renew({ workerId, outboxId: 17, claimEpoch: 4, leaseSeconds: 30 });
  await store.applyRevocation({ workerId, outboxId: 17, claimEpoch: 4, operationId, targetRef: image, payloadDigest: digest });
  await store.applyInstall({
    workerId, outboxId: 19, claimEpoch: 5, operationId, targetRef: installImage, payloadDigest: digest,
    executionPlan: { schemaVersion: '1.0' }, registrationName: 'workspace', registrationUid: 'registration-uid',
    registrationResourceVersion: '18', packageResourceVersion: '17', packageGeneration: 1, created: true,
    manifestDigest: candidate.manifestDigest, sourceRevision: candidate.sourceRevision,
    compatibilityVersion: candidate.compatibilityVersion, keyId: candidate.keyId,
  });
  await store.recordInstallObservation({
    workerId, outboxId: 20, claimEpoch: 1, operationId, targetRef: installImage,
    payloadDigest: digest, appliedReceiptDigest: digest, observation: { package: {} },
  });
  await store.applyRemove({
    workerId, outboxId: 21, claimEpoch: 2, operationId, targetRef: 'extension.workspace', payloadDigest: digest,
    registrationName: 'workspace', registrationUid: 'registration-uid',
    registrationResourceVersionBefore: '19', registrationResourceVersion: '20', registrationGeneration: 4,
    packageResourceVersion: '17', packageGeneration: 1, packageScope: 'workspace-extension', changed: true,
  });
  await store.recordRemoveObservation({
    workerId, outboxId: 22, claimEpoch: 1, operationId, targetRef: 'extension.workspace',
    payloadDigest: digest, appliedReceiptDigest: digest,
    observation: { registration: { name: 'workspace', uid: 'registration-uid', phase: 'Absent' } },
  });
  await store.recordFailure({
    workerId, outboxId: 18, claimEpoch: 5, operationId,
    errorCode: 'OwnerRejected', errorDigest: digest, sideEffect: 'none',
  });
  assert.match(calls[0].sql, /claim_owner_operation/);
  assert.deepEqual(calls[0].values[2], ['console.extension.install', 'console.extension.remove', 'console.extension.revocation.create']);
  assert.match(calls[1].sql, /renew_owner_claim/);
  assert.match(calls[2].sql, /apply_revocation/);
  assert.equal(calls[2].values.length, 6);
  assert.match(calls[3].sql, /apply_install_registration/);
  assert.equal(calls[3].values.length, 17);
  assert.match(calls[4].sql, /record_install_observation/);
  assert.equal(calls[4].values.length, 8);
  assert.match(calls[5].sql, /apply_remove_registration/);
  assert.equal(calls[5].values.length, 15);
  assert.match(calls[6].sql, /record_remove_observation/);
  assert.equal(calls[6].values.length, 8);
  assert.match(calls[7].sql, /record_execution_failure/);
  assert.equal(calls[7].values.length, 7);
});
