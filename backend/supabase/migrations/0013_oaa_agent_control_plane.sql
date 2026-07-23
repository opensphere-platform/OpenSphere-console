\set ON_ERROR_STOP on

-- OAA agent execution evidence, continuously refreshed runtime projection,
-- append-only evidence hardening, and the transactional reconciler outbox claim.

CREATE TABLE IF NOT EXISTS oaa.runtime_resource (
  source text NOT NULL,
  kind text NOT NULL,
  namespace text NOT NULL DEFAULT '',
  name text NOT NULL,
  resource_version text,
  health text NOT NULL DEFAULT 'Unknown'
    CHECK (health IN ('Ready', 'Degraded', 'NotReady', 'Unknown')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source, kind, namespace, name),
  CHECK (expires_at > observed_at)
);
CREATE INDEX IF NOT EXISTS runtime_resource_freshness_idx
  ON oaa.runtime_resource (expires_at, kind, namespace);

CREATE TABLE IF NOT EXISTS oaa.agent_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL,
  actor_label text NOT NULL,
  session_digest text CHECK (session_digest IS NULL OR session_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  error_code text
);
CREATE INDEX IF NOT EXISTS agent_run_started_idx ON oaa.agent_run (started_at DESC);

CREATE TABLE IF NOT EXISTS oaa.agent_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES oaa.agent_run(id) ON DELETE RESTRICT,
  step_index integer NOT NULL CHECK (step_index >= 0),
  step_kind text NOT NULL CHECK (step_kind IN ('retrieval', 'llm', 'tool')),
  tool_id text,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'blocked')),
  input_digest text CHECK (input_digest IS NULL OR input_digest ~ '^sha256:[0-9a-f]{64}$'),
  output_digest text CHECK (output_digest IS NULL OR output_digest ~ '^sha256:[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, step_index)
);

CREATE OR REPLACE FUNCTION oaa.reject_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OAA evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS retrieval_trace_append_only ON oaa.retrieval_trace;
CREATE TRIGGER retrieval_trace_append_only BEFORE UPDATE OR DELETE ON oaa.retrieval_trace
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.retrieval_trace ENABLE ALWAYS TRIGGER retrieval_trace_append_only;
DROP TRIGGER IF EXISTS tool_run_append_only ON oaa.tool_run;
CREATE TRIGGER tool_run_append_only BEFORE UPDATE OR DELETE ON oaa.tool_run
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.tool_run ENABLE ALWAYS TRIGGER tool_run_append_only;
DROP TRIGGER IF EXISTS agent_step_append_only ON oaa.agent_step;
CREATE TRIGGER agent_step_append_only BEFORE UPDATE OR DELETE ON oaa.agent_step
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.agent_step ENABLE ALWAYS TRIGGER agent_step_append_only;

ALTER TABLE oaa.runtime_resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.agent_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.agent_step ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oaa_gateway_retrieval_trace ON oaa.retrieval_trace;
DROP POLICY IF EXISTS oaa_gateway_retrieval_trace_read ON oaa.retrieval_trace;
DROP POLICY IF EXISTS oaa_gateway_retrieval_trace_insert ON oaa.retrieval_trace;
CREATE POLICY oaa_gateway_retrieval_trace_read ON oaa.retrieval_trace
  FOR SELECT TO opensphere_oaa_gateway USING (true);
CREATE POLICY oaa_gateway_retrieval_trace_insert ON oaa.retrieval_trace
  FOR INSERT TO opensphere_oaa_gateway WITH CHECK (true);

DROP POLICY IF EXISTS oaa_gateway_tool_run ON oaa.tool_run;
DROP POLICY IF EXISTS oaa_gateway_tool_run_read ON oaa.tool_run;
DROP POLICY IF EXISTS oaa_gateway_tool_run_insert ON oaa.tool_run;
CREATE POLICY oaa_gateway_tool_run_read ON oaa.tool_run
  FOR SELECT TO opensphere_oaa_gateway USING (true);
CREATE POLICY oaa_gateway_tool_run_insert ON oaa.tool_run
  FOR INSERT TO opensphere_oaa_gateway WITH CHECK (true);

DROP POLICY IF EXISTS oaa_gateway_runtime_resource ON oaa.runtime_resource;
CREATE POLICY oaa_gateway_runtime_resource ON oaa.runtime_resource
  FOR ALL TO opensphere_oaa_gateway USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS oaa_gateway_agent_run ON oaa.agent_run;
