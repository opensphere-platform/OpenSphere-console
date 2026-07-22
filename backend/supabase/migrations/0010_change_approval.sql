\set ON_ERROR_STOP on

-- A Gitea review is performed by a non-human adapter identity, but the
-- approving person remains a Supabase Console operator.  Persist both facts
-- so a bot review can never be mistaken for a self-approved human change.
CREATE TABLE IF NOT EXISTS console.change_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES console.change_request(request_id) ON DELETE CASCADE,
  approver_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  status text NOT NULL DEFAULT 'intent' CHECK (status IN ('intent', 'applied', 'failed')),
  gitea_review_id bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  error_code text,
  UNIQUE (request_id, approver_id)
);
CREATE INDEX IF NOT EXISTS change_approval_request_idx ON console.change_approval (request_id, created_at DESC);

ALTER TABLE console.change_approval ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS console_backend_change_approval ON console.change_approval;
CREATE POLICY console_backend_change_approval ON console.change_approval FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON console.change_approval TO opensphere_console_backend;

CREATE OR REPLACE FUNCTION console.begin_change_approval(
  p_request_id uuid,
  p_approver_id uuid,
  p_reason text
) RETURNS console.change_approval
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE
  change_row console.change_request;
  approval console.change_approval;
  event_digest text;
BEGIN
  IF length(btrim(p_reason)) < 8 THEN RAISE EXCEPTION 'approval reason is required'; END IF;
  SELECT * INTO change_row FROM console.change_request WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR change_row.status <> 'authorized' THEN RAISE EXCEPTION 'change request is not awaiting approval'; END IF;
  IF change_row.actor_id = p_approver_id THEN RAISE EXCEPTION 'change creator cannot approve their own request'; END IF;
  INSERT INTO console.change_approval (request_id, approver_id, reason, status)
  VALUES (p_request_id, p_approver_id, btrim(p_reason), 'intent')
  ON CONFLICT (request_id, approver_id) DO UPDATE SET reason = EXCLUDED.reason
  RETURNING * INTO approval;
  event_digest := encode(digest(concat_ws('|', p_request_id::text, p_approver_id::text, btrim(p_reason), 'approval-intent'), 'sha256'), 'hex');
  INSERT INTO audit.event (request_id, correlation_id, actor_type, actor_id, action, target_type, target_id, reason, phase, result, event_hash)
  VALUES (p_request_id, p_request_id::text, 'human', p_approver_id, 'change-approval', 'declarative-change', change_row.target, btrim(p_reason), 'authorized', 'approval-intent', event_digest)
  ON CONFLICT (request_id, phase, event_hash) DO NOTHING;
  RETURN approval;
END;
$$;

CREATE OR REPLACE FUNCTION console.record_change_approval_result(
  p_request_id uuid,
  p_approver_id uuid,
  p_succeeded boolean,
  p_gitea_review_id bigint DEFAULT NULL,
  p_error_code text DEFAULT NULL
) RETURNS console.change_approval
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console
AS $$
DECLARE approval console.change_approval;
BEGIN
  UPDATE console.change_approval SET
    status = CASE WHEN p_succeeded THEN 'applied' ELSE 'failed' END,
    gitea_review_id = p_gitea_review_id,
    error_code = CASE WHEN p_succeeded THEN NULL ELSE nullif(btrim(p_error_code), '') END,
    completed_at = clock_timestamp()
  WHERE request_id = p_request_id AND approver_id = p_approver_id
  RETURNING * INTO approval;
  IF approval.id IS NULL THEN RAISE EXCEPTION 'approval intent is absent'; END IF;
  RETURN approval;
END;
$$;

REVOKE ALL ON FUNCTION console.begin_change_approval(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.record_change_approval_result(uuid, uuid, boolean, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console.begin_change_approval(uuid, uuid, text) TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.record_change_approval_result(uuid, uuid, boolean, bigint, text) TO opensphere_console_backend;
