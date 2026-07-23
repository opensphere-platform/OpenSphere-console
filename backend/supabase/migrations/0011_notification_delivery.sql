\set ON_ERROR_STOP on

-- Console outbound notification delivery.  Browser identities have no direct
-- table grants; Console Backend mediates configuration and the Dispatcher owns
-- queue processing plus encrypted credential access.
DO $$ BEGIN
  CREATE ROLE opensphere_notification_dispatcher NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- PostgREST authenticates as `authenticator` before it SET ROLEs to the JWT
-- claim. Membership is required even though the dispatcher role has NOLOGIN.
GRANT opensphere_notification_dispatcher TO authenticator;

CREATE TABLE IF NOT EXISTS console.notification_channel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  provider text NOT NULL CHECK (provider IN ('slack', 'discord', 'smtp', 'twilio')),
  channel_type text NOT NULL CHECK (channel_type IN ('chat', 'email', 'sms')),
  enabled boolean NOT NULL DEFAULT false,
  health_state text NOT NULL DEFAULT 'Draft' CHECK (health_state IN ('Draft', 'Healthy', 'Degraded', 'Disabled', 'Misconfigured')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_configured boolean NOT NULL DEFAULT false,
  secret_version integer NOT NULL DEFAULT 0 CHECK (secret_version >= 0),
  last_test_status text CHECK (last_test_status IN ('accepted', 'failed')),
  last_test_at timestamptz,
  last_test_error_code text,
  last_success_at timestamptz,
  created_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS notification_channel_state_idx ON console.notification_channel (enabled, health_state) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notification_channel_name_live_idx ON console.notification_channel (name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS console.notification_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  min_severity text NOT NULL DEFAULT 'error' CHECK (min_severity IN ('info', 'success', 'warning', 'error', 'critical')),
  sources text[] NOT NULL DEFAULT '{}'::text[],
  categories text[] NOT NULL DEFAULT '{}'::text[],
  label_match jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_window_seconds integer NOT NULL DEFAULT 0 CHECK (dedup_window_seconds BETWEEN 0 AND 86400),
  throttle jsonb NOT NULL DEFAULT '{}'::jsonb,
  message_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS notification_rule_enabled_priority_idx ON console.notification_rule (priority, id) WHERE enabled AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notification_rule_name_live_idx ON console.notification_rule (name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS console.notification_rule_channel (
  rule_id uuid NOT NULL REFERENCES console.notification_rule(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES console.notification_channel(id) ON DELETE RESTRICT,
  PRIMARY KEY (rule_id, channel_id)
);

CREATE TABLE IF NOT EXISTS console.notification_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (length(btrim(source_type)) BETWEEN 1 AND 80),
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 255),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 120),
  category text NOT NULL DEFAULT '',
  severity text NOT NULL CHECK (severity IN ('info', 'success', 'warning', 'error', 'critical')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
  route text NOT NULL DEFAULT '' CHECK (length(route) <= 500 AND (route = '' OR route LIKE '/%')),
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id uuid,
  correlation_id text,
  payload_digest text CHECK (payload_digest IS NULL OR payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'processing', 'processed')),
  claimed_by text,
  claimed_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS notification_event_queue_idx ON console.notification_event (state, occurred_at) WHERE state <> 'processed';

CREATE TABLE IF NOT EXISTS console.notification_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES console.notification_event(id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES console.notification_channel(id) ON DELETE RESTRICT,
  rule_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'accepted', 'delivered', 'retrying', 'failed', 'dead-letter', 'suppressed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_generation integer NOT NULL DEFAULT 0 CHECK (retry_generation >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  lock_owner text,
  provider_message_id text,
  last_error_class text,
  last_error_code text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, channel_id)
);
CREATE INDEX IF NOT EXISTS notification_delivery_queue_idx ON console.notification_delivery (status, next_attempt_at) WHERE status IN ('queued', 'retrying');
CREATE INDEX IF NOT EXISTS notification_delivery_channel_idx ON console.notification_delivery (channel_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS console.notification_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES console.notification_delivery(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'delivered', 'retryable', 'permanent', 'failed')),
  provider_code text,
  provider_message_id text,
  retry_after_ms integer CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_class text,
  error_message text,
  request_digest text,
  response_digest text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (delivery_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS notification_attempt_delivery_idx ON console.notification_attempt (delivery_id, attempt_number DESC);

-- Ciphertext only.  No PostgREST SELECT grant is made for this table; the
-- Dispatcher reaches it through narrowly scoped SECURITY DEFINER functions.
CREATE TABLE IF NOT EXISTS console.notification_secret (
  channel_id uuid PRIMARY KEY REFERENCES console.notification_channel(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  algorithm text NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  iv text NOT NULL,
  auth_tag text NOT NULL,
  ciphertext text NOT NULL,
  plaintext_digest text NOT NULL CHECK (plaintext_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rotated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS console.notification_callback_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_message_id text,
  delivery_id uuid REFERENCES console.notification_delivery(id) ON DELETE SET NULL,
  signature_valid boolean NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('accepted', 'duplicate', 'rejected', 'ignored')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  normalized_status text,
  error_code text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS console.notification_delivery_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  paused boolean NOT NULL DEFAULT false,
  reason text,
  changed_by uuid REFERENCES console.operator(user_id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO console.notification_delivery_control(singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE console.notification_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.notification_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.notification_rule_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.notification_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.notification_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.notification_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.notification_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.notification_callback_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.notification_delivery_control ENABLE ROW LEVEL SECURITY;

CREATE POLICY console_backend_notification_channel ON console.notification_channel FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_notification_rule ON console.notification_rule FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_notification_rule_channel ON console.notification_rule_channel FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_notification_event ON console.notification_event FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_notification_delivery ON console.notification_delivery FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_notification_attempt ON console.notification_attempt FOR SELECT TO opensphere_console_backend USING (true);
CREATE POLICY console_backend_notification_callback ON console.notification_callback_receipt FOR SELECT TO opensphere_console_backend USING (true);
CREATE POLICY console_backend_notification_control ON console.notification_delivery_control FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);

CREATE POLICY dispatcher_notification_channel ON console.notification_channel FOR SELECT TO opensphere_notification_dispatcher USING (true);
CREATE POLICY dispatcher_notification_channel_update ON console.notification_channel FOR UPDATE TO opensphere_notification_dispatcher USING (true) WITH CHECK (true);
CREATE POLICY dispatcher_notification_rule ON console.notification_rule FOR SELECT TO opensphere_notification_dispatcher USING (true);
CREATE POLICY dispatcher_notification_rule_channel ON console.notification_rule_channel FOR SELECT TO opensphere_notification_dispatcher USING (true);
CREATE POLICY dispatcher_notification_event_select ON console.notification_event FOR SELECT TO opensphere_notification_dispatcher USING (true);
CREATE POLICY dispatcher_notification_event_update ON console.notification_event FOR UPDATE TO opensphere_notification_dispatcher USING (true) WITH CHECK (true);
CREATE POLICY dispatcher_notification_delivery_select ON console.notification_delivery FOR SELECT TO opensphere_notification_dispatcher USING (true);
CREATE POLICY dispatcher_notification_delivery_insert ON console.notification_delivery FOR INSERT TO opensphere_notification_dispatcher WITH CHECK (true);
CREATE POLICY dispatcher_notification_delivery_update ON console.notification_delivery FOR UPDATE TO opensphere_notification_dispatcher USING (true) WITH CHECK (true);
CREATE POLICY dispatcher_notification_attempt_select ON console.notification_attempt FOR SELECT TO opensphere_notification_dispatcher USING (true);
CREATE POLICY dispatcher_notification_attempt_insert ON console.notification_attempt FOR INSERT TO opensphere_notification_dispatcher WITH CHECK (true);
CREATE POLICY dispatcher_notification_callback_select ON console.notification_callback_receipt FOR SELECT TO opensphere_notification_dispatcher USING (true);
CREATE POLICY dispatcher_notification_callback_insert ON console.notification_callback_receipt FOR INSERT TO opensphere_notification_dispatcher WITH CHECK (true);
CREATE POLICY dispatcher_notification_control ON console.notification_delivery_control FOR SELECT TO opensphere_notification_dispatcher USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON console.notification_channel, console.notification_rule, console.notification_rule_channel, console.notification_event, console.notification_delivery, console.notification_delivery_control TO opensphere_console_backend;
GRANT SELECT ON console.notification_attempt, console.notification_callback_receipt TO opensphere_console_backend;
GRANT SELECT ON console.notification_channel, console.notification_rule, console.notification_rule_channel, console.notification_event, console.notification_delivery, console.notification_delivery_control TO opensphere_notification_dispatcher;
GRANT UPDATE ON console.notification_channel TO opensphere_notification_dispatcher;
GRANT INSERT, UPDATE ON console.notification_event, console.notification_delivery, console.notification_attempt, console.notification_callback_receipt TO opensphere_notification_dispatcher;
GRANT USAGE ON SCHEMA console TO opensphere_notification_dispatcher;

CREATE OR REPLACE FUNCTION console.notification_store_secret(
  p_channel_id uuid, p_version integer, p_iv text, p_auth_tag text, p_ciphertext text, p_plaintext_digest text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
BEGIN
  IF p_version < 1 OR p_plaintext_digest !~ '^sha256:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid notification secret payload'; END IF;
  INSERT INTO console.notification_secret(channel_id, version, algorithm, iv, auth_tag, ciphertext, plaintext_digest)
  VALUES (p_channel_id, p_version, 'aes-256-gcm', p_iv, p_auth_tag, p_ciphertext, p_plaintext_digest)
  ON CONFLICT (channel_id) DO UPDATE SET version = EXCLUDED.version, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
    ciphertext = EXCLUDED.ciphertext, plaintext_digest = EXCLUDED.plaintext_digest, rotated_at = clock_timestamp(), revoked_at = NULL;
END;
$$;

CREATE OR REPLACE FUNCTION console.notification_read_secret(p_channel_id uuid)
RETURNS TABLE(version integer, algorithm text, iv text, auth_tag text, ciphertext text, plaintext_digest text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
  SELECT version, algorithm, iv, auth_tag, ciphertext, plaintext_digest FROM console.notification_secret
  WHERE channel_id = p_channel_id AND revoked_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION console.notification_claim_events(p_worker_id text, p_limit integer DEFAULT 25)
RETURNS SETOF console.notification_event
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM console.notification_event
    WHERE state = 'queued' OR (state = 'processing' AND claimed_at < clock_timestamp() - interval '5 minutes')
    ORDER BY occurred_at ASC
    FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit, 1), 100)
  )
  UPDATE console.notification_event e SET state = 'processing', claimed_by = left(p_worker_id, 120), claimed_at = clock_timestamp()
  FROM candidates c WHERE e.id = c.id RETURNING e.*;
END;
$$;

CREATE OR REPLACE FUNCTION console.notification_materialize_deliveries(p_event_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
DECLARE event_row console.notification_event; count_created integer;
BEGIN
  SELECT * INTO event_row FROM console.notification_event WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'notification event not found'; END IF;
  IF (SELECT paused FROM console.notification_delivery_control WHERE singleton) THEN
    UPDATE console.notification_event SET state = 'processed', processed_at = clock_timestamp() WHERE id = p_event_id;
    RETURN 0;
  END IF;
  INSERT INTO console.notification_delivery(event_id, channel_id, rule_ids, policy_snapshot, status)
  SELECT event_row.id, rc.channel_id, array_agg(r.id ORDER BY r.priority),
    jsonb_build_object('rules', jsonb_agg(jsonb_build_object('id', r.id, 'version', r.version, 'priority', r.priority))), 'queued'
  FROM console.notification_rule r
  JOIN console.notification_rule_channel rc ON rc.rule_id = r.id
  JOIN console.notification_channel c ON c.id = rc.channel_id
  WHERE r.enabled AND r.deleted_at IS NULL AND c.enabled AND c.deleted_at IS NULL AND c.credential_configured
    AND (cardinality(r.sources) = 0 OR event_row.source = ANY(r.sources))
    AND (cardinality(r.categories) = 0 OR event_row.category = ANY(r.categories))
    AND event_row.labels @> r.label_match
    AND (CASE event_row.severity WHEN 'info' THEN 1 WHEN 'success' THEN 2 WHEN 'warning' THEN 3 WHEN 'error' THEN 4 ELSE 5 END)
      >= (CASE r.min_severity WHEN 'info' THEN 1 WHEN 'success' THEN 2 WHEN 'warning' THEN 3 WHEN 'error' THEN 4 ELSE 5 END)
  GROUP BY rc.channel_id
  ON CONFLICT (event_id, channel_id) DO NOTHING;
  GET DIAGNOSTICS count_created = ROW_COUNT;
  UPDATE console.notification_event SET state = 'processed', processed_at = clock_timestamp() WHERE id = p_event_id;
  RETURN count_created;
END;
$$;

CREATE OR REPLACE FUNCTION console.notification_claim_deliveries(p_worker_id text, p_limit integer DEFAULT 25)
RETURNS SETOF console.notification_delivery
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM console.notification_delivery
    WHERE (status IN ('queued', 'retrying') AND next_attempt_at <= clock_timestamp())
       OR (status = 'sending' AND locked_at < clock_timestamp() - interval '5 minutes')
    ORDER BY next_attempt_at ASC
    FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit, 1), 100)
  )
  UPDATE console.notification_delivery d SET status = 'sending', locked_at = clock_timestamp(), lock_owner = left(p_worker_id, 120), updated_at = clock_timestamp()
  FROM candidates c WHERE d.id = c.id RETURNING d.*;
END;
$$;

REVOKE ALL ON FUNCTION console.notification_store_secret(uuid, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.notification_read_secret(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.notification_claim_events(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.notification_materialize_deliveries(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION console.notification_claim_deliveries(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console.notification_store_secret(uuid, integer, text, text, text, text) TO opensphere_notification_dispatcher;
GRANT EXECUTE ON FUNCTION console.notification_read_secret(uuid) TO opensphere_notification_dispatcher;
GRANT EXECUTE ON FUNCTION console.notification_claim_events(text, integer) TO opensphere_notification_dispatcher;
GRANT EXECUTE ON FUNCTION console.notification_materialize_deliveries(uuid) TO opensphere_notification_dispatcher;
GRANT EXECUTE ON FUNCTION console.notification_claim_deliveries(text, integer) TO opensphere_notification_dispatcher;

-- Existing Console management writes already create immutable audit evidence.
-- Project it transactionally into the outbound event queue without changing
-- the audit ledger or allowing a browser to manufacture delivery events.
CREATE OR REPLACE FUNCTION console.project_audit_notification_event()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console, audit AS $$
DECLARE severity_value text;
BEGIN
  severity_value := CASE
    WHEN lower(NEW.result) ~ '(fail|error|deny|reject)' THEN 'error'
    WHEN lower(NEW.result) ~ '(warn|attention)' THEN 'warning'
    WHEN lower(NEW.result) ~ '(success|accepted|ok|complete)' THEN 'success'
    ELSE 'info'
  END;
  INSERT INTO console.notification_event(
    source_type, source_id, source, category, severity, title, body, route,
    labels, request_id, correlation_id, payload_digest, occurred_at
  ) VALUES (
    'audit', NEW.id::text, 'audit', left(NEW.target_type, 120), severity_value,
    left(NEW.action || ' — ' || NEW.target_id, 240), left(NEW.reason, 4000), '/manage/audit',
    jsonb_build_object('phase', NEW.phase, 'result', NEW.result, 'targetType', NEW.target_type),
    NEW.request_id, NEW.correlation_id, coalesce(NEW.payload_digest, 'sha256:' || repeat('0', 64)), NEW.occurred_at
  ) ON CONFLICT (source_type, source_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_event_notification_projection ON audit.event;
CREATE TRIGGER audit_event_notification_projection
  AFTER INSERT ON audit.event
  FOR EACH ROW EXECUTE FUNCTION console.project_audit_notification_event();
