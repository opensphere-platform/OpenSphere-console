-- Current OSAA Gateway serving/evidence domain, not the retired Console backend.
-- Selected used contracts: legacy 0005/0012/0013/0015/0016/0017/0019.
-- Excludes unused document/version/section/model duplication and legacy durable-operation owners.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE ROLE opensphere_osaa_gateway NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA osaa,extensions TO opensphere_osaa_gateway;
CREATE TABLE IF NOT EXISTS osaa.osaa_knowledge_documents (
  id uuid PRIMARY KEY,
  namespace text NOT NULL DEFAULT 'opensphere',
  source_type text NOT NULL,
  source_id text NOT NULL,
  title text NOT NULL,
  version text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('staged', 'active', 'superseded', 'retired', 'failed')),
  authority_tier integer NOT NULL DEFAULT 3 CHECK (authority_tier BETWEEN 0 AND 4),
  acl jsonb NOT NULL DEFAULT '{"visibility":"authenticated"}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(namespace, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS osaa.osaa_knowledge_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES osaa.osaa_knowledge_documents(id) ON DELETE CASCADE,
  document_revision text NOT NULL CHECK (document_revision ~ '^[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT true,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  embedding extensions.vector(1536) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id, document_revision, chunk_index)
);
CREATE INDEX IF NOT EXISTS osaa_knowledge_chunks_embedding_hnsw_idx ON osaa.osaa_knowledge_chunks USING hnsw (embedding extensions.vector_cosine_ops);
CREATE INDEX IF NOT EXISTS osaa_knowledge_chunks_fts_idx ON osaa.osaa_knowledge_chunks USING gin (search_vector);
CREATE INDEX IF NOT EXISTS osaa_knowledge_documents_active_idx ON osaa.osaa_knowledge_documents (namespace, status, authority_tier, updated_at DESC);

