import { createHash } from 'node:crypto';

const OWNER_REF = 'C_EXT';
const INSTALL_ACTION = 'console.extension.install';
const REMOVE_ACTION = 'console.extension.remove';
const REVOCATION_ACTION = 'console.extension.revocation.create';
const IMAGE = /^ghcr\.io\/opensphere-platform\/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const RESOURCE_VERSION = /^[0-9A-Za-z._:-]{1,128}$/;

function claimField(claim, field) {
  const value = claim?.[field];
  if (value == null || value === '') throw Object.assign(new Error('claim is missing ' + field), { code: 'ClaimBindingMismatch' });
  return value;
}

function installPlan(claim) {
  const plan = claim?.executionPlan;
  const fields = ['schemaVersion', 'authority', 'descriptorId', 'catalogRevision', 'image'];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
      || Object.keys(plan).some((key) => !fields.includes(key)) || Object.keys(plan).length !== fields.length
      || plan.schemaVersion !== '1.0' || plan.authority !== 'OpenSphereRegistry'
      || !/^extension\.[a-z0-9][a-z0-9-]{0,62}$/.test(String(plan.descriptorId || ''))
      || !DIGEST.test(String(plan.catalogRevision || '')) || !IMAGE.test(String(plan.image || ''))
      || plan.image !== claim.targetRef) {
    throw Object.assign(new Error('install claim lacks its exact C_REG execution plan'), { code: 'ClaimBindingMismatch' });
  }
  return plan;
}

function observationCoordinates(claim, plan) {
  const value = claim?.dispatchPayload;
  const fields = [
    'schemaVersion', 'eventType', 'operationId', 'descriptorId', 'image',
    'packageResourceVersion', 'packageGeneration', 'manifestDigest', 'sourceRevision',
    'compatibilityVersion', 'keyId', 'registrationName', 'registrationUid', 'appliedReceiptDigest',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))
      || value.schemaVersion !== '1.0' || value.eventType !== 'ExtensionInstallObservationRequested'
      || value.operationId !== claim.operationId || value.descriptorId !== plan.descriptorId
      || value.image !== plan.image || !RESOURCE_VERSION.test(String(value.packageResourceVersion || ''))
      || !Number.isSafeInteger(value.packageGeneration) || value.packageGeneration < 1
      || !DIGEST.test(String(value.manifestDigest || '')) || !SOURCE_REVISION.test(String(value.sourceRevision || ''))
      || !SEMVER.test(String(value.compatibilityVersion || ''))
      || typeof value.keyId !== 'string' || value.keyId.length < 1 || value.keyId.length > 256
      || value.registrationName !== plan.descriptorId.slice('extension.'.length)
      || typeof value.registrationUid !== 'string' || value.registrationUid.length < 1 || value.registrationUid.length > 128
      || !DIGEST.test(String(value.appliedReceiptDigest || ''))) {
    throw Object.assign(new Error('install observation claim lacks exact applied coordinates'), { code: 'ClaimBindingMismatch' });
  }
  const digest = plan.image.slice(plan.image.lastIndexOf('@') + 1);
  return Object.freeze({
    candidate: Object.freeze({
      id: value.registrationName, descriptorId: value.descriptorId, kind: 'extension', image: value.image,
      digest, channel: 'edge', sourceRevision: value.sourceRevision, manifestDigest: value.manifestDigest,
      compatibilityVersion: value.compatibilityVersion, keyId: value.keyId,
      packageResourceVersion: value.packageResourceVersion, packageGeneration: value.packageGeneration,
    }),
    registrationUid: value.registrationUid,
    appliedReceiptDigest: value.appliedReceiptDigest,
  });
}

function removalObservationCoordinates(claim) {
  const value = claim?.dispatchPayload;
  const fields = [
    'schemaVersion', 'eventType', 'operationId', 'descriptorId',
    'registrationName', 'registrationUid', 'appliedReceiptDigest',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))
      || value.schemaVersion !== '1.0' || value.eventType !== 'ExtensionRemovalObservationRequested'
      || value.operationId !== claim.operationId || value.descriptorId !== claim.targetRef
      || !/^extension\.[a-z0-9][a-z0-9-]{0,62}$/.test(String(value.descriptorId || ''))
      || value.registrationName !== value.descriptorId.slice('extension.'.length)
      || typeof value.registrationUid !== 'string' || value.registrationUid.length < 1 || value.registrationUid.length > 128
      || !DIGEST.test(String(value.appliedReceiptDigest || ''))) {
    throw Object.assign(new Error('removal observation claim lacks exact applied coordinates'), { code: 'ClaimBindingMismatch' });
  }
  return Object.freeze({
    registrationName: value.registrationName,
    registrationUid: value.registrationUid,
    appliedReceiptDigest: value.appliedReceiptDigest,
  });
}

