\set ON_ERROR_STOP on

-- Canonical, append-only usage ledger for every provider-backed OAA request.
-- API keys, prompts, responses, and bearer tokens are deliberately excluded.
-- The stable key id survives credential rotation; the fingerprint/revision
-- snapshot preserves which credential generation produced the usage event.
CREATE TABLE IF NOT EXISTS oaa.llm_usage_event (
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
  ON oaa.llm_usage_event (occurred_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_event_key_idx
  ON oaa.llm_usage_event (key_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_event_model_idx
  ON oaa.llm_usage_event (provider, model, occurred_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_event_source_idx
  ON oaa.llm_usage_event (source, occurred_at DESC);

CREATE OR REPLACE FUNCTION oaa.reject_llm_usage_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'oaa.llm_usage_event is append-only';
END;
$$;

DROP TRIGGER IF EXISTS llm_usage_event_append_only ON oaa.llm_usage_event;
CREATE TRIGGER llm_usage_event_append_only
  BEFORE UPDATE OR DELETE ON oaa.llm_usage_event
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_llm_usage_mutation();
ALTER TABLE oaa.llm_usage_event ENABLE ALWAYS TRIGGER llm_usage_event_append_only;
ALTER TABLE oaa.llm_usage_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oaa_gateway_llm_usage_read ON oaa.llm_usage_event;
CREATE POLICY oaa_gateway_llm_usage_read ON oaa.llm_usage_event
  FOR SELECT TO opensphere_oaa_gateway USING (true);
DROP POLICY IF EXISTS oaa_gateway_llm_usage_insert ON oaa.llm_usage_event;
CREATE POLICY oaa_gateway_llm_usage_insert ON oaa.llm_usage_event
  FOR INSERT TO opensphere_oaa_gateway WITH CHECK (true);

REVOKE ALL ON oaa.llm_usage_event FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON oaa.llm_usage_event FROM opensphere_oaa_gateway;
GRANT SELECT, INSERT ON oaa.llm_usage_event TO opensphere_oaa_gateway;

INSERT INTO console.permission (code, risk_level) VALUES
  ('oaa.usage.read', 'medium')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM console.role r
JOIN console.permission p ON p.code = 'oaa.usage.read'
WHERE r.code = 'console-admins'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE oaa.llm_usage_event IS
  'Append-only LLM/embedding token usage evidence; never stores API keys, prompts, responses, or bearer tokens.';