CREATE POLICY oaa_gateway_agent_run ON oaa.agent_run
  FOR ALL TO opensphere_oaa_gateway USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS oaa_gateway_agent_step_read ON oaa.agent_step;
DROP POLICY IF EXISTS oaa_gateway_agent_step_insert ON oaa.agent_step;
CREATE POLICY oaa_gateway_agent_step_read ON oaa.agent_step
  FOR SELECT TO opensphere_oaa_gateway USING (true);
CREATE POLICY oaa_gateway_agent_step_insert ON oaa.agent_step
  FOR INSERT TO opensphere_oaa_gateway WITH CHECK (true);

REVOKE UPDATE, DELETE, TRUNCATE ON oaa.retrieval_trace, oaa.tool_run, oaa.agent_step
  FROM opensphere_oaa_gateway;
GRANT SELECT, INSERT ON oaa.retrieval_trace, oaa.tool_run, oaa.agent_step
  TO opensphere_oaa_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON oaa.runtime_resource TO opensphere_oaa_gateway;
GRANT SELECT, INSERT, UPDATE ON oaa.agent_run TO opensphere_oaa_gateway;

CREATE OR REPLACE FUNCTION console.claim_change_reconcile(
  p_reconciler text,
  p_limit integer DEFAULT 1
) RETURNS TABLE (
  outbox_id uuid,
  request_id uuid,
  outbox_kind text,
  attempt integer,
  action text,
  target text,
  reason text,
  git_repo text,
  git_ref text,
  git_commit_sha text,
  desired_revision text,
  merge_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console
AS $$
BEGIN
  IF length(btrim(coalesce(p_reconciler, ''))) < 3 THEN
    RAISE EXCEPTION 'reconciler name is required';
  END IF;

  UPDATE console.change_outbox o
  SET status = 'dead-letter', last_error = 'reconciler lease exhausted', updated_at = clock_timestamp()
  FROM console.change_execution e
  WHERE e.request_id = o.request_id
    AND e.reconciler = btrim(p_reconciler)
    AND o.status = 'dispatching'
    AND o.locked_at < clock_timestamp() - interval '5 minutes'
    AND o.attempts >= 8;

  RETURN QUERY
  WITH candidate AS (
    SELECT o.id
    FROM console.change_outbox o
    JOIN console.change_execution e ON e.request_id = o.request_id
    JOIN console.change_request c ON c.request_id = o.request_id
    WHERE e.reconciler = btrim(p_reconciler)
      AND c.status = 'committed'
      AND o.attempts < 8
      AND (
        (o.status = 'queued' AND o.next_attempt_at <= clock_timestamp())
        OR (o.status = 'dispatching' AND o.locked_at < clock_timestamp() - interval '5 minutes')
      )
    ORDER BY o.created_at
    FOR UPDATE OF o SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 1), 10))
  ), claimed AS (
    UPDATE console.change_outbox o
    SET status = 'dispatching', attempts = o.attempts + 1,
        locked_at = clock_timestamp(), updated_at = clock_timestamp(), last_error = NULL
    FROM candidate c
    WHERE o.id = c.id
    RETURNING o.id, o.request_id, o.kind, o.attempts
  ), execution_update AS (
    UPDATE console.change_execution e
    SET reconciler_status = 'Reconciling', attempt_count = e.attempt_count + 1,
        updated_at = clock_timestamp(), last_error = NULL
    FROM claimed c
    WHERE e.request_id = c.request_id
    RETURNING e.request_id, e.desired_revision, e.merge_revision
  )
  SELECT c.id, c.request_id, c.kind, c.attempts,
         r.action, r.target, r.reason, r.git_repo, r.git_ref, r.git_commit_sha,
         e.desired_revision, e.merge_revision
  FROM claimed c
  JOIN console.change_request r ON r.request_id = c.request_id
  JOIN execution_update e ON e.request_id = c.request_id;
END;
$$;

REVOKE ALL ON FUNCTION console.claim_change_reconcile(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console.claim_change_reconcile(text, integer)
  TO opensphere_console_backend;

COMMENT ON TABLE oaa.runtime_resource IS
  'Expiring Supabase projection of sanitized observed runtime state; Kubernetes remains the live authority.';
COMMENT ON TABLE oaa.agent_step IS
  'Append-only digested agent/tool evidence. Prompts, responses, credentials, and raw logs are excluded.';
