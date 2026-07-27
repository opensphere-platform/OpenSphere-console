\set ON_ERROR_STOP on

-- Browser authentication is mediated by the Console Backend. The browser
-- receives only an opaque HttpOnly cookie and a non-secret CSRF token; raw
-- Supabase access/refresh tokens never leave the server boundary.
CREATE TABLE IF NOT EXISTS console.browser_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  handle_hash text NOT NULL UNIQUE CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  access_token_ciphertext text NOT NULL,
  refresh_token_ciphertext text NOT NULL,
  supabase_session_id text,
  assurance text NOT NULL DEFAULT 'aal1' CHECK (assurance IN ('aal1', 'aal2')),
  persistence text NOT NULL CHECK (persistence IN ('browser', '8h', '24h', '7d')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_mfa', 'active', 'revoked', 'expired')),
  credential_revision bigint NOT NULL DEFAULT 0,
  user_agent_digest text CHECK (user_agent_digest IS NULL OR user_agent_digest ~ '^[0-9a-f]{64}$'),
  network_digest text CHECK (network_digest IS NULL OR network_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_reauthenticated_at timestamptz,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CONSTRAINT browser_session_expiry_order CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT browser_session_revocation_shape CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL AND length(btrim(revoke_reason)) >= 3)
    OR (status <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS browser_session_owner_status_idx
  ON console.browser_session(owner_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS browser_session_expiry_idx
  ON console.browser_session(status, idle_expires_at, absolute_expires_at);

COMMENT ON TABLE console.browser_session IS
  'Server-side browser session ledger. Token ciphertext is Backend-only and must never be projected to browser APIs.';
COMMENT ON COLUMN console.browser_session.csrf_hash IS
  'SHA-256 of the non-secret double-submit CSRF value returned only to the owning browser session.';
COMMENT ON COLUMN console.browser_session.network_digest IS
  'Privacy-minimized network prefix digest; no raw client IP is retained.';

ALTER TABLE console.browser_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.browser_session FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE console.browser_session FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE console.browser_session TO opensphere_console_backend;

DROP POLICY IF EXISTS console_backend_browser_session ON console.browser_session;
CREATE POLICY console_backend_browser_session ON console.browser_session
  FOR ALL TO opensphere_console_backend
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS console.session_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid REFERENCES console.browser_session(id) ON DELETE SET NULL,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('login', 'refresh', 'lock', 'unlock', 'step_up', 'logout', 'revoke', 'revoke_all', 'reuse_detected')),
  result text NOT NULL CHECK (result IN ('ok', 'pending', 'rejected', 'error')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid,
  metadata_digest text CHECK (metadata_digest IS NULL OR metadata_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS session_event_owner_time_idx
  ON console.session_event(owner_id, occurred_at DESC);

ALTER TABLE console.session_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.session_event FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE console.session_event FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE console.session_event TO opensphere_console_backend;
GRANT USAGE, SELECT ON SEQUENCE console.session_event_id_seq TO opensphere_console_backend;

DROP POLICY IF EXISTS console_backend_session_event ON console.session_event;
CREATE POLICY console_backend_session_event ON console.session_event
  FOR ALL TO opensphere_console_backend
  USING (true)
  WITH CHECK (true);

-- Console-owned metadata for the baseline infrastructure observation adapter.
-- Beszel credentials remain in a Kubernetes Secret and are intentionally not
-- modeled here.
CREATE TABLE IF NOT EXISTS console.infrastructure_monitoring_setting (
  id text PRIMARY KEY DEFAULT 'baseline' CHECK (id = 'baseline'),
  enabled boolean NOT NULL DEFAULT true,
  provider text NOT NULL DEFAULT 'beszel' CHECK (provider = 'beszel'),
  display_name text NOT NULL DEFAULT 'Infrastructure Monitoring',
  stale_after_seconds integer NOT NULL DEFAULT 120 CHECK (stale_after_seconds BETWEEN 30 AND 3600),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

INSERT INTO console.infrastructure_monitoring_setting(id)
VALUES ('baseline')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE console.infrastructure_monitoring_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.infrastructure_monitoring_setting FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE console.infrastructure_monitoring_setting FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE console.infrastructure_monitoring_setting TO opensphere_console_backend;

DROP POLICY IF EXISTS console_backend_infrastructure_monitoring_setting ON console.infrastructure_monitoring_setting;
CREATE POLICY console_backend_infrastructure_monitoring_setting ON console.infrastructure_monitoring_setting
  FOR ALL TO opensphere_console_backend
  USING (true)
  WITH CHECK (true);

-- A hostname is only a discovery hint. The durable binding joins the
-- Kubernetes Node UID with the fingerprint that the Beszel Hub verified
-- during the agent WebSocket handshake. A rebuilt node therefore creates a
-- new identity instead of silently inheriting the former node's history.
CREATE TABLE IF NOT EXISTS console.infrastructure_node_binding (
  kubernetes_node_uid text PRIMARY KEY CHECK (length(btrim(kubernetes_node_uid)) BETWEEN 8 AND 128),
  kubernetes_node_name text NOT NULL CHECK (length(btrim(kubernetes_node_name)) BETWEEN 1 AND 253),
  beszel_system_id text NOT NULL UNIQUE CHECK (length(btrim(beszel_system_id)) BETWEEN 8 AND 64),
  beszel_machine_fingerprint text NOT NULL CHECK (length(btrim(beszel_machine_fingerprint)) BETWEEN 8 AND 512),
  binding_state text NOT NULL DEFAULT 'verified' CHECK (binding_state IN ('verified', 'rejected')),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS infrastructure_node_binding_name_idx
  ON console.infrastructure_node_binding(kubernetes_node_name);

COMMENT ON TABLE console.infrastructure_node_binding IS
  'Backend-only Node UID + Beszel agent fingerprint binding; hostname alone never establishes node identity.';

ALTER TABLE console.infrastructure_node_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.infrastructure_node_binding FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE console.infrastructure_node_binding FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE console.infrastructure_node_binding TO opensphere_console_backend;

DROP POLICY IF EXISTS console_backend_infrastructure_node_binding ON console.infrastructure_node_binding;
CREATE POLICY console_backend_infrastructure_node_binding ON console.infrastructure_node_binding
  FOR ALL TO opensphere_console_backend
  USING (true)
  WITH CHECK (true);

INSERT INTO console.permission(code, description)
VALUES
  ('console.infrastructure.read', 'Read baseline node and Kubernetes observations'),
  ('console.infrastructure.manage', 'Manage baseline infrastructure observation settings')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO console.role_permission(role_id, permission_id)
SELECT r.id, p.id
FROM console.role r
JOIN console.permission p ON p.code = 'console.infrastructure.read'
WHERE r.code IN ('console-admins', 'console-operators', 'console-viewers')
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission(role_id, permission_id)
SELECT r.id, p.id
FROM console.role r
JOIN console.permission p ON p.code = 'console.infrastructure.manage'
WHERE r.code IN ('console-admins', 'console-operators')
ON CONFLICT DO NOTHING;
