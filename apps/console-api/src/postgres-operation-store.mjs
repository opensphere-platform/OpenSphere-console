const ACCEPT_SQL = [
  'SELECT operation_record, replayed',
  'FROM console_operation.accept_operation(',
  '$1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::text, $6::text,',
  '$7::text, $8::text, $9::text, $10::text, $11::text, $12::text,',
  '$13::boolean, $14::text, $15::text, $16::text, $17::text, $18::jsonb',
  ')',
].join(' ');

const GET_SQL = [
  'SELECT console_operation.get_operation(',
  '$1::uuid, $2::uuid, $3::uuid',
  ') AS operation_record',
].join(' ');

const APPROVE_SQL = [
  'SELECT operation_record, replayed',
  'FROM console_operation.approve_operation(',
  '$1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::uuid, $6::bigint,',
  '$7::text, $8::text, $9::text, $10::text, $11::text',
  ')',
].join(' ');

const RESOLVE_SESSION_SQL = [
  'SELECT console_identity.resolve_browser_session(',
  '$1::bytea, $2::bytea, $3::boolean',
  ') AS session_record',
].join(' ');

function databaseError(error) {
  const code = String(error?.detail || '');
  const known = new Set([
    'ValidationFailed', 'ReasonRequired', 'SessionInvalid', 'StaleAuthorityRevision',
    'PermissionDenied', 'StepUpRequired', 'IdempotencyMismatch', 'CsrfRejected',
    'SelfApprovalDenied', 'ApprovalNotRequired', 'StaleRevision',
    'StaleOperationVersion', 'InvalidOperationState', 'NotFound',
  ]);
  const mapped = known.has(code) ? code : 'AuthorityUnavailable';
  const status = {
    ValidationFailed: 400,
    ReasonRequired: 422,
    SessionInvalid: 401,
    StaleAuthorityRevision: 409,
    PermissionDenied: 403,
    StepUpRequired: 403,
    IdempotencyMismatch: 409,
    AuthorityUnavailable: 503,
    CsrfRejected: 403,
    SelfApprovalDenied: 403,
    ApprovalNotRequired: 409,
    StaleRevision: 409,
    StaleOperationVersion: 409,
    InvalidOperationState: 409,
    NotFound: 404,
  }[mapped];
  const messages = {
    ValidationFailed: 'operation request failed database validation',
    ReasonRequired: 'operation reason is required',
    SessionInvalid: 'active Console session is required',
    StaleAuthorityRevision: 'session authority revision is stale',
    PermissionDenied: 'permission denied',
    StepUpRequired: 'recent aal2 is required',
    IdempotencyMismatch: 'idempotency key belongs to a different request',
    AuthorityUnavailable: 'Console authority database is unavailable',
    CsrfRejected: 'Console session CSRF validation failed',
    SelfApprovalDenied: 'operation initiator cannot approve the same operation',
    ApprovalNotRequired: 'operation does not require approval',
    StaleRevision: 'approval policy revision is stale',
    StaleOperationVersion: 'operation state version changed',
    InvalidOperationState: 'operation is not awaiting approval',
    NotFound: 'operation was not found',
  };
  return Object.assign(new Error(messages[mapped]), {
    code: mapped,
    status,
    cause: error,
  });
}

export function createPostgresOperationStore({ query }) {
  if (typeof query !== 'function') throw new TypeError('PostgreSQL query function is required');
  return Object.freeze({
    async health() {
      try {
        const result = await query('SELECT 1 AS ready');
        return result?.rows?.[0]?.ready === 1;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async resolveSession(input) {
      try {
        const result = await query(RESOLVE_SESSION_SQL, [
          input.tokenDigest,
          input.csrfTokenDigest,
          input.requireCsrf,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw Object.assign(new Error('session was not found'), { detail: 'SessionInvalid' });
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async accept(input) {
      try {
        const result = await query(ACCEPT_SQL, [
          input.sessionId,
          input.actorRef,
          input.expectedPermissionRevision,
          input.expectedRevokeEpoch,
          input.requiredPermission,
          input.actionId,
          input.actionVersion,
          input.targetRef,
          input.payloadDigest,
          input.risk,
          input.reason,
          input.planRevision,
          input.approvalRequired,
          input.idempotencyKey,
          input.correlationId,
          input.sourceRevision,
          input.ownerRef,
          input.expectedPostcondition == null ? null : JSON.stringify(input.expectedPostcondition),
        ]);
        const row = result?.rows?.[0];
        if (!row?.operation_record) throw new Error('accept_operation returned no receipt');
        return { operationRecord: row.operation_record, replayed: row.replayed };
      } catch (error) {
        throw databaseError(error);
      }
    },

    async approve(input) {
      try {
        const result = await query(APPROVE_SQL, [
          input.sessionId,
          input.actorRef,
          input.expectedPermissionRevision,
          input.expectedRevokeEpoch,
          input.operationId,
          input.expectedStateVersion,
          input.reason,
          input.approvalRevision,
          input.confirmation,
          input.idempotencyKey,
          input.correlationId,
        ]);
        const row = result?.rows?.[0];
        if (!row?.operation_record) throw new Error('approve_operation returned no receipt');
        return { operationRecord: row.operation_record, replayed: row.replayed };
      } catch (error) {
        throw databaseError(error);
      }
    },

    async get(input) {
      try {
        const result = await query(GET_SQL, [input.sessionId, input.actorRef, input.operationId]);
        return result?.rows?.[0]?.operation_record || null;
      } catch (error) {
        throw databaseError(error);
      }
    },
  });
}
