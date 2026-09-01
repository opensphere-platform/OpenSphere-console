const CLAIM_SQL = [
  'SELECT console_operation.claim_owner_operation(',
  '$1::uuid, $2::text, $3::text[], $4::integer',
  ') AS claim_record',
].join(' ');

const RENEW_SQL = [
  'SELECT console_operation.renew_owner_claim(',
  '$1::uuid, $2::bigint, $3::bigint, $4::integer',
  ') AS lease_expires_at',
].join(' ');

const APPLY_REVOCATION_SQL = [
  'SELECT console_extension.apply_revocation(',
  '$1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::text, $6::text',
  ') AS execution_record',
].join(' ');

const APPLY_INSTALL_SQL = [
  'SELECT console_extension.apply_install_registration(',
  '$1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::text, $6::text,',
  '$7::jsonb, $8::text, $9::text, $10::text, $11::text, $12::bigint, $13::boolean,',
  '$14::text, $15::text, $16::text, $17::text',
  ') AS execution_record',
].join(' ');

const RECORD_INSTALL_OBSERVATION_SQL = [
  'SELECT console_extension.record_install_observation(',
  '$1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::text, $6::text, $7::text, $8::jsonb',
  ') AS execution_record',
].join(' ');

const RECORD_FAILURE_SQL = [
  'SELECT console_extension.record_execution_failure(',
  '$1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::text, $6::text, $7::boolean',
  ') AS operation_record',
].join(' ');

function databaseError(error) {
  const detail = String(error?.detail || '');
  const known = new Set(['ValidationFailed', 'StaleClaim', 'ClaimBindingMismatch']);
  const code = known.has(detail) ? detail : 'AuthorityUnavailable';
  return Object.assign(new Error({
    ValidationFailed: 'Extension Controller request failed database validation',
    StaleClaim: 'Extension Controller claim is stale or expired',
    ClaimBindingMismatch: 'Extension Controller claim binding does not match the action',
    AuthorityUnavailable: 'Extension Controller authority database is unavailable',
  }[code]), {
    code,
    retryable: code === 'AuthorityUnavailable' || code === 'StaleClaim',
    cause: error,
  });
}

export function createExtensionPostgresStore({ query }) {
  if (typeof query !== 'function') throw new TypeError('PostgreSQL query function is required');
  return Object.freeze({
    async health() {
      try {
        return (await query('SELECT 1 AS ready'))?.rows?.[0]?.ready === 1;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async claim({ workerId, ownerRef, supportedActions, leaseSeconds }) {
      try {
        const result = await query(CLAIM_SQL, [workerId, ownerRef, supportedActions, leaseSeconds]);
        return result?.rows?.[0]?.claim_record || null;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async renew({ workerId, outboxId, claimEpoch, leaseSeconds }) {
      try {
        const result = await query(RENEW_SQL, [workerId, outboxId, claimEpoch, leaseSeconds]);
        return result?.rows?.[0]?.lease_expires_at;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async applyRevocation({ workerId, outboxId, claimEpoch, operationId, targetRef, payloadDigest }) {
      try {
        const result = await query(APPLY_REVOCATION_SQL, [
          workerId, outboxId, claimEpoch, operationId, targetRef, payloadDigest,
        ]);
        const record = result?.rows?.[0]?.execution_record;
        if (!record) throw new Error('apply_revocation returned no execution receipt');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async applyInstall({
      workerId, outboxId, claimEpoch, operationId, targetRef, payloadDigest, executionPlan,
      registrationName, registrationUid, registrationResourceVersion,
      packageResourceVersion, packageGeneration, created,
      manifestDigest, sourceRevision, compatibilityVersion, keyId,
    }) {
      try {
        const result = await query(APPLY_INSTALL_SQL, [
          workerId, outboxId, claimEpoch, operationId, targetRef, payloadDigest,
          JSON.stringify(executionPlan), registrationName, registrationUid,
          registrationResourceVersion, packageResourceVersion, packageGeneration, created,
          manifestDigest, sourceRevision, compatibilityVersion, keyId,
        ]);
        const record = result?.rows?.[0]?.execution_record;
        if (!record) throw new Error('apply_install_registration returned no execution receipt');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async recordInstallObservation({
      workerId, outboxId, claimEpoch, operationId, targetRef, payloadDigest,
      appliedReceiptDigest, observation,
    }) {
      try {
        const result = await query(RECORD_INSTALL_OBSERVATION_SQL, [
          workerId, outboxId, claimEpoch, operationId, targetRef, payloadDigest,
          appliedReceiptDigest, JSON.stringify(observation),
        ]);
        const record = result?.rows?.[0]?.execution_record;
        if (!record) throw new Error('record_install_observation returned no execution receipt');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async recordFailure({ workerId, outboxId, claimEpoch, operationId, errorCode, errorDigest, sideEffectUnknown }) {
      try {
        const result = await query(RECORD_FAILURE_SQL, [
          workerId, outboxId, claimEpoch, operationId, errorCode, errorDigest, sideEffectUnknown,
        ]);
        const record = result?.rows?.[0]?.operation_record;
        if (!record) throw new Error('record_execution_failure returned no operation receipt');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },
  });
}
