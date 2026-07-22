\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION console.begin_change(
  p_request_id uuid,
  p_idempotency_key text,
  p_actor_type text,
  p_actor_id uuid,
  p_action text,
  p_target text,
  p_reason text,
  p_payload_digest text DEFAULT NULL
) RETURNS console.change_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE
  created console.change_request;
  hash_input text;
  event_digest text;
BEGIN
  IF length(btrim(p_reason)) < 4 THEN RAISE EXCEPTION 'management reason is required'; END IF;
  IF p_actor_type NOT IN ('human', 'service', 'break_glass') THEN RAISE EXCEPTION 'invalid actor type'; END IF;

  INSERT INTO console.change_request (
    request_id, idempotency_key, actor_type, actor_id, action, target, reason, status
  ) VALUES (
    p_request_id, p_idempotency_key, p_actor_type, p_actor_id, p_action, p_target, btrim(p_reason), 'intent'
  )
  ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING * INTO created;

  IF created.request_id <> p_request_id THEN
    RETURN created;
  END IF;

  hash_input := concat_ws('|', p_request_id::text, p_actor_type, p_actor_id::text,
    p_action, p_target, btrim(p_reason), coalesce(p_payload_digest, ''), 'intent');
  event_digest := encode(digest(hash_input, 'sha256'), 'hex');
  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action, target_type,
    target_id, reason, phase, result, payload_digest, event_hash
  ) VALUES (
    p_request_id, p_request_id::text, p_actor_type, p_actor_id, p_action, 'declarative-change',
    p_target, btrim(p_reason), 'intent', 'recorded', p_payload_digest, event_digest
  ) ON CONFLICT (request_id, phase, event_hash) DO NOTHING;
  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION console.record_change_commit(
  p_request_id uuid,
  p_git_repo text,
  p_git_ref text,
  p_git_commit_sha text
) RETURNS console.change_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE
  changed console.change_request;
  event_digest text;
BEGIN
  IF p_git_commit_sha !~ '^[0-9a-f]{40,64}$' THEN RAISE EXCEPTION 'invalid commit sha'; END IF;
  UPDATE console.change_request SET
    status = 'committed', git_repo = p_git_repo, git_ref = p_git_ref, git_commit_sha = p_git_commit_sha
  WHERE request_id = p_request_id AND status IN ('intent', 'authorized', 'unknown')
  RETURNING * INTO changed;
  IF changed.id IS NULL THEN RAISE EXCEPTION 'change request is absent or not committable'; END IF;
  event_digest := encode(digest(concat_ws('|', p_request_id::text, p_git_repo, p_git_ref, p_git_commit_sha, 'committed'), 'sha256'), 'hex');
  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action, target_type, target_id,
    reason, phase, result, git_commit_sha, event_hash
  ) VALUES (
    p_request_id, p_request_id::text, changed.actor_type, changed.actor_id, changed.action,
    'declarative-change', changed.target, changed.reason, 'committed', 'gitea-accepted', p_git_commit_sha, event_digest
  ) ON CONFLICT (request_id, phase, event_hash) DO NOTHING;
  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION console.record_reconcile_result(
  p_request_id uuid,
  p_operation_id text,
  p_succeeded boolean,
  p_result text
) RETURNS console.change_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE
  changed console.change_request;
  target_phase text := CASE WHEN p_succeeded THEN 'applied' ELSE 'failed' END;
  event_digest text;
BEGIN
  UPDATE console.change_request SET
    status = target_phase, k8s_operation_id = p_operation_id, completed_at = clock_timestamp()
  WHERE request_id = p_request_id AND status IN ('committed', 'unknown')
  RETURNING * INTO changed;
  IF changed.id IS NULL THEN RAISE EXCEPTION 'change request is absent or not reconcilable'; END IF;
  event_digest := encode(digest(concat_ws('|', p_request_id::text, p_operation_id, target_phase, p_result), 'sha256'), 'hex');
  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action, target_type, target_id,
    reason, phase, result, git_commit_sha, k8s_operation_id, event_hash
  ) VALUES (
    p_request_id, p_request_id::text, changed.actor_type, changed.actor_id, changed.action,
    'declarative-change', changed.target, changed.reason, target_phase, p_result,
    changed.git_commit_sha, p_operation_id, event_digest
  ) ON CONFLICT (request_id, phase, event_hash) DO NOTHING;
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION console.begin_change(uuid, text, text, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.record_change_commit(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.record_reconcile_result(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console.begin_change(uuid, text, text, uuid, text, text, text, text) TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.record_change_commit(uuid, text, text, text) TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.record_reconcile_result(uuid, text, boolean, text) TO opensphere_console_backend;
