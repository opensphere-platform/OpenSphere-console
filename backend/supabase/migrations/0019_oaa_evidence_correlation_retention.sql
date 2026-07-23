\set ON_ERROR_STOP on

-- Correlate every provider call, retrieval, and tool invocation with its
-- parent agent run without storing prompts, responses, credentials, or logs.
ALTER TABLE oaa.retrieval_trace
  ADD COLUMN IF NOT EXISTS agent_run_id uuid REFERENCES oaa.agent_run(id) ON DELETE RESTRICT;
ALTER TABLE oaa.tool_run
  ADD COLUMN IF NOT EXISTS agent_run_id uuid REFERENCES oaa.agent_run(id) ON DELETE RESTRICT;
ALTER TABLE oaa.llm_usage_event
  ADD COLUMN IF NOT EXISTS agent_run_id uuid REFERENCES oaa.agent_run(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS retrieval_trace_agent_run_idx
  ON oaa.retrieval_trace (agent_run_id, rank) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_run_agent_run_idx
  ON oaa.tool_run (agent_run_id, created_at) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS llm_usage_event_agent_run_idx
  ON oaa.llm_usage_event (agent_run_id, occurred_at) WHERE agent_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oaa.evidence_retention_policy (
  stream text PRIMARY KEY CHECK (stream IN (
    'agent_run', 'agent_step', 'tool_run', 'retrieval_trace', 'llm_usage_event', 'runtime_event'
  )),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  disposition text NOT NULL CHECK (disposition IN ('retain', 'export-before-delete')),
  legal_hold boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8)
);

CREATE TABLE IF NOT EXISTS oaa.evidence_policy_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream text NOT NULL,
  retention_days integer NOT NULL,
  disposition text NOT NULL,
  legal_hold boolean NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS oaa.evidence_export_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream text NOT NULL CHECK (stream IN (
    'agent_run', 'agent_step', 'tool_run', 'retrieval_trace', 'llm_usage_event', 'runtime_event'
  )),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  object_ref text NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  exporter text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (window_end > window_start)
);

DROP TRIGGER IF EXISTS evidence_policy_event_append_only ON oaa.evidence_policy_event;
CREATE TRIGGER evidence_policy_event_append_only
  BEFORE UPDATE OR DELETE ON oaa.evidence_policy_event
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.evidence_policy_event ENABLE ALWAYS TRIGGER evidence_policy_event_append_only;

DROP TRIGGER IF EXISTS evidence_export_receipt_append_only ON oaa.evidence_export_receipt;
CREATE TRIGGER evidence_export_receipt_append_only
  BEFORE UPDATE OR DELETE ON oaa.evidence_export_receipt
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.evidence_export_receipt ENABLE ALWAYS TRIGGER evidence_export_receipt_append_only;

INSERT INTO oaa.evidence_retention_policy
  (stream, retention_days, disposition, legal_hold, updated_by, reason)
VALUES
  ('agent_run', 365, 'retain', false, 'migration-0019', 'Initial governed evidence retention policy'),
  ('agent_step', 365, 'retain', false, 'migration-0019', 'Initial governed evidence retention policy'),
  ('tool_run', 730, 'retain', false, 'migration-0019', 'Initial governed evidence retention policy'),
  ('retrieval_trace', 730, 'retain', false, 'migration-0019', 'Initial governed evidence retention policy'),
  ('llm_usage_event', 730, 'retain', false, 'migration-0019', 'Initial governed evidence retention policy'),
  ('runtime_event', 90, 'export-before-delete', false, 'migration-0019', 'Initial governed evidence retention policy')
ON CONFLICT (stream) DO NOTHING;

CREATE OR REPLACE FUNCTION oaa.set_evidence_retention_policy(
  p_stream text,
  p_retention_days integer,
  p_disposition text,
  p_legal_hold boolean,
  p_actor_id text,
  p_reason text
) RETURNS oaa.evidence_retention_policy
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oaa
AS $$
DECLARE
  result oaa.evidence_retention_policy;
BEGIN
  IF p_stream IS NULL OR p_stream NOT IN (
    'agent_run', 'agent_step', 'tool_run', 'retrieval_trace', 'llm_usage_event', 'runtime_event'
  ) THEN RAISE EXCEPTION 'unsupported evidence stream'; END IF;
  IF p_retention_days IS NULL OR p_retention_days < 30 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'retention days must be between 30 and 3650';
  END IF;
  IF p_disposition IS NULL OR p_disposition NOT IN ('retain', 'export-before-delete') THEN
    RAISE EXCEPTION 'unsupported evidence disposition';
  END IF;
  IF length(btrim(coalesce(p_actor_id, ''))) < 1 THEN RAISE EXCEPTION 'actor id is required'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 8 THEN RAISE EXCEPTION 'management reason must be at least 8 characters'; END IF;

  INSERT INTO oaa.evidence_retention_policy AS policy
    (stream, retention_days, disposition, legal_hold, updated_at, updated_by, reason)
  VALUES
    (p_stream, p_retention_days, p_disposition, coalesce(p_legal_hold, false),
     clock_timestamp(), btrim(p_actor_id), btrim(p_reason))
  ON CONFLICT (stream) DO UPDATE SET
    retention_days = EXCLUDED.retention_days,
    disposition = EXCLUDED.disposition,
    legal_hold = EXCLUDED.legal_hold,
    updated_at = EXCLUDED.updated_at,
    updated_by = EXCLUDED.updated_by,
    reason = EXCLUDED.reason
  RETURNING policy.* INTO result;

  INSERT INTO oaa.evidence_policy_event
    (stream, retention_days, disposition, legal_hold, actor_id, reason)
  VALUES
    (result.stream, result.retention_days, result.disposition, result.legal_hold,
     btrim(p_actor_id), btrim(p_reason));
  RETURN result;
