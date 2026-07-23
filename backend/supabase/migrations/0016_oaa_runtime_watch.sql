\set ON_ERROR_STOP on

-- Event-driven Kubernetes observation for OAA. Kubernetes remains authoritative;
-- Supabase stores only sanitized projections, resourceVersion cursors, and digests.

CREATE TABLE IF NOT EXISTS oaa.runtime_event (
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
  ON oaa.runtime_event (observed_at DESC, kind, namespace);

CREATE TABLE IF NOT EXISTS oaa.watch_cursor (
  source text NOT NULL DEFAULT 'kubernetes',
  kind text NOT NULL,
  namespace text NOT NULL DEFAULT '',
  resource_version text,
  status text NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'watching', 'reconnecting', 'stopped', 'error')),
  last_event_at timestamptz,
  last_error text,
  reconnect_count integer NOT NULL DEFAULT 0 CHECK (reconnect_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source, kind, namespace)
);

DROP TRIGGER IF EXISTS runtime_event_append_only ON oaa.runtime_event;
CREATE TRIGGER runtime_event_append_only BEFORE UPDATE OR DELETE ON oaa.runtime_event
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.runtime_event ENABLE ALWAYS TRIGGER runtime_event_append_only;

ALTER TABLE oaa.runtime_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.watch_cursor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oaa_gateway_runtime_event_read ON oaa.runtime_event;
DROP POLICY IF EXISTS oaa_gateway_runtime_event_insert ON oaa.runtime_event;
CREATE POLICY oaa_gateway_runtime_event_read ON oaa.runtime_event
  FOR SELECT TO opensphere_oaa_gateway USING (true);
CREATE POLICY oaa_gateway_runtime_event_insert ON oaa.runtime_event
  FOR INSERT TO opensphere_oaa_gateway WITH CHECK (true);

DROP POLICY IF EXISTS oaa_gateway_watch_cursor ON oaa.watch_cursor;
CREATE POLICY oaa_gateway_watch_cursor ON oaa.watch_cursor
  FOR ALL TO opensphere_oaa_gateway USING (true) WITH CHECK (true);

REVOKE UPDATE, DELETE, TRUNCATE ON oaa.runtime_event FROM opensphere_oaa_gateway;
GRANT SELECT, INSERT ON oaa.runtime_event TO opensphere_oaa_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON oaa.watch_cursor TO opensphere_oaa_gateway;

COMMENT ON TABLE oaa.runtime_event IS
  'Append-only digest evidence of sanitized Kubernetes watch changes; no Secret data, ConfigMap values, Pod env, or raw log content.';
COMMENT ON TABLE oaa.watch_cursor IS
  'Mutable liveness/cursor projection for OAA Kubernetes watches; never an execution authority.';
