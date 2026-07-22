\set ON_ERROR_STOP on

-- Platform Control Plane V2 governed-change projection.
-- Supabase stores audit, idempotency and Console read models. Gitea owns the
-- reviewed declaration; Kubernetes owns the observed runtime result.

CREATE TABLE IF NOT EXISTS console.consumer_contract (
  consumer_id text PRIMARY KEY CHECK (consumer_id ~ '^[a-z][a-z0-9._-]{1,127}$'),
  display_name text NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('console-native', 'oaa', 'subshell', 'extension')),
  supabase_schemas text[] NOT NULL DEFAULT '{}',
  storage_buckets text[] NOT NULL DEFAULT '{}',
  gitea_repository text,
  gitea_path text,
  reconciler text,
  observability_claim text,
  desired_revision text,
  applied_revision text,
  status text NOT NULL DEFAULT 'Unknown' CHECK (status IN ('Ready', 'Degraded', 'NotReady', 'Unknown')),
  last_observed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS console.observability_claim (
  consumer_id text PRIMARY KEY REFERENCES console.consumer_contract(consumer_id) ON DELETE CASCADE,
  requested_capabilities text[] NOT NULL DEFAULT '{}',
  binding_name text,
  binding_namespace text,
  phase text NOT NULL DEFAULT 'NotConfigured'
    CHECK (phase IN ('NotConfigured', 'Requested', 'Pending', 'Connected', 'Degraded', 'Stale', 'Lost', 'Denied', 'Incompatible')),
  observed_at timestamptz,
  freshness_seconds integer CHECK (freshness_seconds IS NULL OR freshness_seconds >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS console.change_execution (
  request_id uuid PRIMARY KEY REFERENCES console.change_request(request_id) ON DELETE CASCADE,
  branch text NOT NULL,
  pull_number integer,
  pull_url text,
  desired_revision text,
  merge_revision text,
  reconciler text,
  reconciler_status text NOT NULL DEFAULT 'NotScheduled'
    CHECK (reconciler_status IN ('NotScheduled', 'Queued', 'Reconciling', 'Applied', 'Failed', 'Unknown', 'Drifted')),
  drift_status text NOT NULL DEFAULT 'Unknown'
    CHECK (drift_status IN ('InSync', 'Drifted', 'Unknown')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS console.change_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES console.change_request(request_id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'gitea-merged' CHECK (kind IN ('gitea-merged', 'reconcile-retry', 'rollback')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dispatching', 'completed', 'failed', 'dead-letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS change_outbox_ready_idx ON console.change_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS console.gitea_webhook_receipt (
  delivery_id text PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 255),
  event_type text NOT NULL,
  repository text,
  request_id uuid REFERENCES console.change_request(request_id) ON DELETE SET NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  signature_valid boolean NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('accepted', 'duplicate', 'rejected', 'ignored', 'failed')),
  error_code text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS gitea_webhook_request_idx ON console.gitea_webhook_receipt (request_id, received_at DESC);

CREATE TABLE IF NOT EXISTS console.reconcile_receipt (
  operation_id text PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 255),
  request_id uuid NOT NULL REFERENCES console.change_request(request_id) ON DELETE CASCADE,
  reconciler text NOT NULL,
  desired_revision text,
  applied_revision text,
  observed_generation bigint,
  succeeded boolean NOT NULL,
  result text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE console.consumer_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.observability_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.change_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.change_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.gitea_webhook_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.reconcile_receipt ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS console_backend_consumer_contract ON console.consumer_contract;
CREATE POLICY console_backend_consumer_contract ON console.consumer_contract FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_observability_claim ON console.observability_claim;
CREATE POLICY console_backend_observability_claim ON console.observability_claim FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_change_execution ON console.change_execution;
CREATE POLICY console_backend_change_execution ON console.change_execution FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_change_outbox ON console.change_outbox;
CREATE POLICY console_backend_change_outbox ON console.change_outbox FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_gitea_webhook_receipt ON console.gitea_webhook_receipt;
CREATE POLICY console_backend_gitea_webhook_receipt ON console.gitea_webhook_receipt FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_reconcile_receipt ON console.reconcile_receipt;
CREATE POLICY console_backend_reconcile_receipt ON console.reconcile_receipt FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON console.consumer_contract, console.observability_claim,
  console.change_execution, console.change_outbox, console.gitea_webhook_receipt,
  console.reconcile_receipt TO opensphere_console_backend;

CREATE OR REPLACE FUNCTION console.record_change_proposal(
  p_request_id uuid,
  p_git_repo text,
  p_git_ref text,
  p_branch text,
  p_pull_number integer,
  p_pull_url text,
  p_desired_revision text
) RETURNS console.change_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE changed console.change_request; event_digest text;
BEGIN
  IF length(btrim(p_git_repo)) < 3 OR length(btrim(p_git_ref)) < 1 OR length(btrim(p_branch)) < 1 THEN
    RAISE EXCEPTION 'Gitea proposal reference is required';
  END IF;
  UPDATE console.change_request SET status = 'authorized', git_repo = btrim(p_git_repo), git_ref = btrim(p_git_ref)
  WHERE request_id = p_request_id AND status = 'intent' RETURNING * INTO changed;
  IF changed.id IS NULL THEN RAISE EXCEPTION 'change request is absent or not authorizable'; END IF;
  INSERT INTO console.change_execution (request_id, branch, pull_number, pull_url, desired_revision, reconciler_status)
  VALUES (p_request_id, btrim(p_branch), p_pull_number, nullif(btrim(p_pull_url), ''), nullif(btrim(p_desired_revision), ''), 'NotScheduled')
  ON CONFLICT (request_id) DO NOTHING;
  event_digest := encode(digest(concat_ws('|', p_request_id::text, p_git_repo, p_git_ref, p_branch, coalesce(p_pull_number::text, ''), 'authorized'), 'sha256'), 'hex');
  INSERT INTO audit.event (request_id, correlation_id, actor_type, actor_id, action, target_type, target_id, reason, phase, result, event_hash)
  VALUES (p_request_id, p_request_id::text, changed.actor_type, changed.actor_id, changed.action, 'declarative-change', changed.target, changed.reason, 'authorized', 'gitea-pr-open', event_digest)
  ON CONFLICT (request_id, phase, event_hash) DO NOTHING;
  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION console.record_change_failure(
  p_request_id uuid, p_result text, p_error text DEFAULT NULL
) RETURNS console.change_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE changed console.change_request; event_digest text;
BEGIN
  UPDATE console.change_request SET status = 'failed', completed_at = clock_timestamp()
  WHERE request_id = p_request_id AND status IN ('intent', 'authorized', 'committed', 'unknown') RETURNING * INTO changed;
  IF changed.id IS NULL THEN RAISE EXCEPTION 'change request is absent or terminal'; END IF;
  UPDATE console.change_execution SET reconciler_status = 'Failed', last_error = nullif(btrim(p_error), ''), updated_at = clock_timestamp() WHERE request_id = p_request_id;
  event_digest := encode(digest(concat_ws('|', p_request_id::text, p_result, coalesce(p_error, ''), 'failed'), 'sha256'), 'hex');
  INSERT INTO audit.event (request_id, correlation_id, actor_type, actor_id, action, target_type, target_id, reason, phase, result, event_hash)
  VALUES (p_request_id, p_request_id::text, changed.actor_type, changed.actor_id, changed.action, 'declarative-change', changed.target, changed.reason, 'failed', left(coalesce(p_result, 'failed'), 200), event_digest)
  ON CONFLICT (request_id, phase, event_hash) DO NOTHING;
  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION console.queue_change_reconcile(p_request_id uuid, p_reconciler text)
RETURNS console.change_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console
AS $$
DECLARE queued console.change_outbox;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM console.change_request WHERE request_id = p_request_id AND status = 'committed') THEN
    RAISE EXCEPTION 'only committed changes can be reconciled';
  END IF;
  INSERT INTO console.change_outbox (request_id, kind, status) VALUES (p_request_id, 'gitea-merged', 'queued')
  ON CONFLICT (request_id) DO UPDATE SET updated_at = clock_timestamp() RETURNING * INTO queued;
  UPDATE console.change_execution SET reconciler = nullif(btrim(p_reconciler), ''), reconciler_status = 'Queued', updated_at = clock_timestamp() WHERE request_id = p_request_id;
  RETURN queued;
END;
$$;

CREATE OR REPLACE FUNCTION console.record_reconcile_result(
  p_request_id uuid, p_operation_id text, p_succeeded boolean, p_result text
) RETURNS console.change_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE changed console.change_request; target_phase text := CASE WHEN p_succeeded THEN 'applied' ELSE 'failed' END; event_digest text;
BEGIN
  UPDATE console.change_request SET status = target_phase, k8s_operation_id = p_operation_id, completed_at = clock_timestamp()
  WHERE request_id = p_request_id AND status IN ('committed', 'unknown') RETURNING * INTO changed;
  IF changed.id IS NULL THEN RAISE EXCEPTION 'change request is absent or not reconcilable'; END IF;
  UPDATE console.change_outbox SET status = CASE WHEN p_succeeded THEN 'completed' ELSE 'failed' END, updated_at = clock_timestamp(), last_error = CASE WHEN p_succeeded THEN NULL ELSE left(p_result, 2000) END WHERE request_id = p_request_id;
  UPDATE console.change_execution SET reconciler_status = CASE WHEN p_succeeded THEN 'Applied' ELSE 'Failed' END, drift_status = CASE WHEN p_succeeded THEN 'InSync' ELSE 'Unknown' END, updated_at = clock_timestamp(), last_error = CASE WHEN p_succeeded THEN NULL ELSE left(p_result, 2000) END WHERE request_id = p_request_id;
  event_digest := encode(digest(concat_ws('|', p_request_id::text, p_operation_id, target_phase, p_result), 'sha256'), 'hex');
  INSERT INTO audit.event (request_id, correlation_id, actor_type, actor_id, action, target_type, target_id, reason, phase, result, git_commit_sha, k8s_operation_id, event_hash)
  VALUES (p_request_id, p_request_id::text, changed.actor_type, changed.actor_id, changed.action, 'declarative-change', changed.target, changed.reason, target_phase, p_result, changed.git_commit_sha, p_operation_id, event_digest)
  ON CONFLICT (request_id, phase, event_hash) DO NOTHING;
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION console.record_change_proposal(uuid, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.record_change_failure(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.queue_change_reconcile(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.record_reconcile_result(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console.record_change_proposal(uuid, text, text, text, integer, text, text) TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.record_change_failure(uuid, text, text) TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.queue_change_reconcile(uuid, text) TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.record_reconcile_result(uuid, text, boolean, text) TO opensphere_console_backend;

INSERT INTO console.consumer_contract (consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets, gitea_repository, gitea_path, reconciler, observability_claim, status, metadata) VALUES
  ('manual', 'Console Manual Registry', 'console-native', ARRAY['oaa'], ARRAY['operation-artifacts'], 'opensphere/platform-declarations', 'manual/', 'manual-ingest', 'console-manual', 'Unknown', '{"authority":"Supabase OAA knowledge + Gitea source revision"}'::jsonb),
  ('oaa-gateway', 'OAA Gateway', 'oaa', ARRAY['oaa','audit'], ARRAY['operation-artifacts'], 'opensphere/platform-declarations', 'oaa/', 'oaa-governed-adapter', 'console-oaa', 'Unknown', '{"authority":"Supabase OAA data + governed Gitea actions"}'::jsonb),
  ('extensions', 'Extensions', 'extension', ARRAY['console','audit'], ARRAY['plugin-bundles'], 'opensphere/platform-declarations', 'extensions/', 'dupa-extension-reconciler', 'console-extensions', 'Unknown', '{"authority":"Supabase audit + Gitea desired state + DUPA observed runtime"}'::jsonb),
  ('subshell', 'subShell Integrations', 'subshell', ARRAY['console','audit'], ARRAY['console-uploads','operation-artifacts'], 'opensphere/platform-declarations', 'subshell/', 'subshell-reconciler', 'console-subshell', 'Unknown', '{"authority":"Consumer contract projection; no independent identity authority"}'::jsonb)
ON CONFLICT (consumer_id) DO UPDATE SET display_name = EXCLUDED.display_name, owner_kind = EXCLUDED.owner_kind, supabase_schemas = EXCLUDED.supabase_schemas, storage_buckets = EXCLUDED.storage_buckets, gitea_repository = EXCLUDED.gitea_repository, gitea_path = EXCLUDED.gitea_path, reconciler = EXCLUDED.reconciler, observability_claim = EXCLUDED.observability_claim, metadata = EXCLUDED.metadata, updated_at = clock_timestamp();

INSERT INTO console.observability_claim (consumer_id, requested_capabilities)
SELECT consumer_id, ARRAY['metrics','logs','traces'] FROM console.consumer_contract
ON CONFLICT (consumer_id) DO NOTHING;
