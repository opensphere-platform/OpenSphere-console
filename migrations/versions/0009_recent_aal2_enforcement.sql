CREATE OR REPLACE FUNCTION console_operation.accept_operation(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_required_permission text,
  p_action_id text,
  p_action_version text,
  p_target_ref text,
  p_payload_digest text,
  p_risk text,
  p_reason text,
  p_plan_revision text,
  p_approval_required boolean,
  p_idempotency_key text,
  p_correlation_id text,
  p_source_revision text DEFAULT NULL,
  p_owner_ref text DEFAULT NULL,
  p_expected_postcondition jsonb DEFAULT NULL,
  p_execution_plan jsonb DEFAULT NULL
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_operation console_operation.operation;
  v_request_digest text;
  v_outbox_payload jsonb;
  v_outbox_event_type text;
BEGIN
  IF p_payload_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid payload digest' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_risk NOT IN ('R0', 'R1', 'R2', 'R3') THEN
    RAISE EXCEPTION 'invalid operation risk' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_risk <> 'R0' AND length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'operation reason is required' USING ERRCODE = '22023', DETAIL = 'ReasonRequired';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = p_required_permission
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF p_risk IN ('R2', 'R3') AND (v_session.aal <> 'aal2'
      OR v_session.last_reauthenticated_at IS NULL
      OR v_session.last_reauthenticated_at < statement_timestamp() - interval '5 minutes'
      OR v_session.last_reauthenticated_at > statement_timestamp() + interval '30 seconds') THEN
    RAISE EXCEPTION 'recent aal2 is required' USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'actionId', p_action_id,
    'actionVersion', p_action_version,
    'targetRef', p_target_ref,
    'requiredPermission', p_required_permission,
    'payloadDigest', p_payload_digest,
    'risk', p_risk,
    'reason', COALESCE(p_reason, ''),
    'planRevision', p_plan_revision,
    'approvalRequired', p_approval_required,
    'sourceRevision', p_source_revision,
    'ownerRef', p_owner_ref,
    'expectedPostcondition', p_expected_postcondition,
    'executionPlan', p_execution_plan
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_ref::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE actor_ref = p_actor_ref AND idempotency_key = p_idempotency_key
    FOR UPDATE;
  IF FOUND THEN
    IF v_operation.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request'
        USING ERRCODE = '23505', DETAIL = 'IdempotencyMismatch';
    END IF;
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;

  INSERT INTO console_operation.operation(
    action_id, action_version, actor_ref, target_ref, required_permission,
    payload_digest, request_digest, risk, reason, aal, permission_revision,
    plan_revision, approval_required, idempotency_key, correlation_id,
    source_revision, owner_ref, execution_plan, state, expected_postcondition
  ) VALUES (
    p_action_id, p_action_version, p_actor_ref, p_target_ref, p_required_permission,
    p_payload_digest, v_request_digest, p_risk, COALESCE(p_reason, ''), v_session.aal,
    v_authority.permission_revision, p_plan_revision, p_approval_required,
    p_idempotency_key, p_correlation_id, p_source_revision, p_owner_ref, p_execution_plan,
    CASE WHEN p_approval_required THEN 'Planned' ELSE 'Authorized' END,
    p_expected_postcondition
  ) RETURNING * INTO v_operation;

  v_outbox_event_type := CASE
    WHEN v_operation.approval_required THEN 'OperationAwaitingApproval'
    ELSE 'OperationReadyForDispatch'
  END;
  v_outbox_payload := jsonb_build_object(
    'schemaVersion', '1.0',
    'eventType', v_outbox_event_type,
    'operationId', v_operation.operation_id,
    'actionId', v_operation.action_id,
    'actionVersion', v_operation.action_version,
    'targetRef', v_operation.target_ref,
    'payloadDigest', v_operation.payload_digest,
    'risk', v_operation.risk,
    'approvalRequired', v_operation.approval_required,
    'correlationId', v_operation.correlation_id
  );
  INSERT INTO console_operation.outbox(operation_id, event_type, payload, payload_digest)
  VALUES (v_operation.operation_id, v_outbox_event_type, v_outbox_payload, v_operation.payload_digest);

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    v_operation.actor_ref::text,
    v_operation.action_id,
    v_operation.target_ref,
    'accepted',
    v_operation.reason,
    jsonb_build_object(
      'requestDigest', v_operation.request_digest,
      'payloadDigest', v_operation.payload_digest,
      'risk', v_operation.risk,
      'aal', v_operation.aal,
      'permissionRevision', v_operation.permission_revision,
      'approvalRequired', v_operation.approval_required
    )
  );

  UPDATE console_identity.browser_session
    SET last_seen_at = statement_timestamp()
    WHERE session_id = v_session.session_id;

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.resolve_browser_session(
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_require_csrf boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_permissions text[];
  v_effective_aal text;
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF p_require_csrf AND (p_csrf_token_digest IS NULL OR v_session.csrf_token_digest <> p_csrf_token_digest) THEN
    RAISE EXCEPTION 'Console session CSRF validation failed' USING ERRCODE = '42501', DETAIL = 'CsrfRejected';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT permission ORDER BY permission), ARRAY[]::text[])
    INTO v_permissions FROM console_identity.permission_grant
    WHERE subject_id = v_session.subject_id
      AND grant_revision <= v_authority.permission_revision AND revoked_at IS NULL;
  v_effective_aal := CASE
    WHEN v_session.aal = 'aal2'
      AND v_session.last_reauthenticated_at IS NOT NULL
      AND v_session.last_reauthenticated_at >= statement_timestamp() - interval '5 minutes'
      AND v_session.last_reauthenticated_at <= statement_timestamp() + interval '30 seconds'
      THEN 'aal2'
    ELSE 'aal1'
  END;
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'expiresAt', v_session.expires_at, 'idleExpiresAt', v_session.expires_at,
    'absoluteExpiresAt', v_session.absolute_expires_at, 'persistence', v_session.persistence,
    'lastSeenAt', v_session.last_seen_at, 'accessTokenExpiresAt', v_session.access_token_expires_at,
    'lastReauthenticatedAt', v_session.last_reauthenticated_at,
    'revokedAt', v_session.revoked_at, 'authorityFresh', true,
    'permissions', to_jsonb(v_permissions), 'permissionRevision', v_authority.permission_revision,
    'revokeEpoch', v_authority.revoke_epoch, 'aal', v_effective_aal
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.resolve_browser_session(bytea, bytea, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.resolve_browser_session(bytea, bytea, boolean) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.approve_operation(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_operation_id uuid,
  p_expected_state_version bigint,
  p_reason text,
  p_approval_revision text,
  p_confirmation text,
  p_idempotency_key text,
  p_correlation_id text
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_initiator_authority console_identity.subject_authority;
  v_operation console_operation.operation;
  v_approval console_operation.approval;
  v_request_digest text;
  v_outbox_payload jsonb;
BEGIN
  IF p_expected_state_version < 0
      OR length(btrim(COALESCE(p_reason, ''))) < 3
      OR length(COALESCE(p_approval_revision, '')) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid approval request' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.operation.approve'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF v_session.aal <> 'aal2'
      OR v_session.last_reauthenticated_at IS NULL
      OR v_session.last_reauthenticated_at < statement_timestamp() - interval '5 minutes'
      OR v_session.last_reauthenticated_at > statement_timestamp() + interval '30 seconds' THEN
    RAISE EXCEPTION 'recent aal2 is required' USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'operationId', p_operation_id,
    'expectedStateVersion', p_expected_state_version,
    'reason', btrim(p_reason),
    'approvalRevision', p_approval_revision,
    'confirmation', p_confirmation
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_ref::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_approval
    FROM console_operation.approval
    WHERE actor_ref = p_actor_ref AND idempotency_key = p_idempotency_key
    FOR UPDATE;
  IF FOUND THEN
    IF v_approval.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'idempotency key was already used for a different approval'
        USING ERRCODE = '23505', DETAIL = 'IdempotencyMismatch';
    END IF;
    SELECT * INTO v_operation
      FROM console_operation.operation
      WHERE operation_id = v_approval.operation_id;
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation was not found' USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  IF v_operation.actor_ref = p_actor_ref THEN
    RAISE EXCEPTION 'operation initiator cannot approve the same operation'
      USING ERRCODE = '42501', DETAIL = 'SelfApprovalDenied';
  END IF;
  SELECT * INTO v_initiator_authority
    FROM console_identity.subject_authority
    WHERE subject_id = v_operation.actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_initiator_authority.person_ref = v_authority.person_ref THEN
    RAISE EXCEPTION 'operation initiator and approver must be different people'
      USING ERRCODE = '42501', DETAIL = 'SelfApprovalDenied';
  END IF;
  IF NOT v_operation.approval_required THEN
    RAISE EXCEPTION 'operation does not require approval' USING ERRCODE = '22023', DETAIL = 'ApprovalNotRequired';
  END IF;
  IF v_operation.approval_revision IS NOT NULL OR v_operation.plan_revision <> p_approval_revision THEN
    RAISE EXCEPTION 'approval policy revision is stale' USING ERRCODE = '40001', DETAIL = 'StaleRevision';
  END IF;
  IF v_operation.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'operation state version changed' USING ERRCODE = '40001', DETAIL = 'StaleOperationVersion';
  END IF;
  IF v_operation.state <> 'Planned' THEN
    RAISE EXCEPTION 'operation is not awaiting approval' USING ERRCODE = '55000', DETAIL = 'InvalidOperationState';
  END IF;

  INSERT INTO console_operation.approval(
    operation_id, actor_ref, reason, approval_revision, request_digest,
    permission_revision, revoke_epoch, aal, expected_state_version,
    idempotency_key, correlation_id
  ) VALUES (
    v_operation.operation_id, p_actor_ref, btrim(p_reason), p_approval_revision,
    v_request_digest, v_authority.permission_revision, v_authority.revoke_epoch,
    v_session.aal, p_expected_state_version, p_idempotency_key, p_correlation_id
  ) RETURNING * INTO v_approval;

  UPDATE console_operation.operation
    SET state = 'Authorized',
        state_version = state_version + 1,
        approval_revision = p_approval_revision,
        updated_at = statement_timestamp()
    WHERE operation_id = v_operation.operation_id
    RETURNING * INTO v_operation;

  v_outbox_payload := jsonb_build_object(
    'schemaVersion', '1.0',
    'eventType', 'OperationReadyForDispatch',
    'operationId', v_operation.operation_id,
    'approvalId', v_approval.approval_id,
    'approverRef', v_approval.actor_ref,
    'approvalRevision', v_approval.approval_revision,
    'state', v_operation.state,
    'stateVersion', v_operation.state_version,
    'correlationId', p_correlation_id
  );
  INSERT INTO console_operation.outbox(operation_id, event_type, payload, payload_digest)
  VALUES (v_operation.operation_id, 'OperationReadyForDispatch', v_outbox_payload, v_request_digest);

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    p_correlation_id,
    p_actor_ref::text,
    'console.operation.approve',
    v_operation.target_ref,
    'accepted',
    btrim(p_reason),
    jsonb_build_object(
      'approvalId', v_approval.approval_id,
      'approvalRevision', v_approval.approval_revision,
      'requestDigest', v_approval.request_digest,
      'permissionRevision', v_approval.permission_revision,
      'revokeEpoch', v_approval.revoke_epoch,
      'aal', v_approval.aal,
      'initiatorRef', v_operation.actor_ref,
      'distinctPerson', true,
      'stateVersion', v_operation.state_version
    )
  );

  UPDATE console_identity.browser_session
    SET last_seen_at = statement_timestamp()
    WHERE session_id = v_session.session_id;

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;
