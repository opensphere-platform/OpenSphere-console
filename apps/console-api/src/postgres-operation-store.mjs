const ACCEPT_SQL = [
  'SELECT operation_record, replayed',
  'FROM console_operation.accept_operation(',
  '$1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::text, $6::text,',
  '$7::text, $8::text, $9::text, $10::text, $11::text, $12::text,',
  '$13::boolean, $14::text, $15::text, $16::text, $17::text, $18::jsonb, $19::jsonb',
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

const VERIFY_SQL = [
  'SELECT operation_record, replayed',
  'FROM console_operation.verify_extension_operation(',
  '$1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::uuid, $6::bigint,',
  '$7::text, $8::text',
  ')',
].join(' ');

const RESOLVE_SESSION_SQL = [
  'SELECT console_identity.resolve_browser_session(',
  '$1::bytea, $2::bytea, $3::boolean',
  ') AS session_record',
].join(' ');

const ISSUE_SESSION_SQL = [
  'SELECT console_identity.issue_browser_session(',
  '$1::uuid, $2::bytea, $3::bytea, $4::text, $5::text,',
  '$6::text, $7::text, $8::timestamptz, $9::timestamptz, $10::text, $11::boolean, $12::text',
  ') AS session_record',
].join(' ');

const GET_PENDING_MFA_SQL = [
  'SELECT console_identity.get_pending_browser_session_mfa(',
  '$1::bytea, $2::bytea',
  ') AS session_record',
].join(' ');

const ACTIVATE_MFA_SQL = [
  'SELECT console_identity.activate_browser_session_mfa(',
  '$1::uuid, $2::uuid, $3::bytea, $4::text, $5::text,',
  '$6::text, $7::timestamptz, $8::text',
  ') AS session_record',
].join(' ');

const GET_TOTP_ENROLLMENT_CREDENTIALS_SQL = [
  'SELECT console_identity.get_browser_session_totp_enrollment_credentials(',
  '$1::bytea, $2::bytea',
  ') AS session_record',
].join(' ');

const COMPLETE_TOTP_ENROLLMENT_SQL = [
  'SELECT console_identity.complete_browser_session_totp_enrollment(',
  '$1::uuid, $2::uuid, $3::bytea, $4::text, $5::text,',
  '$6::text, $7::timestamptz, $8::text',
  ') AS session_record',
].join(' ');

const GET_STEP_UP_CREDENTIALS_SQL = [
  'SELECT console_identity.get_browser_session_step_up_credentials($1::bytea, $2::bytea) AS session_record',
].join(' ');

const COMPLETE_STEP_UP_SQL = [
  'SELECT console_identity.complete_browser_session_step_up(',
  '$1::uuid, $2::uuid, $3::bytea, $4::text, $5::text,',
  '$6::text, $7::timestamptz, $8::text',
  ') AS session_record',
].join(' ');

const REVOKE_RECOVERED_SUBJECT_SESSIONS_SQL = [
  'SELECT console_identity.revoke_browser_sessions_after_password_recovery(',
  '$1::uuid, $2::text',
  ') AS revocation_record',
].join(' ');

const GET_INITIAL_ADMINISTRATOR_BOOTSTRAP_STATUS_SQL = [
  'SELECT console_identity.get_initial_administrator_bootstrap_status() AS bootstrap_record',
].join(' ');

const CLAIM_INITIAL_ADMINISTRATOR_SQL = [
  'SELECT console_identity.claim_initial_administrator(',
  '$1::uuid, $2::text',
  ') AS bootstrap_record',
].join(' ');

const GET_SESSION_PREFERENCE_CREDENTIALS_SQL = [
  'SELECT console_identity.get_browser_session_preference_credentials($1::bytea) AS session_record',
].join(' ');

const PREPARE_SESSION_PREFERENCE_UPDATE_SQL = [
  'SELECT console_identity.prepare_browser_session_preference_update(',
  '$1::bytea, $2::bytea, $3::text, $4::text',
  ') AS session_record',
].join(' ');

const PREPARE_OWNED_PASSWORD_RECOVERY_LINK_SQL = [
  'SELECT console_identity.prepare_owned_password_recovery_link(',
  '$1::bytea, $2::bytea, $3::text, $4::text, $5::text',
  ') AS recovery_record',
].join(' ');

const PREPARE_OWNED_PROFILE_AVATAR_ACCESS_SQL = [
  'SELECT console_identity.prepare_owned_profile_avatar_access(',
  '$1::bytea, $2::bytea, $3::text, $4::text',
  ') AS avatar_record',
].join(' ');

const TOUCH_SESSION_ACTIVITY_SQL = [
  'SELECT console_identity.touch_browser_session_activity(',
  '$1::bytea, $2::bytea',
  ') AS session_record',
].join(' ');

const LIST_OWNED_SESSIONS_SQL = [
  'SELECT console_identity.list_owned_browser_sessions(',
  '$1::bytea',
  ') AS session_inventory',
].join(' ');

const LIST_OWNED_SESSION_EVENTS_SQL = [
  'SELECT console_identity.list_owned_browser_session_events(',
  '$1::bytea, $2::integer',
  ') AS session_history',
].join(' ');

const REVOKE_OWNED_SESSION_SQL = [
  'SELECT console_identity.revoke_owned_browser_session(',
  '$1::bytea, $2::bytea, $3::uuid, $4::text',
  ') AS revocation_record',
].join(' ');

const REVOKE_ALL_OWNED_SESSIONS_SQL = [
  'SELECT console_identity.revoke_all_owned_browser_sessions(',
  '$1::bytea, $2::bytea, $3::text',
  ') AS revocation_record',
].join(' ');

const GET_REFRESH_CREDENTIALS_SQL = [
  'SELECT console_identity.get_browser_session_refresh_credentials(',
  '$1::bytea, $2::bytea, $3::boolean',
  ') AS session_record',
].join(' ');

const ROTATE_SESSION_CREDENTIALS_SQL = [
  'SELECT console_identity.rotate_browser_session_credentials(',
  '$1::uuid, $2::uuid, $3::bytea, $4::text, $5::text,',
  '$6::text, $7::text, $8::timestamptz, $9::text',
  ') AS refresh_record',
].join(' ');

const REJECT_SESSION_REFRESH_SQL = [
  'SELECT console_identity.reject_browser_session_refresh(',
  '$1::uuid, $2::uuid, $3::bytea, $4::text',
  ') AS refresh_record',
].join(' ');

const LIST_REVOCATIONS_SQL = [
  'SELECT console_extension.list_revocations(',
  '$1::uuid, $2::uuid, $3::text',
  ') AS read_envelope',
].join(' ');

const GET_REGISTRY_CONNECTION_SQL = [
  'SELECT console_extension.get_registry_connection(',
  '$1::uuid, $2::uuid, $3::text',
  ') AS read_envelope',
].join(' ');

const LIST_AUDIT_EVENTS_SQL = [
  'SELECT console_audit.list_events(',
  '$1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::bigint, $6::integer, $7::text',
  ') AS read_envelope',
].join(' ');

const REVOKE_SESSION_SQL = [
  'SELECT console_identity.revoke_browser_session(',
  '$1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::text',
  ') AS revocation_record',
].join(' ');

const GET_SUPABASE_STATUS_SQL = [
  'SELECT console_identity.get_supabase_status(',
  '$1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::text',
  ') AS read_envelope',
].join(' ');

function databaseError(error) {
  const code = String(error?.detail || '');
  const known = new Set([
    'ValidationFailed', 'ReasonRequired', 'SessionInvalid', 'SubjectAuthorityMissing', 'StaleAuthorityRevision',
    'PermissionDenied', 'StepUpRequired', 'IdempotencyMismatch', 'CsrfRejected',
    'SelfApprovalDenied', 'ApprovalNotRequired', 'StaleRevision',
    'StaleOperationVersion', 'InvalidOperationState', 'ObservationMissing',
    'ObservationMismatch', 'NotFound', 'RefreshNotRequired', 'BootstrapComplete',
  ]);
  const mapped = known.has(code) ? code : 'AuthorityUnavailable';
  const status = {
    ValidationFailed: 400,
    ReasonRequired: 422,
    SessionInvalid: 401,
    SubjectAuthorityMissing: 403,
    StaleAuthorityRevision: 409,
    PermissionDenied: 403,
    StepUpRequired: 428,
    IdempotencyMismatch: 409,
    AuthorityUnavailable: 503,
    CsrfRejected: 403,
    SelfApprovalDenied: 403,
    ApprovalNotRequired: 409,
    StaleRevision: 409,
    StaleOperationVersion: 409,
    InvalidOperationState: 409,
    ObservationMissing: 409,
    ObservationMismatch: 409,
    NotFound: 404,
    RefreshNotRequired: 409,
    BootstrapComplete: 409,
  }[mapped];
  const messages = {
    ValidationFailed: 'operation request failed database validation',
    ReasonRequired: 'operation reason is required',
    SessionInvalid: 'active Console session is required',
    SubjectAuthorityMissing: 'Console subject authority is unavailable',
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
    InvalidOperationState: 'operation is not in the required state',
    ObservationMissing: 'required owner observation is missing',
    ObservationMismatch: 'owner observation does not match the operation',
    NotFound: 'operation was not found',
    RefreshNotRequired: 'browser session access credential does not require refresh',
    BootstrapComplete: 'initial administrator bootstrap is already complete',
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

    async issueSession(input) {
      try {
        const result = await query(ISSUE_SESSION_SQL, [
          input.subjectId,
          input.tokenDigest,
          input.csrfTokenDigest,
          input.accessTokenCiphertext,
          input.refreshTokenCiphertext,
          input.authSessionRef,
          input.aal,
          input.accessTokenExpiresAt,
          input.absoluteExpiresAt,
          input.persistence,
          input.pendingMfa,
          input.correlationId,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw new Error('issue_browser_session returned no record');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async getPendingMfa(input) {
      try {
        const result = await query(GET_PENDING_MFA_SQL, [
          input.tokenDigest,
          input.csrfTokenDigest,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw Object.assign(new Error('pending MFA session was not found'), { detail: 'SessionInvalid' });
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async activateMfa(input) {
      try {
        const result = await query(ACTIVATE_MFA_SQL, [
          input.sessionId,
          input.subjectId,
          input.expectedAccessCiphertextDigest,
          input.accessTokenCiphertext,
          input.refreshTokenCiphertext,
          input.authSessionRef,
          input.accessTokenExpiresAt,
          input.correlationId,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw new Error('activate_browser_session_mfa returned no record');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async getTotpEnrollmentCredentials(input) {
      try {
        const result = await query(GET_TOTP_ENROLLMENT_CREDENTIALS_SQL, [
          input.tokenDigest,
          input.csrfTokenDigest,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw Object.assign(new Error('TOTP enrollment credentials were not found'), { detail: 'SessionInvalid' });
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async completeTotpEnrollment(input) {
      try {
        const result = await query(COMPLETE_TOTP_ENROLLMENT_SQL, [
          input.sessionId,
          input.subjectId,
          input.expectedAccessCiphertextDigest,
          input.accessTokenCiphertext,
          input.refreshTokenCiphertext,
          input.authSessionRef,
          input.accessTokenExpiresAt,
          input.correlationId,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw new Error('complete_browser_session_totp_enrollment returned no record');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async getStepUpCredentials(input) {
      try {
        const result = await query(GET_STEP_UP_CREDENTIALS_SQL, [input.tokenDigest, input.csrfTokenDigest]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw Object.assign(new Error('step-up credentials were not found'), { detail: 'SessionInvalid' });
        return record;
      } catch (error) { throw databaseError(error); }
    },

    async completeStepUp(input) {
      try {
        const result = await query(COMPLETE_STEP_UP_SQL, [
          input.sessionId, input.subjectId, input.expectedAccessCiphertextDigest,
          input.accessTokenCiphertext, input.refreshTokenCiphertext, input.authSessionRef,
          input.accessTokenExpiresAt, input.correlationId,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw new Error('complete_browser_session_step_up returned no record');
        return record;
      } catch (error) { throw databaseError(error); }
    },

    async touchActivity(input) {
      try {
        const result = await query(TOUCH_SESSION_ACTIVITY_SQL, [
          input.tokenDigest,
          input.csrfTokenDigest,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw Object.assign(new Error('session activity was not recorded'), { detail: 'SessionInvalid' });
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async listOwnedSessions(input) {
      try {
        const result = await query(LIST_OWNED_SESSIONS_SQL, [input.tokenDigest]);
        const inventory = result?.rows?.[0]?.session_inventory;
        if (!Array.isArray(inventory?.items)) throw new Error('list_owned_browser_sessions returned no inventory');
        return inventory;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async listOwnedSessionEvents(input) {
      try {
        const result = await query(LIST_OWNED_SESSION_EVENTS_SQL, [input.tokenDigest, input.limit]);
        const history = result?.rows?.[0]?.session_history;
        if (!Array.isArray(history?.items)) throw new Error('list_owned_browser_session_events returned no history');
        return history;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async revokeOwnedSession(input) {
      try {
        const result = await query(REVOKE_OWNED_SESSION_SQL, [
          input.tokenDigest, input.csrfTokenDigest, input.targetSessionId, input.correlationId,
        ]);
        const record = result?.rows?.[0]?.revocation_record;
        if (!record?.sessionId) throw new Error('revoke_owned_browser_session returned no record');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async revokeAllOwnedSessions(input) {
      try {
        const result = await query(REVOKE_ALL_OWNED_SESSIONS_SQL, [
          input.tokenDigest, input.csrfTokenDigest, input.correlationId,
        ]);
        const record = result?.rows?.[0]?.revocation_record;
        if (!Number.isInteger(record?.revokedCount)) throw new Error('revoke_all_owned_browser_sessions returned no record');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async revokeRecoveredSubjectSessions(input) {
      try {
        const result = await query(REVOKE_RECOVERED_SUBJECT_SESSIONS_SQL, [
          input.subjectId, input.correlationId,
        ]);
        const record = result?.rows?.[0]?.revocation_record;
        if (!record?.subjectId || !Number.isInteger(record?.revokedCount)) {
          throw new Error('revoke_browser_sessions_after_password_recovery returned no record');
        }
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async getInitialAdministratorBootstrapStatus() {
      try {
        const result = await query(GET_INITIAL_ADMINISTRATOR_BOOTSTRAP_STATUS_SQL);
        const record = result?.rows?.[0]?.bootstrap_record;
        if (!record?.state) throw new Error('get_initial_administrator_bootstrap_status returned no record');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async getSessionPreferenceCredentials(input) {
      try {
        const result = await query(GET_SESSION_PREFERENCE_CREDENTIALS_SQL, [input.tokenDigest]);
        const record = result?.rows?.[0]?.session_record;
        if (!record?.sessionId || !record?.subjectId || !record?.accessTokenCiphertext) {
          throw new Error('get_browser_session_preference_credentials returned no record');
        }
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async prepareSessionPreferenceUpdate(input) {
      try {
        const result = await query(PREPARE_SESSION_PREFERENCE_UPDATE_SQL, [
          input.tokenDigest, input.csrfTokenDigest, input.duration, input.correlationId,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record?.sessionId || !record?.subjectId || !record?.accessTokenCiphertext
            || !record?.auditEventId) {
          throw new Error('prepare_browser_session_preference_update returned no record');
        }
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async prepareOwnedPasswordRecoveryLink(input) {
      try {
        const result = await query(PREPARE_OWNED_PASSWORD_RECOVERY_LINK_SQL, [
          input.tokenDigest, input.csrfTokenDigest, input.idempotencyKey,
          input.correlationId, input.reason,
        ]);
        const record = result?.rows?.[0]?.recovery_record;
        if (!['prepared', 'duplicate'].includes(record?.state) || !record?.subjectId) {
          throw new Error('prepare_owned_password_recovery_link returned no record');
        }
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async prepareOwnedProfileAvatarAccess(input) {
      try {
        const result = await query(PREPARE_OWNED_PROFILE_AVATAR_ACCESS_SQL, [
          input.tokenDigest, input.csrfTokenDigest ?? null, input.operation, input.correlationId,
        ]);
        const record = result?.rows?.[0]?.avatar_record;
        if (!record?.sessionId || !record?.subjectId || !record?.accessTokenCiphertext
            || (['select', 'upload'].includes(input.operation) && !record?.auditEventId)) {
          throw new Error('prepare_owned_profile_avatar_access returned no record');
        }
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async claimInitialAdministrator(input) {
      try {
        const result = await query(CLAIM_INITIAL_ADMINISTRATOR_SQL, [input.subjectId, input.correlationId]);
        const record = result?.rows?.[0]?.bootstrap_record;
        if (!record?.subjectId || record?.state !== 'complete') {
          throw new Error('claim_initial_administrator returned no record');
        }
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async getRefreshCredentials(input) {
      try {
        const result = await query(GET_REFRESH_CREDENTIALS_SQL, [
          input.tokenDigest,
          input.csrfTokenDigest,
          input.requireCsrf,
        ]);
        const record = result?.rows?.[0]?.session_record;
        if (!record) throw Object.assign(new Error('refresh credentials were not found'), { detail: 'SessionInvalid' });
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async rotateCredentials(input) {
      try {
        const result = await query(ROTATE_SESSION_CREDENTIALS_SQL, [
          input.sessionId,
          input.subjectId,
          input.expectedRefreshCiphertextDigest,
          input.accessTokenCiphertext,
          input.refreshTokenCiphertext,
          input.authSessionRef,
          input.aal,
          input.accessTokenExpiresAt,
          input.correlationId,
        ]);
        const record = result?.rows?.[0]?.refresh_record;
        if (!record?.outcome) throw new Error('rotate_browser_session_credentials returned no outcome');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async rejectRefresh(input) {
      try {
        const result = await query(REJECT_SESSION_REFRESH_SQL, [
          input.sessionId,
          input.subjectId,
          input.expectedRefreshCiphertextDigest,
          input.correlationId,
        ]);
        const record = result?.rows?.[0]?.refresh_record;
        if (!record?.outcome) throw new Error('reject_browser_session_refresh returned no outcome');
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
          input.executionPlan == null ? null : JSON.stringify(input.executionPlan),
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

    async verify(input) {
      try {
        const result = await query(VERIFY_SQL, [
          input.sessionId,
          input.actorRef,
          input.expectedPermissionRevision,
          input.expectedRevokeEpoch,
          input.operationId,
          input.expectedStateVersion,
          input.idempotencyKey,
          input.correlationId,
        ]);
        const row = result?.rows?.[0];
        if (!row?.operation_record) throw new Error('verify_extension_operation returned no receipt');
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

    async listRevocations(input) {
      try {
        const result = await query(LIST_REVOCATIONS_SQL, [
          input.sessionId, input.actorRef, input.correlationId,
        ]);
        const envelope = result?.rows?.[0]?.read_envelope;
        if (!envelope) throw new Error('list_revocations returned no read envelope');
        return envelope;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async getRegistryConnection(input) {
      try {
        const result = await query(GET_REGISTRY_CONNECTION_SQL, [
          input.sessionId, input.actorRef, input.correlationId,
        ]);
        const envelope = result?.rows?.[0]?.read_envelope;
        if (!envelope) throw new Error('get_registry_connection returned no read envelope');
        return envelope;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async listAuditEvents(input) {
      try {
        const result = await query(LIST_AUDIT_EVENTS_SQL, [
          input.sessionId,
          input.actorRef,
          input.expectedPermissionRevision,
          input.expectedRevokeEpoch,
          input.cursor,
          input.limit,
          input.correlationId,
        ]);
        const envelope = result?.rows?.[0]?.read_envelope;
        if (!envelope) throw new Error('list_events returned no read envelope');
        return envelope;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async revokeSession(input) {
      try {
        const result = await query(REVOKE_SESSION_SQL, [
          input.sessionId,
          input.actorRef,
          input.expectedPermissionRevision,
          input.expectedRevokeEpoch,
          input.correlationId,
        ]);
        const record = result?.rows?.[0]?.revocation_record;
        if (!record) throw new Error('revoke_browser_session returned no revocation record');
        return record;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async getSupabaseStatus(input) {
      try {
        const result = await query(GET_SUPABASE_STATUS_SQL, [
          input.sessionId,
          input.actorRef,
          input.expectedPermissionRevision,
          input.expectedRevokeEpoch,
          input.correlationId,
        ]);
        const envelope = result?.rows?.[0]?.read_envelope;
        if (!envelope) throw new Error('get_supabase_status returned no read envelope');
        return envelope;
      } catch (error) {
        throw databaseError(error);
      }
    },
  });
}
