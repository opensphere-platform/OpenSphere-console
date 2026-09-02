CREATE OR REPLACE FUNCTION console_operation.record_gitea_proposal(
  p_operation_id uuid,
  p_desired_revision text,
  p_branch text,
  p_pull_number integer,
  p_correlation_id text
)
RETURNS TABLE(proposal_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_audit
AS $$
DECLARE
  v_operation console_operation.operation;
  v_evidence jsonb;
  v_existing jsonb;
BEGIN
  IF p_operation_id IS NULL
      OR COALESCE(p_desired_revision, '') !~ '^[0-9a-f]{40,64}$'
      OR p_branch <> 'control/' || p_operation_id::text
      OR p_pull_number < 1
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'invalid Gitea proposal receipt'
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
      OR v_operation.execution_plan->>'authority' <> 'Gitea'
      OR v_operation.execution_plan->>'repository' <> 'opensphere/platform-declarations'
      OR v_operation.execution_plan->>'defaultBranch' <> 'main'
      OR v_operation.state NOT IN ('Planned', 'Authorized', 'Submitted') THEN
    RAISE EXCEPTION 'operation is outside the Gitea proposal receipt boundary'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  v_evidence := jsonb_build_object(
    'repository', v_operation.execution_plan->>'repository',
    'branch', p_branch,
    'pullNumber', p_pull_number,
    'desiredRevision', p_desired_revision
  );
  SELECT evidence INTO v_existing
    FROM console_audit.event
   WHERE operation_id = p_operation_id
     AND action = 'console.platform.change.proposal'
   ORDER BY sequence_id DESC
   LIMIT 1;
  IF FOUND THEN
    IF v_existing = v_evidence THEN
      RETURN QUERY SELECT v_existing, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'conflicting Gitea proposal receipt'
      USING ERRCODE = '55000', DETAIL = 'ReceiptConflict';
  END IF;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    p_correlation_id,
    'API_GIT',
    'console.platform.change.proposal',
    v_operation.target_ref,
    'succeeded',
    '',
    v_evidence
  );

  RETURN QUERY SELECT v_evidence, false;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.record_gitea_proposal(uuid, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.record_gitea_proposal(uuid, text, text, integer, text) TO console_api;

COMMENT ON FUNCTION console_operation.record_gitea_proposal(uuid, text, text, integer, text)
  IS 'Records one immutable Gitea pull-request coordinate set for an existing durable Console operation without creating another authority store.';
