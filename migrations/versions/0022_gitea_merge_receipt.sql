CREATE OR REPLACE FUNCTION console_operation.get_gitea_operation_for_approval(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_initiator_authority console_identity.subject_authority;
  v_operation console_operation.operation;
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session
   WHERE session_id = p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
   WHERE subject_id = p_actor_ref FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF v_session.aal <> 'aal2'
      OR v_session.last_reauthenticated_at IS NULL
      OR v_session.last_reauthenticated_at < statement_timestamp() - interval '5 minutes'
      OR v_session.last_reauthenticated_at > statement_timestamp() + interval '30 seconds'
      OR NOT EXISTS (
        SELECT 1 FROM console_identity.permission_grant
         WHERE subject_id = p_actor_ref
           AND permission = 'console.operation.approve'
           AND grant_revision <= v_authority.permission_revision
           AND revoked_at IS NULL
      ) THEN
    RAISE EXCEPTION 'recent approval authority is required'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  SELECT * INTO v_operation FROM console_operation.operation
   WHERE operation_id = p_operation_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  SELECT * INTO v_initiator_authority FROM console_identity.subject_authority
   WHERE subject_id = v_operation.actor_ref FOR SHARE;
  IF v_operation.actor_ref = p_actor_ref OR NOT FOUND
      OR v_initiator_authority.person_ref = v_authority.person_ref THEN
    RAISE EXCEPTION 'operation initiator cannot approve the same operation'
      USING ERRCODE = '42501', DETAIL = 'SelfApprovalDenied';
  END IF;
  IF v_operation.action_id <> 'console.platform.change.propose'
      OR v_operation.action_version <> '1.0'
      OR v_operation.owner_ref <> 'API_GIT'
      OR v_operation.state NOT IN ('Planned', 'Authorized', 'Submitted') THEN
    RAISE EXCEPTION 'operation is outside the Gitea approval boundary'
      USING ERRCODE = '55000', DETAIL = 'InvalidOperationState';
  END IF;
  RETURN to_jsonb(v_operation);
END;
$$;

REVOKE ALL ON FUNCTION console_operation.get_gitea_operation_for_approval(uuid, uuid, bigint, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.get_gitea_operation_for_approval(uuid, uuid, bigint, bigint, uuid) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.record_gitea_merge(
  p_operation_id uuid,
  p_source_revision text,
  p_branch text,
  p_pull_number integer,
  p_correlation_id text
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_audit
AS $$
DECLARE
  v_operation console_operation.operation;
BEGIN
  IF p_operation_id IS NULL
      OR COALESCE(p_source_revision, '') !~ '^[0-9a-f]{40,64}$'
      OR p_branch <> 'control/' || p_operation_id::text
      OR p_pull_number < 1
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'invalid Gitea merge receipt'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
   WHERE operation_id = p_operation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  IF v_operation.action_id <> 'console.platform.change.propose'
      OR v_operation.action_version <> '1.0'
      OR v_operation.owner_ref <> 'API_GIT'
      OR NOT v_operation.approval_required
      OR v_operation.approval_revision IS NULL
      OR v_operation.execution_plan->>'authority' <> 'Gitea'
      OR v_operation.execution_plan->>'repository' <> 'opensphere/platform-declarations'
      OR v_operation.execution_plan->>'defaultBranch' <> 'main' THEN
    RAISE EXCEPTION 'operation is outside the Gitea merge receipt boundary'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF v_operation.state = 'Submitted'
      AND v_operation.source_revision = p_source_revision THEN
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;
  IF v_operation.state <> 'Authorized'
      OR v_operation.source_revision IS NOT NULL THEN
    RAISE EXCEPTION 'operation is not awaiting a Gitea merge receipt'
      USING ERRCODE = '55000', DETAIL = 'InvalidOperationState';
  END IF;

  UPDATE console_operation.operation
     SET source_revision = p_source_revision,
         state = 'Submitted',
         state_version = state_version + 1,
         updated_at = statement_timestamp()
   WHERE operation_id = p_operation_id
   RETURNING * INTO v_operation;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    p_correlation_id,
    'API_GIT',
    'console.platform.change.merge',
    v_operation.target_ref,
    'succeeded',
    '',
    jsonb_build_object(
      'repository', v_operation.execution_plan->>'repository',
      'branch', p_branch,
      'pullNumber', p_pull_number,
      'sourceRevision', p_source_revision,
      'state', v_operation.state,
      'stateVersion', v_operation.state_version
    )
  );

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.record_gitea_merge(uuid, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.record_gitea_merge(uuid, text, text, integer, text) TO console_api;

COMMENT ON FUNCTION console_operation.record_gitea_merge(uuid, text, text, integer, text)
  IS 'Binds one independently approved protected Gitea merge revision to its existing durable Console operation.';
COMMENT ON FUNCTION console_operation.get_gitea_operation_for_approval(uuid, uuid, bigint, bigint, uuid)
  IS 'Returns one governed Gitea operation only to a distinct current recent-AAL2 approver for approval or safe merge resume.';