END;
$$;

CREATE OR REPLACE VIEW oaa.evidence_retention_status AS
WITH evidence(stream, occurred_at) AS (
  SELECT 'agent_run', started_at FROM oaa.agent_run
  UNION ALL SELECT 'agent_step', occurred_at FROM oaa.agent_step
  UNION ALL SELECT 'tool_run', created_at FROM oaa.tool_run
  UNION ALL SELECT 'retrieval_trace', created_at FROM oaa.retrieval_trace
  UNION ALL SELECT 'llm_usage_event', occurred_at FROM oaa.llm_usage_event
  UNION ALL SELECT 'runtime_event', observed_at FROM oaa.runtime_event
)
SELECT
  policy.stream,
  policy.retention_days,
  policy.disposition,
  policy.legal_hold,
  policy.updated_at,
  policy.updated_by,
  policy.reason,
  count(evidence.occurred_at)::bigint AS row_count,
  min(evidence.occurred_at) AS oldest_at,
  count(evidence.occurred_at) FILTER (
    WHERE NOT policy.legal_hold
      AND policy.disposition = 'export-before-delete'
      AND evidence.occurred_at < clock_timestamp() - (policy.retention_days * interval '1 day')
  )::bigint AS due_rows,
  count(evidence.occurred_at) FILTER (
    WHERE NOT policy.legal_hold
      AND policy.disposition = 'export-before-delete'
      AND evidence.occurred_at < clock_timestamp() - (policy.retention_days * interval '1 day')
      AND EXISTS (
        SELECT 1 FROM oaa.evidence_export_receipt receipt
        WHERE receipt.stream = policy.stream
          AND evidence.occurred_at >= receipt.window_start
          AND evidence.occurred_at < receipt.window_end
      )
  )::bigint AS export_covered_rows,
  (SELECT max(receipt.completed_at) FROM oaa.evidence_export_receipt receipt
   WHERE receipt.stream = policy.stream) AS last_export_at
FROM oaa.evidence_retention_policy policy
LEFT JOIN evidence ON evidence.stream = policy.stream
GROUP BY policy.stream, policy.retention_days, policy.disposition, policy.legal_hold,
         policy.updated_at, policy.updated_by, policy.reason;

ALTER TABLE oaa.evidence_retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.evidence_policy_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.evidence_export_receipt ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oaa_gateway_evidence_retention_read ON oaa.evidence_retention_policy;
CREATE POLICY oaa_gateway_evidence_retention_read ON oaa.evidence_retention_policy
  FOR SELECT TO opensphere_oaa_gateway USING (true);
DROP POLICY IF EXISTS oaa_gateway_evidence_policy_event_read ON oaa.evidence_policy_event;
CREATE POLICY oaa_gateway_evidence_policy_event_read ON oaa.evidence_policy_event
  FOR SELECT TO opensphere_oaa_gateway USING (true);
DROP POLICY IF EXISTS oaa_gateway_evidence_export_receipt_read ON oaa.evidence_export_receipt;
CREATE POLICY oaa_gateway_evidence_export_receipt_read ON oaa.evidence_export_receipt
  FOR SELECT TO opensphere_oaa_gateway USING (true);

REVOKE ALL ON oaa.evidence_retention_policy, oaa.evidence_policy_event, oaa.evidence_export_receipt
  FROM PUBLIC, anon, authenticated, opensphere_oaa_gateway;
GRANT SELECT ON oaa.evidence_retention_policy, oaa.evidence_policy_event, oaa.evidence_export_receipt
  TO opensphere_oaa_gateway;
GRANT SELECT ON oaa.evidence_retention_status TO opensphere_oaa_gateway;
REVOKE ALL ON FUNCTION oaa.set_evidence_retention_policy(text, integer, text, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION oaa.set_evidence_retention_policy(text, integer, text, boolean, text, text)
  TO opensphere_oaa_gateway;

INSERT INTO console.permission (code, risk_level) VALUES
  ('oaa.evidence.read', 'medium'),
  ('oaa.evidence.manage', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT role.id, permission.id
FROM console.role role
JOIN console.permission permission ON permission.code IN ('oaa.evidence.read', 'oaa.evidence.manage')
WHERE role.code = 'console-admins'
ON CONFLICT DO NOTHING;

COMMENT ON VIEW oaa.evidence_retention_status IS
  'PII-minimized evidence counts and export coverage. No purge API is exposed; deletion requires a reviewed owner maintenance workflow and export receipt.';
COMMENT ON COLUMN oaa.retrieval_trace.agent_run_id IS 'Parent agent run correlation only; no prompt content is stored.';
COMMENT ON COLUMN oaa.tool_run.agent_run_id IS 'Parent agent run correlation only; tool input/output remain digest-only.';
COMMENT ON COLUMN oaa.llm_usage_event.agent_run_id IS 'Parent agent run correlation for each provider request.';
