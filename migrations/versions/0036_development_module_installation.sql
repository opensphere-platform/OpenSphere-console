-- User-approved local HTTPS / edge / development exception, 2026-09-05.
-- No environment is enabled by this migration. Only the installation DBA may
-- record the validated local context. C_API and other runtime roles cannot write it.
-- Existing strict RPCs, true AAL and distinct-person approval are preserved.
CREATE TABLE console_operation.module_installation_environment (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 channel text NOT NULL CHECK(channel='edge'),
 auth_environment text NOT NULL CHECK(auth_environment='development'),
 kube_context text NOT NULL CHECK(kube_context='docker-desktop'),
 console_origin text NOT NULL CHECK(console_origin ~ '^https://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?$'),
 updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
REVOKE ALL ON console_operation.module_installation_environment FROM PUBLIC, console_api, console_extension_controller;
ALTER TABLE console_operation.operation ADD COLUMN local_development_module_install boolean NOT NULL DEFAULT false;
ALTER TABLE console_operation.approval ADD COLUMN local_development_module_install boolean NOT NULL DEFAULT false;
DO $guard$
DECLARE names text[];
BEGIN
 SELECT array_agg(conname) INTO names FROM pg_constraint
 WHERE conrelid='console_operation.operation'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%risk%aal%';
 IF cardinality(names) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Expected one operation risk/AAL constraint'; END IF;
 EXECUTE format('ALTER TABLE console_operation.operation DROP CONSTRAINT %I', names[1]);
END
$guard$;
ALTER TABLE console_operation.operation ADD CONSTRAINT operation_module_aal CHECK (
 risk NOT IN ('R2','R3') OR aal='aal2' OR (local_development_module_install
   AND risk='R2' AND action_id='console.extension.install' AND required_permission='console.extension.install'
   AND owner_ref='C_EXT' AND approval_required
   AND target_ref ~ '^ghcr[.]io/opensphere-platform/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$'));
ALTER TABLE console_operation.approval DROP CONSTRAINT approval_aal_check;
ALTER TABLE console_operation.approval ADD CONSTRAINT approval_module_aal CHECK (
 aal='aal2' OR (aal='aal1' AND local_development_module_install));

CREATE OR REPLACE FUNCTION console_operation.accept_development_module_install(
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
  IF NOT EXISTS (SELECT 1 FROM console_operation.module_installation_environment
      WHERE singleton AND channel='edge' AND auth_environment='development'
        AND kube_context='docker-desktop' AND console_origin ~ '^https://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?$') THEN
    RAISE EXCEPTION 'local development installation environment is not enabled'
      USING ERRCODE='42501', DETAIL='StepUpRequired';
  END IF;
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
  IF p_action_id IS DISTINCT FROM 'console.extension.install' OR p_risk IS DISTINCT FROM 'R2'
      OR p_required_permission IS DISTINCT FROM 'console.extension.install' OR p_owner_ref IS DISTINCT FROM 'C_EXT'
      OR p_approval_required IS DISTINCT FROM true
      OR p_target_ref IS NULL OR p_target_ref !~ '^ghcr[.]io/opensphere-platform/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'development exception is restricted to Cluster Manager installation'
      USING ERRCODE = '42501', DETAIL = 'PolicyRejected';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'localDevelopmentModuleInstall', true,
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
    source_revision, owner_ref, execution_plan, state, expected_postcondition, local_development_module_install
  ) VALUES (
    p_action_id, p_action_version, p_actor_ref, p_target_ref, p_required_permission,
    p_payload_digest, v_request_digest, p_risk, COALESCE(p_reason, ''), v_session.aal,
    v_authority.permission_revision, p_plan_revision, p_approval_required,
    p_idempotency_key, p_correlation_id, p_source_revision, p_owner_ref, p_execution_plan,
    CASE WHEN p_approval_required THEN 'Planned' ELSE 'Authorized' END,
    p_expected_postcondition, true
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
      'localDevelopmentModuleInstall', true,
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

CREATE OR REPLACE FUNCTION console_operation.approve_development_module_install(
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
  IF NOT EXISTS (SELECT 1 FROM console_operation.module_installation_environment
      WHERE singleton AND channel='edge' AND auth_environment='development'
        AND kube_context='docker-desktop' AND console_origin ~ '^https://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?$') THEN
    RAISE EXCEPTION 'local development installation environment is not enabled'
      USING ERRCODE='42501', DETAIL='StepUpRequired';
  END IF;
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
  SELECT * INTO v_operation FROM console_operation.operation WHERE operation_id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR NOT v_operation.local_development_module_install
      OR v_operation.action_id <> 'console.extension.install' OR v_operation.risk <> 'R2'
      OR v_operation.target_ref !~ '^ghcr[.]io/opensphere-platform/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'development approval is restricted to an admitted Cluster Manager install'
      USING ERRCODE = '42501', DETAIL = 'PolicyRejected';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'localDevelopmentModuleInstall', true,
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
    idempotency_key, correlation_id, local_development_module_install
  ) VALUES (
    v_operation.operation_id, p_actor_ref, btrim(p_reason), p_approval_revision,
    v_request_digest, v_authority.permission_revision, v_authority.revoke_epoch,
    v_session.aal, p_expected_state_version, p_idempotency_key, p_correlation_id, true
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
      'localDevelopmentModuleInstall', true,
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
REVOKE ALL ON FUNCTION console_operation.accept_development_module_install(uuid, uuid, bigint, bigint, text, text, text, text, text, text, text, text, boolean, text, text, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_operation.approve_development_module_install(uuid, uuid, bigint, bigint, uuid, bigint, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.accept_development_module_install(uuid, uuid, bigint, bigint, text, text, text, text, text, text, text, text, boolean, text, text, text, text, jsonb, jsonb) TO console_api;
GRANT EXECUTE ON FUNCTION console_operation.approve_development_module_install(uuid, uuid, bigint, bigint, uuid, bigint, text, text, text, text, text) TO console_api;