function failureDigest(actionId, code) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify({ actionId, code })).digest('hex');
}

export function createExtensionController({ store, registryResolver, registrationWriter, workerId, leaseSeconds = 30 }) {
  if (!store?.claim || !store?.renew || !store?.applyRevocation || !store?.applyInstall
      || !store?.recordInstallObservation || !store?.applyRemove || !store?.recordRemoveObservation || !store?.recordFailure) {
    throw new TypeError('Extension Controller store claim/renew/apply/observe methods are required');
  }
  if (!/^[0-9a-f-]{36}$/.test(String(workerId || ''))) throw new TypeError('workerId must be a UUID');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
    throw new TypeError('leaseSeconds must be an integer between 5 and 300');
  }

  return Object.freeze({
    async runOnce() {
      const claim = await store.claim({
        workerId,
        ownerRef: OWNER_REF,
        supportedActions: [INSTALL_ACTION, REMOVE_ACTION, REVOCATION_ACTION],
        leaseSeconds,
      });
      if (!claim) return Object.freeze({ state: 'Idle' });
      if (claim.ownerRef !== OWNER_REF || ![INSTALL_ACTION, REMOVE_ACTION, REVOCATION_ACTION].includes(claim.actionId)) {
        throw Object.assign(new Error('claimed operation is outside the C_EXT typed boundary'), {
          code: 'ClaimBindingMismatch',
        });
      }
      const targetRef = String(claimField(claim, 'targetRef'));
      const payloadDigest = String(claimField(claim, 'payloadDigest'));
      const targetValid = claim.actionId === REMOVE_ACTION
        ? /^extension\.[a-z0-9][a-z0-9-]{0,62}$/.test(targetRef)
        : IMAGE.test(targetRef);
      if (!targetValid || !DIGEST.test(payloadDigest)) {
        throw Object.assign(new Error('claimed operation has invalid immutable coordinates'), {
          code: 'ClaimBindingMismatch',
        });
      }
      const input = {
        workerId,
        outboxId: Number(claimField(claim, 'outboxId')),
        claimEpoch: Number(claimField(claim, 'claimEpoch')),
        operationId: String(claimField(claim, 'operationId')),
        targetRef,
        payloadDigest,
      };
      if (!Number.isSafeInteger(input.outboxId) || !Number.isSafeInteger(input.claimEpoch)) {
        throw Object.assign(new Error('claim fencing coordinates are invalid'), { code: 'ClaimBindingMismatch' });
      }

      const dispatchPhase = String(claim.dispatchPhase || 'apply');
      if (!['apply', 'observe'].includes(dispatchPhase)
          || (dispatchPhase === 'observe' && ![INSTALL_ACTION, REMOVE_ACTION].includes(claim.actionId))) {
        throw Object.assign(new Error('claimed operation has an invalid dispatch phase'), { code: 'ClaimBindingMismatch' });
      }

      if (claim.actionId === INSTALL_ACTION && dispatchPhase === 'observe') {
        if (!registrationWriter?.observeInstall) {
          throw Object.assign(new Error('Extension observation dependency is unavailable'), { code: 'AuthorityUnavailable' });
        }
        const plan = installPlan(claim);
        const coordinates = observationCoordinates(claim, plan);
        await store.renew({ ...input, leaseSeconds });
        const result = await registrationWriter.observeInstall(coordinates);
        if (result.state !== 'Ready') {
          return Object.freeze({
            state: 'Pending', actionId: INSTALL_ACTION, operationId: input.operationId,
            claimEpoch: input.claimEpoch, reason: result.reason || 'RegistrationNotReady',
          });
        }
        const receipt = await store.recordInstallObservation({
          ...input, appliedReceiptDigest: coordinates.appliedReceiptDigest,
          observation: result.observation,
        });
        return Object.freeze({
          state: 'Observed', actionId: INSTALL_ACTION, operationId: input.operationId,
          claimEpoch: input.claimEpoch, evidenceDigest: receipt.evidenceDigest,
          postcondition: 'InstallReady',
        });
      }

      if (claim.actionId === REMOVE_ACTION && dispatchPhase === 'observe') {
        if (!registrationWriter?.observeRemove) {
          throw Object.assign(new Error('Extension removal observation dependency is unavailable'), { code: 'AuthorityUnavailable' });
        }
        const coordinates = removalObservationCoordinates(claim);
        await store.renew({ ...input, leaseSeconds });
        const result = await registrationWriter.observeRemove(coordinates);
        if (result.state !== 'Removed') {
          return Object.freeze({
            state: 'Pending', actionId: REMOVE_ACTION, operationId: input.operationId,
            claimEpoch: input.claimEpoch, reason: result.reason || 'RegistrationStillPresent',
          });
        }
        const receipt = await store.recordRemoveObservation({
          ...input, appliedReceiptDigest: coordinates.appliedReceiptDigest,
          observation: result.observation,
        });
        return Object.freeze({
          state: 'Observed', actionId: REMOVE_ACTION, operationId: input.operationId,
          claimEpoch: input.claimEpoch, evidenceDigest: receipt.evidenceDigest,
          postcondition: 'RegistrationAbsent',
        });
      }

      if (claim.actionId === INSTALL_ACTION) {
        if (!registryResolver?.resolveExtension || !registrationWriter?.applyInstall) {
          throw Object.assign(new Error('Extension install dependencies are unavailable'), { code: 'AuthorityUnavailable' });
        }
        const plan = installPlan(claim);
        const candidate = await registryResolver.resolveExtension({
          descriptorId: plan.descriptorId,
          catalogRevision: plan.catalogRevision,
          correlationId: claimField(claim, 'correlationId'),
        });
        if (candidate.image !== plan.image || candidate.descriptorId !== plan.descriptorId
            || candidate.catalogRevision !== plan.catalogRevision) {
          throw Object.assign(new Error('C_REG candidate changed after operation approval'), { code: 'StaleAuthorityRevision' });
        }
        await store.renew({ ...input, leaseSeconds });
        const applied = await registrationWriter.applyInstall({
          candidate,
          operationId: input.operationId,
          requestedBy: String(claimField(claim, 'actorRef')),
          reason: String(claimField(claim, 'reason')),
        });
        const execution = await store.applyInstall({ ...input, executionPlan: plan, ...applied });
        return Object.freeze({
          state: 'Applied', actionId: INSTALL_ACTION, operationId: input.operationId,
          claimEpoch: input.claimEpoch, evidenceDigest: execution.evidenceDigest,
          registrationName: applied.registrationName, created: applied.created,
        });
      }


      if (claim.actionId === REMOVE_ACTION) {
        if (!registrationWriter?.applyRemove) {
          throw Object.assign(new Error('Extension removal dependency is unavailable'), { code: 'AuthorityUnavailable' });
        }
        await store.renew({ ...input, leaseSeconds });
        let applied;
        try {
          applied = await registrationWriter.applyRemove({
            descriptorId: targetRef,
            operationId: input.operationId,
            requestedBy: String(claimField(claim, 'actorRef')),
            reason: String(claimField(claim, 'reason')),
          });
        } catch (error) {
          if (!error?.terminal) throw error;
          const errorCode = String(error.code || 'OwnerRejected');
          await store.recordFailure({
            ...input,
            errorCode,
            errorDigest: failureDigest(REMOVE_ACTION, errorCode),
            sideEffectUnknown: false,
          });
          return Object.freeze({
            state: 'Failed', actionId: REMOVE_ACTION, operationId: input.operationId,
            claimEpoch: input.claimEpoch, errorCode,
          });
        }
        const execution = await store.applyRemove({ ...input, ...applied });
        return Object.freeze({
          state: 'Applied', actionId: REMOVE_ACTION, operationId: input.operationId,
          claimEpoch: input.claimEpoch, evidenceDigest: execution.evidenceDigest,
          registrationName: applied.registrationName, changed: applied.changed,
        });
      }

      await store.renew({ ...input, leaseSeconds });
      const execution = await store.applyRevocation(input);
      return Object.freeze({
        state: 'Applied', actionId: REVOCATION_ACTION,
        operationId: input.operationId,
        claimEpoch: input.claimEpoch,
        evidenceDigest: execution.evidenceDigest,
        inserted: Boolean(execution.inserted),
      });
    },
  });
}