CREATE TABLE IF NOT EXISTS osaa.osaa_manual_concepts (
  id text PRIMARY KEY, namespace text NOT NULL, type text NOT NULL, name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}', summary text NOT NULL, definition text NOT NULL,
  authority_tier integer NOT NULL CHECK (authority_tier BETWEEN 0 AND 4), status text NOT NULL,
  source_ids text[] NOT NULL DEFAULT '{}', section_ids text[] NOT NULL DEFAULT '{}', tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS osaa.osaa_manual_relations (
  id text PRIMARY KEY, namespace text NOT NULL, from_id text NOT NULL, to_id text NOT NULL,
  relation text NOT NULL, confidence text NOT NULL, authority_tier integer NOT NULL CHECK (authority_tier BETWEEN 0 AND 4),
  source_id text NOT NULL, section_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS osaa.osaa_tool_capabilities (
  id text PRIMARY KEY, name text NOT NULL, version text NOT NULL, channel text NOT NULL,
  read_only boolean NOT NULL, spec jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS osaa.osaa_manual_action_bindings (
  id text PRIMARY KEY, source_id text NOT NULL, section_id text,
  tool_id text NOT NULL REFERENCES osaa.osaa_tool_capabilities(id) ON DELETE RESTRICT,
  intent text NOT NULL, risk_level text NOT NULL, confirmation text NOT NULL,
  spec jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS osaa.retrieval_trace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL, actor_id uuid NOT NULL,
  query_digest text NOT NULL CHECK (query_digest ~ '^sha256:[0-9a-f]{64}$'),
  document_id uuid REFERENCES osaa.osaa_knowledge_documents(id) ON DELETE RESTRICT,
  chunk_id uuid REFERENCES osaa.osaa_knowledge_chunks(id) ON DELETE RESTRICT,
  document_revision text CHECK (document_revision IS NULL OR document_revision ~ '^[0-9a-f]{64}$'),
  rank integer NOT NULL, score double precision NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS osaa.tool_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL, actor_id uuid NOT NULL,
  tool_id text NOT NULL, target text NOT NULL, permission_code text NOT NULL, reason text,
  input_digest text CHECK (input_digest IS NULL OR input_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('intent', 'authorized', 'applied', 'failed', 'blocked')),
  result_digest text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS osaa.llm_usage_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  provider_request_id text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id text NOT NULL,
  actor_label text NOT NULL,
  source text NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  session_digest text CHECK (session_digest IS NULL OR session_digest ~ '^sha256:[0-9a-f]{64}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
  key_fingerprint text,
  credential_revision text,
  provider text NOT NULL,
  model text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('chat_completion', 'embedding')),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  reasoning_tokens bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  usage_source text NOT NULL CHECK (usage_source IN ('provider', 'unavailable')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  finish_reason text,
  error_code text,
  estimated_cost_usd numeric(20, 10) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  pricing_version text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (total_tokens = 0 OR total_tokens >= input_tokens + output_tokens)
);

CREATE INDEX IF NOT EXISTS llm_usage_event_occurred_idx
  ON osaa.llm_usage_event (occurred_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_event_key_idx
  ON osaa.llm_usage_event (key_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_event_model_idx
  ON osaa.llm_usage_event (provider, model, occurred_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_event_source_idx
  ON osaa.llm_usage_event (source, occurred_at DESC);

CREATE TABLE IF NOT EXISTS osaa.runtime_resource (
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
  ON osaa.runtime_resource (expires_at, kind, namespace);

CREATE TABLE IF NOT EXISTS osaa.agent_run (
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
CREATE INDEX IF NOT EXISTS agent_run_started_idx ON osaa.agent_run (started_at DESC);

CREATE TABLE IF NOT EXISTS osaa.agent_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES osaa.agent_run(id) ON DELETE RESTRICT,
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

CREATE TABLE IF NOT EXISTS osaa.runtime_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'kubernetes',
  event_type text NOT NULL CHECK (event_type IN ('ADDED', 'MODIFIED', 'DELETED')),
  kind text NOT NULL,
  namespace text NOT NULL DEFAULT '',
  name text NOT NULL,
  resource_version text NOT NULL,
  health text NOT NULL DEFAULT 'Unknown'
    CHECK (health IN ('Ready', 'Degraded', 'NotReady', 'Unknown')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, event_type, kind, namespace, name, resource_version)
);
CREATE INDEX IF NOT EXISTS runtime_event_observed_idx
  ON osaa.runtime_event (observed_at DESC, kind, namespace);

CREATE TABLE IF NOT EXISTS osaa.watch_cursor (
  source text NOT NULL DEFAULT 'kubernetes',
  observer_id text NOT NULL CHECK (length(observer_id) BETWEEN 1 AND 200),
  kind text NOT NULL,
  namespace text NOT NULL DEFAULT '',
  resource_version text,
  status text NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'watching', 'reconnecting', 'stopped', 'error')),
  last_event_at timestamptz,
  last_error text,
  reconnect_count integer NOT NULL DEFAULT 0 CHECK (reconnect_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source, observer_id, kind, namespace)
);

ALTER TABLE osaa.retrieval_trace
  ADD COLUMN IF NOT EXISTS agent_run_id uuid REFERENCES osaa.agent_run(id) ON DELETE RESTRICT;
ALTER TABLE osaa.tool_run
  ADD COLUMN IF NOT EXISTS agent_run_id uuid REFERENCES osaa.agent_run(id) ON DELETE RESTRICT;
ALTER TABLE osaa.llm_usage_event
  ADD COLUMN IF NOT EXISTS agent_run_id uuid REFERENCES osaa.agent_run(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS retrieval_trace_agent_run_idx
  ON osaa.retrieval_trace (agent_run_id, rank) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_run_agent_run_idx
  ON osaa.tool_run (agent_run_id, created_at) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS llm_usage_event_agent_run_idx
  ON osaa.llm_usage_event (agent_run_id, occurred_at) WHERE agent_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS osaa.evidence_retention_policy (
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

CREATE TABLE IF NOT EXISTS osaa.evidence_policy_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream text NOT NULL,
  retention_days integer NOT NULL,
  disposition text NOT NULL,
  legal_hold boolean NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS osaa.evidence_export_receipt (
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

INSERT INTO osaa.evidence_retention_policy
  (stream, retention_days, disposition, legal_hold, updated_by, reason)
VALUES
  ('agent_run', 365, 'retain', false, 'native-migration-0031', 'Initial governed evidence retention policy'),
  ('agent_step', 365, 'retain', false, 'native-migration-0031', 'Initial governed evidence retention policy'),
  ('tool_run', 730, 'retain', false, 'native-migration-0031', 'Initial governed evidence retention policy'),
  ('retrieval_trace', 730, 'retain', false, 'native-migration-0031', 'Initial governed evidence retention policy'),
  ('llm_usage_event', 730, 'retain', false, 'native-migration-0031', 'Initial governed evidence retention policy'),
  ('runtime_event', 90, 'export-before-delete', false, 'native-migration-0031', 'Initial governed evidence retention policy')
ON CONFLICT (stream) DO NOTHING;

CREATE OR REPLACE VIEW osaa.evidence_retention_status WITH (security_invoker=true) AS
WITH evidence(stream, occurred_at) AS (
  SELECT 'agent_run', started_at FROM osaa.agent_run
  UNION ALL SELECT 'agent_step', occurred_at FROM osaa.agent_step
  UNION ALL SELECT 'tool_run', created_at FROM osaa.tool_run
  UNION ALL SELECT 'retrieval_trace', created_at FROM osaa.retrieval_trace
  UNION ALL SELECT 'llm_usage_event', occurred_at FROM osaa.llm_usage_event
  UNION ALL SELECT 'runtime_event', observed_at FROM osaa.runtime_event
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
        SELECT 1 FROM osaa.evidence_export_receipt receipt
        WHERE receipt.stream = policy.stream
          AND evidence.occurred_at >= receipt.window_start
          AND evidence.occurred_at < receipt.window_end
      )
  )::bigint AS export_covered_rows,
  (SELECT max(receipt.completed_at) FROM osaa.evidence_export_receipt receipt
   WHERE receipt.stream = policy.stream) AS last_export_at
FROM osaa.evidence_retention_policy policy
LEFT JOIN evidence ON evidence.stream = policy.stream
GROUP BY policy.stream, policy.retention_days, policy.disposition, policy.legal_hold,
         policy.updated_at, policy.updated_by, policy.reason;

CREATE FUNCTION osaa.reject_native_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'OSAA evidence is append-only'; END $$;
CREATE TRIGGER native_retrieval_trace_immutable BEFORE UPDATE OR DELETE ON osaa.retrieval_trace FOR EACH ROW EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
ALTER TABLE osaa.retrieval_trace ENABLE ALWAYS TRIGGER native_retrieval_trace_immutable;
CREATE TRIGGER native_retrieval_trace_no_truncate BEFORE TRUNCATE ON osaa.retrieval_trace FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
CREATE TRIGGER native_tool_run_immutable BEFORE UPDATE OR DELETE ON osaa.tool_run FOR EACH ROW EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
ALTER TABLE osaa.tool_run ENABLE ALWAYS TRIGGER native_tool_run_immutable;
CREATE TRIGGER native_tool_run_no_truncate BEFORE TRUNCATE ON osaa.tool_run FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
CREATE TRIGGER native_llm_usage_event_immutable BEFORE UPDATE OR DELETE ON osaa.llm_usage_event FOR EACH ROW EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
ALTER TABLE osaa.llm_usage_event ENABLE ALWAYS TRIGGER native_llm_usage_event_immutable;
CREATE TRIGGER native_llm_usage_event_no_truncate BEFORE TRUNCATE ON osaa.llm_usage_event FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
CREATE TRIGGER native_agent_step_immutable BEFORE UPDATE OR DELETE ON osaa.agent_step FOR EACH ROW EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
ALTER TABLE osaa.agent_step ENABLE ALWAYS TRIGGER native_agent_step_immutable;
CREATE TRIGGER native_agent_step_no_truncate BEFORE TRUNCATE ON osaa.agent_step FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
CREATE TRIGGER native_runtime_event_immutable BEFORE UPDATE OR DELETE ON osaa.runtime_event FOR EACH ROW EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
ALTER TABLE osaa.runtime_event ENABLE ALWAYS TRIGGER native_runtime_event_immutable;
CREATE TRIGGER native_runtime_event_no_truncate BEFORE TRUNCATE ON osaa.runtime_event FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
CREATE TRIGGER native_evidence_policy_event_immutable BEFORE UPDATE OR DELETE ON osaa.evidence_policy_event FOR EACH ROW EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
ALTER TABLE osaa.evidence_policy_event ENABLE ALWAYS TRIGGER native_evidence_policy_event_immutable;
CREATE TRIGGER native_evidence_policy_event_no_truncate BEFORE TRUNCATE ON osaa.evidence_policy_event FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
CREATE TRIGGER native_evidence_export_receipt_immutable BEFORE UPDATE OR DELETE ON osaa.evidence_export_receipt FOR EACH ROW EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
ALTER TABLE osaa.evidence_export_receipt ENABLE ALWAYS TRIGGER native_evidence_export_receipt_immutable;
CREATE TRIGGER native_evidence_export_receipt_no_truncate BEFORE TRUNCATE ON osaa.evidence_export_receipt FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_native_evidence_mutation();
ALTER TABLE osaa.osaa_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.osaa_knowledge_documents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.osaa_knowledge_documents FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_osaa_knowledge_documents ON osaa.osaa_knowledge_documents TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.osaa_knowledge_documents TO opensphere_osaa_gateway;
ALTER TABLE osaa.osaa_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.osaa_knowledge_chunks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.osaa_knowledge_chunks FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_osaa_knowledge_chunks ON osaa.osaa_knowledge_chunks TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.osaa_knowledge_chunks TO opensphere_osaa_gateway;
ALTER TABLE osaa.osaa_manual_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.osaa_manual_concepts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.osaa_manual_concepts FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_osaa_manual_concepts ON osaa.osaa_manual_concepts TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.osaa_manual_concepts TO opensphere_osaa_gateway;
ALTER TABLE osaa.osaa_manual_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.osaa_manual_relations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.osaa_manual_relations FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_osaa_manual_relations ON osaa.osaa_manual_relations TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.osaa_manual_relations TO opensphere_osaa_gateway;
ALTER TABLE osaa.osaa_tool_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.osaa_tool_capabilities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.osaa_tool_capabilities FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_osaa_tool_capabilities ON osaa.osaa_tool_capabilities TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.osaa_tool_capabilities TO opensphere_osaa_gateway;
ALTER TABLE osaa.osaa_manual_action_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.osaa_manual_action_bindings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.osaa_manual_action_bindings FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_osaa_manual_action_bindings ON osaa.osaa_manual_action_bindings TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.osaa_manual_action_bindings TO opensphere_osaa_gateway;
ALTER TABLE osaa.retrieval_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.retrieval_trace FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.retrieval_trace FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_retrieval_trace ON osaa.retrieval_trace TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.retrieval_trace TO opensphere_osaa_gateway;
ALTER TABLE osaa.tool_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.tool_run FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.tool_run FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_tool_run ON osaa.tool_run TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.tool_run TO opensphere_osaa_gateway;
ALTER TABLE osaa.llm_usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.llm_usage_event FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.llm_usage_event FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_llm_usage_event ON osaa.llm_usage_event TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.llm_usage_event TO opensphere_osaa_gateway;
ALTER TABLE osaa.runtime_resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.runtime_resource FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.runtime_resource FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_runtime_resource ON osaa.runtime_resource TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.runtime_resource TO opensphere_osaa_gateway;
ALTER TABLE osaa.agent_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.agent_run FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.agent_run FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_agent_run ON osaa.agent_run TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.agent_run TO opensphere_osaa_gateway;
ALTER TABLE osaa.agent_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.agent_step FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.agent_step FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_agent_step ON osaa.agent_step TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.agent_step TO opensphere_osaa_gateway;
ALTER TABLE osaa.runtime_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.runtime_event FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.runtime_event FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_runtime_event ON osaa.runtime_event TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.runtime_event TO opensphere_osaa_gateway;
ALTER TABLE osaa.watch_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.watch_cursor FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.watch_cursor FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_watch_cursor ON osaa.watch_cursor TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.watch_cursor TO opensphere_osaa_gateway;
ALTER TABLE osaa.evidence_retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.evidence_retention_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.evidence_retention_policy FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_evidence_retention_policy ON osaa.evidence_retention_policy TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.evidence_retention_policy TO opensphere_osaa_gateway;
ALTER TABLE osaa.evidence_policy_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.evidence_policy_event FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.evidence_policy_event FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_evidence_policy_event ON osaa.evidence_policy_event TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.evidence_policy_event TO opensphere_osaa_gateway;
ALTER TABLE osaa.evidence_export_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.evidence_export_receipt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.evidence_export_receipt FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY native_gateway_evidence_export_receipt ON osaa.evidence_export_receipt TO opensphere_osaa_gateway USING(true) WITH CHECK(true);
GRANT SELECT ON osaa.evidence_export_receipt TO opensphere_osaa_gateway;
GRANT INSERT,UPDATE ON osaa.osaa_knowledge_documents TO opensphere_osaa_gateway;
GRANT INSERT,UPDATE ON osaa.osaa_manual_concepts TO opensphere_osaa_gateway;
GRANT INSERT,UPDATE ON osaa.osaa_manual_relations TO opensphere_osaa_gateway;
GRANT INSERT,UPDATE ON osaa.osaa_tool_capabilities TO opensphere_osaa_gateway;
GRANT INSERT,UPDATE ON osaa.osaa_manual_action_bindings TO opensphere_osaa_gateway;
GRANT INSERT,UPDATE ON osaa.runtime_resource TO opensphere_osaa_gateway;
GRANT INSERT,UPDATE ON osaa.watch_cursor TO opensphere_osaa_gateway;
GRANT DELETE ON osaa.osaa_manual_relations,osaa.runtime_resource,osaa.watch_cursor TO opensphere_osaa_gateway;
GRANT INSERT ON osaa.osaa_knowledge_chunks,osaa.agent_run,osaa.retrieval_trace,osaa.tool_run,osaa.llm_usage_event,osaa.agent_step,osaa.runtime_event TO opensphere_osaa_gateway;
GRANT UPDATE(active,embedding,metadata) ON osaa.osaa_knowledge_chunks TO opensphere_osaa_gateway;
GRANT UPDATE(status,tool_calls,completed_at,error_code) ON osaa.agent_run TO opensphere_osaa_gateway;
GRANT SELECT ON osaa.evidence_retention_status TO opensphere_osaa_gateway;
REVOKE ALL ON FUNCTION osaa.reject_native_evidence_mutation() FROM PUBLIC;

-- Internal RPCs revalidate the current Console identity; no parallel OSAA users/roles.
CREATE FUNCTION osaa.assert_current_actor(p_actor uuid,p_session uuid,p_permission text,p_aal2 boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_identity AS $$
DECLARE s console_identity.browser_session; a console_identity.subject_authority;
BEGIN
 SELECT * INTO s FROM console_identity.browser_session WHERE session_id=p_session FOR SHARE;
 IF NOT FOUND OR s.subject_id<>p_actor OR s.revoked_at IS NOT NULL
   OR s.expires_at<=statement_timestamp() OR s.absolute_expires_at<=statement_timestamp()
 THEN RAISE EXCEPTION 'Current Console session required' USING ERRCODE='28000'; END IF;
 SELECT * INTO a FROM console_identity.subject_authority WHERE subject_id=p_actor FOR SHARE;
 IF NOT FOUND OR a.permission_revision<>s.permission_revision OR a.revoke_epoch<>s.revoke_epoch
 THEN RAISE EXCEPTION 'Stale Console authority' USING ERRCODE='28000'; END IF;
 IF p_aal2 AND (s.aal<>'aal2' OR s.last_reauthenticated_at IS NULL
   OR s.last_reauthenticated_at<statement_timestamp()-interval '5 minutes'
   OR s.last_reauthenticated_at>statement_timestamp()+interval '30 seconds')
 THEN RAISE EXCEPTION 'Recent AAL2 required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM console_identity.permission_grant WHERE subject_id=p_actor
   AND permission=p_permission AND grant_revision<=a.permission_revision AND revoked_at IS NULL)
 THEN RAISE EXCEPTION 'OSAA permission required' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION osaa.assert_current_actor(uuid,uuid,text,boolean) FROM PUBLIC;

CREATE FUNCTION osaa.c_ai_append_audit_event(p_request uuid,p_actor uuid,p_session uuid,
 p_action text,p_target_type text,p_target text,p_reason text,p_phase text,p_result text,p_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,osaa,console_audit AS $$
DECLARE receipt console_audit.event;
BEGIN
 IF p_request IS NULL OR p_actor IS NULL OR p_session IS NULL
   OR p_action NOT IN ('osaa-llm-key-upsert','osaa-llm-key-delete','osaa-llm-key-validate','osaa-dialogue-state-mode-change')
   OR p_target_type NOT IN ('osaa-llm-credential','osaa-dialogue-state-policy')
   OR length(COALESCE(p_target,'')) NOT BETWEEN 1 AND 300 OR p_target ~ '[\r\n]'
   OR length(trim(COALESCE(p_reason,''))) NOT BETWEEN 8 AND 1000
   OR p_phase NOT IN ('intent','applied','failed') OR p_result !~ '^[a-z][a-z0-9-]{1,63}$'
   OR p_digest !~ '^sha256:[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'Invalid native C_AI audit binding' USING ERRCODE='22023'; END IF;
 PERFORM osaa.assert_current_actor(p_actor,p_session,'osaa.knowledge.manage',true);
 receipt:=console_audit.append_event_internal(NULL,'osaa:'||p_request::text,p_actor::text,
   p_action,p_target_type||':'||p_target,CASE p_phase WHEN 'intent' THEN 'accepted' WHEN 'applied' THEN 'succeeded' ELSE 'failed' END,
   p_reason,jsonb_build_object('requestId',p_request,'payloadDigest',p_digest,'phase',p_phase,'result',p_result));
 RETURN jsonb_build_object('requestId',p_request,'eventId',receipt.event_id,'eventHash',receipt.event_hash);
END $$;
REVOKE ALL ON FUNCTION osaa.c_ai_append_audit_event(uuid,uuid,uuid,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION osaa.c_ai_append_audit_event(uuid,uuid,uuid,text,text,text,text,text,text,text) TO opensphere_osaa_gateway;

CREATE FUNCTION osaa.set_evidence_retention_policy(p_stream text,p_days integer,p_disposition text,p_hold boolean,p_actor uuid,p_reason text,p_session uuid)
RETURNS osaa.evidence_retention_policy LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,osaa,console_audit AS $$
DECLARE result osaa.evidence_retention_policy;
BEGIN
 PERFORM osaa.assert_current_actor(p_actor,p_session,'osaa.evidence.manage',true);
 IF p_stream IS NULL OR p_stream NOT IN ('agent_run','agent_step','tool_run','retrieval_trace','llm_usage_event','runtime_event')
  OR p_days IS NULL OR p_days NOT BETWEEN 30 AND 3650 OR p_disposition IS NULL OR p_disposition NOT IN ('retain','export-before-delete')
  OR p_hold IS NULL OR length(trim(COALESCE(p_reason,''))) NOT BETWEEN 8 AND 1000
 THEN RAISE EXCEPTION 'Invalid evidence retention policy' USING ERRCODE='22023'; END IF;
 UPDATE osaa.evidence_retention_policy SET retention_days=p_days,disposition=p_disposition,legal_hold=p_hold,
 updated_at=statement_timestamp(),updated_by=p_actor::text,reason=p_reason WHERE stream=p_stream RETURNING * INTO result;
 IF NOT FOUND THEN RAISE EXCEPTION 'Evidence stream not provisioned'; END IF;
 INSERT INTO osaa.evidence_policy_event(stream,retention_days,disposition,legal_hold,actor_id,reason)
 VALUES(p_stream,p_days,p_disposition,p_hold,p_actor::text,p_reason);
 PERFORM console_audit.append_event_internal(NULL,'osaa-retention:'||gen_random_uuid()::text,p_actor::text,
 'osaa.evidence.retention.update','osaa:evidence:'||p_stream,'succeeded',p_reason,
 jsonb_build_object('retentionDays',p_days,'disposition',p_disposition,'legalHold',p_hold,'deletionPerformed',false));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION osaa.set_evidence_retention_policy(text,integer,text,boolean,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION osaa.set_evidence_retention_policy(text,integer,text,boolean,uuid,text,uuid) TO opensphere_osaa_gateway;
CREATE OR REPLACE FUNCTION console_identity.managed_role_permissions(p_role text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE p_role
    WHEN 'console-admins' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.extension.install',
      'console.extension.remove',
      'console.extension.revoke',
      'console.git.change',
      'console.identity.manage',
      'console.operation.approve',
      'console.operation.verify',
      'console.registry.manage',
      'console.role.admin',
      'session:attach',
      'osaa.chat.use',
      'osaa.knowledge.read',
      'osaa.system.read',
      'osaa.knowledge.manage',
      'osaa.logs.read',
      'osaa.action.propose',
      'osaa.action.execute.low',
      'osaa.action.execute.high',
      'osaa.evidence.read',
      'osaa.evidence.manage'
    ]::text[]
    WHEN 'console-operators' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.extension.install',
      'console.extension.remove',
      'console.extension.revoke',
      'console.git.change',
      'console.operation.verify',
      'console.registry.manage',
      'console.role.operator',
      'session:attach',
      'osaa.chat.use',
      'osaa.knowledge.read',
      'osaa.system.read',
      'osaa.logs.read',
      'osaa.action.propose'
    ]::text[]
    WHEN 'console-viewers' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.role.viewer',
      'osaa.chat.use',
      'osaa.knowledge.read',
      'osaa.system.read'
    ]::text[]
    ELSE ARRAY[]::text[]
  END;
$$;
DO $$
DECLARE a console_identity.subject_authority; additions text[]; next_revision bigint;
BEGIN
 FOR a IN SELECT * FROM console_identity.subject_authority ORDER BY subject_id FOR UPDATE LOOP
  SELECT array_agg(DISTINCT requested.permission ORDER BY requested.permission) INTO additions
  FROM console_identity.permission_grant marker
  CROSS JOIN LATERAL unnest(console_identity.managed_role_permissions(CASE marker.permission
    WHEN 'console.role.admin' THEN 'console-admins' WHEN 'console.role.operator' THEN 'console-operators'
    WHEN 'console.role.viewer' THEN 'console-viewers' END)) requested(permission)
  WHERE marker.subject_id=a.subject_id AND marker.revoked_at IS NULL AND marker.grant_revision<=a.permission_revision
    AND requested.permission LIKE 'osaa.%'
    AND NOT EXISTS(SELECT 1 FROM console_identity.permission_grant g WHERE g.subject_id=a.subject_id
      AND g.permission=requested.permission AND g.revoked_at IS NULL AND g.grant_revision<=a.permission_revision);
  IF cardinality(additions)>0 THEN
   next_revision:=a.permission_revision+1;
   INSERT INTO console_identity.permission_grant(subject_id,permission,grant_revision,granted_by)
   SELECT a.subject_id,permission,next_revision,a.subject_id FROM unnest(additions) permission;
   UPDATE console_identity.subject_authority SET permission_revision=next_revision,revoke_epoch=revoke_epoch+1,updated_at=statement_timestamp() WHERE subject_id=a.subject_id;
   UPDATE console_identity.browser_session SET revoked_at=statement_timestamp(),revoke_reason='native-osaa-permission-policy' WHERE subject_id=a.subject_id AND revoked_at IS NULL;
   PERFORM console_audit.append_event_internal(NULL,'native-osaa-policy:'||gen_random_uuid()::text,'system:migration-0031',
    'identity.permission.policy.upgrade',a.subject_id::text,'succeeded','Native OSAA managed-role permission contract',jsonb_build_object('permissionsAdded',additions,'permissionRevision',next_revision));
  END IF;
 END LOOP;
END $$;