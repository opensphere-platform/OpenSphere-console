const OWNER_REF = 'C_EXT';
const REVOCATION_ACTION = 'console.extension.revocation.create';
const IMAGE = /^ghcr\.io\/opensphere-platform\/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function claimField(claim, field) {
  const value = claim?.[field];
  if (value == null || value === '') throw Object.assign(new Error('claim is missing ' + field), { code: 'ClaimBindingMismatch' });
  return value;
}

export function createExtensionController({ store, workerId, leaseSeconds = 30 }) {
  if (!store?.claim || !store?.renew || !store?.applyRevocation) {
    throw new TypeError('Extension Controller store claim/renew/applyRevocation is required');
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
        supportedActions: [REVOCATION_ACTION],
        leaseSeconds,
      });
      if (!claim) return Object.freeze({ state: 'Idle' });
      if (claim.ownerRef !== OWNER_REF || claim.actionId !== REVOCATION_ACTION) {
        throw Object.assign(new Error('claimed operation is outside the C_EXT revocation boundary'), {
          code: 'ClaimBindingMismatch',
        });
      }
      const targetRef = String(claimField(claim, 'targetRef'));
      const payloadDigest = String(claimField(claim, 'payloadDigest'));
      if (!IMAGE.test(targetRef) || !DIGEST.test(payloadDigest)) {
        throw Object.assign(new Error('claimed revocation has invalid immutable coordinates'), {
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
      await store.renew({ ...input, leaseSeconds });
      const execution = await store.applyRevocation(input);
      return Object.freeze({
        state: 'Applied',
        operationId: input.operationId,
        claimEpoch: input.claimEpoch,
        evidenceDigest: execution.evidenceDigest,
        inserted: Boolean(execution.inserted),
      });
    },
  });
}
