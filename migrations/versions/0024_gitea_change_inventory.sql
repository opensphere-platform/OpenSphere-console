CREATE OR REPLACE FUNCTION console_operation.list_gitea_changes(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_items jsonb;
  v_observed_at timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session
   WHERE session_id = p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_observed_at THEN
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
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
     WHERE subject_id = p_actor_ref
       AND permission = 'console.git.change'
       AND grant_revision <= v_authority.permission_revision
       AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'console.git.change permission is required'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  WITH recent AS (
    SELECT operation.*
      FROM console_operation.operation
     WHERE action_id = 'console.platform.change.propose'
       AND action_version = '1.0'
       AND owner_ref = 'API_GIT'
     ORDER BY created_at DESC, operation_id DESC
     LIMIT 100
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'operationId', recent.operation_id,
    'actorRef', recent.actor_ref,
    'action', recent.execution_plan->>'action',
    'target', recent.execution_plan->>'target',
    'reason', recent.reason,
    'repository', recent.execution_plan->>'repository',
    'state', recent.state,
    'sourceRevision', recent.source_revision,
    'errorCode', recent.error->>'code',
    'createdAt', recent.created_at,
    'updatedAt', recent.updated_at,
    'proposal', proposal.evidence,
    'approvals', COALESCE(approvals.items, '[]'::jsonb),
    'outbox', outbox.item
  ) ORDER BY recent.created_at DESC, recent.operation_id DESC), '[]'::jsonb)
    INTO v_items
    FROM recent
    LEFT JOIN LATERAL (
      SELECT event.evidence
        FROM console_audit.event
       WHERE event.operation_id = recent.operation_id
         AND event.action = 'console.platform.change.proposal'
       ORDER BY event.sequence_id DESC
       LIMIT 1
    ) proposal ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'approverId', approval.actor_ref,
        'createdAt', approval.created_at
      ) ORDER BY approval.created_at) AS items
        FROM console_operation.approval
       WHERE approval.operation_id = recent.operation_id
    ) approvals ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'eventType', pending.event_type,
        'attemptCount', pending.attempt_count,
        'claimedAt', pending.claimed_at,
        'leaseExpiresAt', pending.lease_expires_at,
        'deliveredAt', pending.delivered_at,
        'createdAt', pending.created_at
      ) AS item
        FROM console_operation.outbox pending
       WHERE pending.operation_id = recent.operation_id
       ORDER BY pending.created_at DESC, pending.outbox_id DESC
       LIMIT 1
    ) outbox ON true;

  RETURN jsonb_build_object('observedAt', v_observed_at, 'items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION console_operation.list_gitea_changes(uuid, uuid, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.list_gitea_changes(uuid, uuid, bigint, bigint) TO console_api;

COMMENT ON FUNCTION console_operation.list_gitea_changes(uuid, uuid, bigint, bigint)
  IS 'Returns a permission-gated bounded Gitea change inventory from existing operation, approval, outbox and immutable audit evidence.';
