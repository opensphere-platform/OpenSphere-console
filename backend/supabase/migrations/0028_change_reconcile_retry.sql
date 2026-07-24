\set ON_ERROR_STOP on

-- A failed, already-reviewed declaration may be re-enqueued only by an
-- authenticated operator action. The original request, approval, merge SHA,
-- failed receipt, and attempt counters remain intact as the audit trail.
CREATE OR REPLACE FUNCTION console.retry_change_reconcile(
  p_request_id uuid,
  p_actor_id uuid,
  p_reason text
) RETURNS console.change_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE
  change_row console.change_request;
  execution_row console.change_execution;
  queued console.change_outbox;
  event_digest text;
BEGIN
  IF length(btrim(p_reason)) < 8 THEN
    RAISE EXCEPTION 'retry reason must be at least 8 characters';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console.operator
    WHERE user_id = p_actor_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'active retry operator is required';
  END IF;

  SELECT * INTO change_row
  FROM console.change_request
  WHERE request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND OR change_row.status <> 'failed' THEN
    RAISE EXCEPTION 'only failed changes can be retried';
  END IF;

  SELECT * INTO execution_row
  FROM console.change_execution
  WHERE request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND
     OR execution_row.merge_revision IS NULL
     OR execution_row.reconciler IS NULL THEN
    RAISE EXCEPTION 'reviewed merge and assigned reconciler are required';
  END IF;

  UPDATE console.change_request
  SET status = 'committed', k8s_operation_id = NULL, completed_at = NULL
  WHERE request_id = p_request_id;

  UPDATE console.change_outbox
  SET kind = 'reconcile-retry',
      status = 'queued',
      next_attempt_at = clock_timestamp(),
      locked_at = NULL,
      last_error = NULL,
      updated_at = clock_timestamp()
  WHERE request_id = p_request_id
  RETURNING * INTO queued;
  IF queued.id IS NULL THEN
    RAISE EXCEPTION 'failed reconcile outbox is absent';
  END IF;

  UPDATE console.change_execution
  SET reconciler_status = 'Queued',
      drift_status = 'Unknown',
      last_error = NULL,
      updated_at = clock_timestamp()
  WHERE request_id = p_request_id;

  event_digest := encode(digest(concat_ws(
    '|', p_request_id::text, p_actor_id::text, btrim(p_reason),
    execution_row.merge_revision, queued.attempts::text, 'reconcile-retry'
  ), 'sha256'), 'hex');
  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action, target_type,
    target_id, reason, phase, result, git_commit_sha, event_hash
  ) VALUES (
    p_request_id, p_request_id::text, 'human', p_actor_id,
    'change-reconcile-retry', 'declarative-change', change_row.target,
    btrim(p_reason), 'committed', 'reconcile-requeued',
    execution_row.merge_revision, event_digest
  )
  ON CONFLICT (request_id, phase, event_hash) DO NOTHING;

  RETURN queued;
END;
$$;

REVOKE ALL ON FUNCTION console.retry_change_reconcile(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console.retry_change_reconcile(uuid, uuid, text)
  TO opensphere_console_backend;
