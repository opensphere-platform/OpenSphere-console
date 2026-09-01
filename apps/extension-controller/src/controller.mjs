const OWNER_REF = 'C_EXT';
const INSTALL_ACTION = 'console.extension.install';
const REVOCATION_ACTION = 'console.extension.revocation.create';
const IMAGE = /^ghcr\.io\/opensphere-platform\/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

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

export function createExtensionController({ store, registryResolver, registrationWriter, workerId, leaseSeconds = 30 }) {
  if (!store?.claim || !store?.renew || !store?.applyRevocation || !store?.applyInstall) {
    throw new TypeError('Extension Controller store claim/renew/apply methods are required');
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
        supportedActions: [INSTALL_ACTION, REVOCATION_ACTION],
        leaseSeconds,
      });
      if (!claim) return Object.freeze({ state: 'Idle' });
      if (claim.ownerRef !== OWNER_REF || ![INSTALL_ACTION, REVOCATION_ACTION].includes(claim.actionId)) {
        throw Object.assign(new Error('claimed operation is outside the C_EXT typed boundary'), {
          code: 'ClaimBindingMismatch',
        });
      }
      const targetRef = String(claimField(claim, 'targetRef'));
      const payloadDigest = String(claimField(claim, 'payloadDigest'));
      if (!IMAGE.test(targetRef) || !DIGEST.test(payloadDigest)) {
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
