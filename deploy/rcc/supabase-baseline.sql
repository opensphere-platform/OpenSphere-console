\set ON_ERROR_STOP on

-- PolyON RCC baseline: identity, control-center scope, change intent and
-- append-only audit only. OpenSphere plugin/OAA/AI/CLI schemas are deliberately
-- not inherited.
CREATE SCHEMA IF NOT EXISTS console AUTHORIZATION supabase_admin;
CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION supabase_admin;
CREATE SCHEMA IF NOT EXISTS internal AUTHORIZATION supabase_admin;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA console, audit, internal FROM PUBLIC;

CREATE TABLE IF NOT EXISTS console.operator (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  credential_revision bigint NOT NULL DEFAULT 1 CHECK (credential_revision > 0),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS console.role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_-]{2,63}$'),
  description text NOT NULL DEFAULT '',
  system_managed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS console.permission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_.:-]{2,127}$'),
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical'))
);

CREATE TABLE IF NOT EXISTS console.role_permission (
  role_id uuid NOT NULL REFERENCES console.role(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES console.permission(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS console.operator_role (
  user_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES console.role(id) ON DELETE RESTRICT,
  granted_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 4),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (user_id, role_id),
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE TABLE IF NOT EXISTS console.control_center (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'disabled')),
  kubernetes_mode text NOT NULL DEFAULT 'read-only' CHECK (kubernetes_mode IN ('read-only', 'governed-write')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS console.operator_control_center (
  user_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE CASCADE,
  control_center_id text NOT NULL REFERENCES console.control_center(id) ON DELETE RESTRICT,
  access_level text NOT NULL CHECK (access_level IN ('viewer', 'operator', 'admin')),
  granted_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (user_id, control_center_id),
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE TABLE IF NOT EXISTS console.user_setting (
  owner_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE IF NOT EXISTS console.change_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  control_center_id text NOT NULL REFERENCES console.control_center(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'service', 'break_glass')),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  status text NOT NULL DEFAULT 'intent' CHECK (status IN ('intent', 'authorized', 'committed', 'applied', 'failed', 'unknown', 'reverted')),
  git_repo text,
  git_ref text,
  git_commit_sha text CHECK (git_commit_sha IS NULL OR git_commit_sha ~ '^[0-9a-f]{40,64}$'),
  k8s_operation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (git_repo, git_commit_sha)
);

CREATE TABLE IF NOT EXISTS audit.event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id uuid NOT NULL,
  correlation_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'service', 'break_glass', 'system')),
  actor_id uuid,
  auth_session_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('intent', 'authorized', 'committed', 'applied', 'failed', 'reverted')),
  result text NOT NULL,
  git_commit_sha text CHECK (git_commit_sha IS NULL OR git_commit_sha ~ '^[0-9a-f]{40,64}$'),
  k8s_operation_id text,
  payload_digest text CHECK (payload_digest IS NULL OR payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  prev_hash text,
  event_hash text NOT NULL,
  UNIQUE (request_id, phase, event_hash)
);

CREATE INDEX IF NOT EXISTS audit_event_occurred_idx ON audit.event (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_actor_idx ON audit.event (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_correlation_idx ON audit.event (correlation_id);
CREATE INDEX IF NOT EXISTS change_request_cc_status_idx ON console.change_request (control_center_id, status, created_at);

CREATE OR REPLACE FUNCTION audit.reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.event is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_event_append_only ON audit.event;
CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
ALTER TABLE audit.event ENABLE ALWAYS TRIGGER audit_event_append_only;

ALTER TABLE console.operator ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.operator_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.operator_control_center ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.user_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.change_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_read_self ON console.operator;
CREATE POLICY operator_read_self ON console.operator FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS operator_role_read_self ON console.operator_role;
CREATE POLICY operator_role_read_self ON console.operator_role FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND (expires_at IS NULL OR expires_at > now()));
DROP POLICY IF EXISTS operator_cc_read_self ON console.operator_control_center;
CREATE POLICY operator_cc_read_self ON console.operator_control_center FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND (expires_at IS NULL OR expires_at > now()));
DROP POLICY IF EXISTS user_setting_self ON console.user_setting;
CREATE POLICY user_setting_self ON console.user_setting FOR ALL TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS change_request_read_own ON console.change_request;
CREATE POLICY change_request_read_own ON console.change_request FOR SELECT TO authenticated
  USING (actor_type = 'human' AND actor_id = auth.uid());
DROP POLICY IF EXISTS audit_read_own ON audit.event;
CREATE POLICY audit_read_own ON audit.event FOR SELECT TO authenticated
  USING (actor_type = 'human' AND actor_id = auth.uid());

DROP POLICY IF EXISTS rcc_backend_operator ON console.operator;
CREATE POLICY rcc_backend_operator ON console.operator FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rcc_backend_operator_role ON console.operator_role;
CREATE POLICY rcc_backend_operator_role ON console.operator_role FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rcc_backend_operator_cc ON console.operator_control_center;
CREATE POLICY rcc_backend_operator_cc ON console.operator_control_center FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rcc_backend_user_setting ON console.user_setting;
CREATE POLICY rcc_backend_user_setting ON console.user_setting FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rcc_backend_change_request ON console.change_request;
CREATE POLICY rcc_backend_change_request ON console.change_request FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rcc_backend_event_read ON audit.event;
CREATE POLICY rcc_backend_event_read ON audit.event FOR SELECT TO opensphere_console_backend
  USING (true);
DROP POLICY IF EXISTS rcc_backend_event_insert ON audit.event;
CREATE POLICY rcc_backend_event_insert ON audit.event FOR INSERT TO opensphere_console_backend
  WITH CHECK (true);

GRANT USAGE ON SCHEMA console, audit TO authenticated;
GRANT SELECT ON console.operator, console.operator_role, console.operator_control_center,
  console.control_center, console.change_request, audit.event TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON console.user_setting TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON console.operator, console.role, console.permission,
  console.role_permission, console.operator_role, console.operator_control_center,
  console.control_center, console.change_request, audit.event FROM anon, authenticated;

GRANT CONNECT ON DATABASE postgres TO opensphere_console_backend;
GRANT USAGE ON SCHEMA console, audit, internal TO opensphere_console_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA console TO opensphere_console_backend;
GRANT SELECT, INSERT ON audit.event TO opensphere_console_backend;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA console, audit TO opensphere_console_backend;
REVOKE UPDATE, DELETE, TRUNCATE ON audit.event FROM opensphere_console_backend;
GRANT opensphere_console_backend TO authenticator;

-- Default privileges, mirroring migrations 0002 and 0008.
--
-- The grants above apply to the tables that exist at this point; these decide
-- what a table created later gets. Omitting them is not the safe choice, it is
-- the divergent one: an upgraded region carries them and a region installed
-- from this file would not, so the same table would end up with different
-- privileges depending on how the region was built. Anything that must be
-- narrower than this states so explicitly at the point it is created.
ALTER DEFAULT PRIVILEGES IN SCHEMA console
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opensphere_console_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO opensphere_console_backend;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA console
  REVOKE ALL ON TABLES FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA console
  REVOKE ALL ON SEQUENCES FROM service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA audit
  REVOKE ALL ON TABLES FROM service_role;

-- ── migration ledger (mirrors migration 0026) ────────────────────────────────
--
-- A region installed from this baseline still needs somewhere to record what it
-- has applied. Without the ledger a clean install cannot later be fed an
-- incremental migration at all, because the runner keys off this table, and it
-- carries no attestation of which revision produced the schema it is running.

CREATE TABLE IF NOT EXISTS console.schema_migration (
  migration_id text PRIMARY KEY CHECK (migration_id ~ '^[0-9]{4}_[a-z0-9_]+$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  executor text NOT NULL DEFAULT current_user,
  result text NOT NULL DEFAULT 'applied' CHECK (result = 'applied')
);

CREATE OR REPLACE FUNCTION console.reject_schema_migration_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
BEGIN
  RAISE EXCEPTION 'console.schema_migration is append-only';
END;
$$;

DROP TRIGGER IF EXISTS schema_migration_append_only ON console.schema_migration;
CREATE TRIGGER schema_migration_append_only
  BEFORE UPDATE OR DELETE ON console.schema_migration
  FOR EACH ROW EXECUTE FUNCTION console.reject_schema_migration_mutation();
ALTER TABLE console.schema_migration ENABLE ALWAYS TRIGGER schema_migration_append_only;

REVOKE ALL ON TABLE console.schema_migration FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE console.schema_migration TO opensphere_console_backend;

COMMENT ON TABLE console.schema_migration IS
  'Append-only Console migration ID, SHA-256 and immutable release source revision; checksum drift fails closed in the installer.';

INSERT INTO console.control_center (id, display_name, status, kubernetes_mode) VALUES
  ('cc2', 'CC2', 'active', 'read-only')
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status = EXCLUDED.status,
  kubernetes_mode = EXCLUDED.kubernetes_mode,
  updated_at = now();

INSERT INTO console.role (code, description, system_managed) VALUES
  ('console-admins', 'PolyON RCC administration', true),
  ('console-operators', 'Day-to-day RCC operations', true),
  ('console-viewers', 'Read-only RCC access', true)
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, system_managed = true;

INSERT INTO console.permission (code, risk_level) VALUES
  ('console.read', 'low'),
  ('console.settings.write', 'medium'),
  ('console.identity.manage', 'critical'),
  ('console.git.change', 'high'),
  ('console.kubernetes.read', 'low')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
WHERE r.code = 'console-admins'
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p
  ON p.code IN ('console.read', 'console.settings.write', 'console.git.change', 'console.kubernetes.read')
WHERE r.code = 'console-operators'
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p
  ON p.code IN ('console.read', 'console.kubernetes.read')
WHERE r.code = 'console-viewers'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Linux host authority (mirrors backend/supabase/migrations/0027_linux_host_authority.sql)
--
-- console.host stores the agent KEY ID only.  Agent signing secrets live in a
-- root-mounted backend file and must never be reachable through PostgREST.
-- ---------------------------------------------------------------------------

ALTER TABLE console.control_center
  ADD COLUMN IF NOT EXISTS host_control_mode text NOT NULL DEFAULT 'read-only';
ALTER TABLE console.control_center
  DROP CONSTRAINT IF EXISTS control_center_host_control_mode_check;
ALTER TABLE console.control_center
  ADD CONSTRAINT control_center_host_control_mode_check
  CHECK (host_control_mode IN ('read-only', 'governed-write'));

CREATE TABLE IF NOT EXISTS console.host (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_center_id text NOT NULL REFERENCES console.control_center(id) ON DELETE RESTRICT,
  host_id text NOT NULL CHECK (host_id ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 128),
  agent_key_id text NOT NULL CHECK (agent_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'retired')),
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  enrolled_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (control_center_id, host_id)
);

CREATE TABLE IF NOT EXISTS console.host_snapshot (
  host_uuid uuid PRIMARY KEY REFERENCES console.host(id) ON DELETE CASCADE,
  schema_version text NOT NULL CHECK (schema_version ~ '^rcc\.host\.snapshot/v[0-9]{1,3}$'),
  agent_version text NOT NULL CHECK (length(agent_version) BETWEEN 1 AND 64),
  agent_key_id text NOT NULL CHECK (agent_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  collected_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  CHECK (pg_column_size(payload) <= 131072)
);

CREATE TABLE IF NOT EXISTS console.host_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  -- No single-column host reference here on purpose: the host and the control
  -- center are bound together by a composite foreign key added below.
  host_uuid uuid NOT NULL,
  control_center_id text NOT NULL REFERENCES console.control_center(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,4}$'),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected', 'dispatched', 'succeeded', 'failed', 'expired', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK ((status IN ('succeeded', 'failed', 'expired', 'cancelled', 'rejected')) = (completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS console.host_operation_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES console.host_operation(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  phase text NOT NULL
    CHECK (phase IN ('requested', 'approved', 'rejected', 'dispatched', 'succeeded', 'failed', 'expired', 'cancelled')),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'service', 'system')),
  actor_id uuid,
  result text NOT NULL CHECK (length(btrim(result)) BETWEEN 1 AND 64),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_hash text NOT NULL CHECK (event_hash ~ '^sha256:[0-9a-f]{64}$'),
  UNIQUE (operation_id, phase, event_hash)
);

-- A host operation carries both the host and the control center it is scoped
-- to.  Two independent foreign keys would allow those to disagree, letting an
-- operation authorised against one control center execute against a host that
-- belongs to another.  The composite key makes that state unrepresentable.
-- Order matters for re-application: the referencing key must go before the
-- unique key it depends on, or a second run fails on the dependency.
ALTER TABLE console.host_operation
  DROP CONSTRAINT IF EXISTS host_operation_host_uuid_fkey;
ALTER TABLE console.host_operation
  DROP CONSTRAINT IF EXISTS host_operation_host_control_center_fkey;

ALTER TABLE console.host
  DROP CONSTRAINT IF EXISTS host_id_control_center_key;
ALTER TABLE console.host
  ADD CONSTRAINT host_id_control_center_key UNIQUE (id, control_center_id);

ALTER TABLE console.host_operation
  ADD CONSTRAINT host_operation_host_control_center_fkey
  FOREIGN KEY (host_uuid, control_center_id)
  REFERENCES console.host (id, control_center_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS host_cc_status_idx ON console.host (control_center_id, status, host_id);
CREATE INDEX IF NOT EXISTS host_snapshot_received_idx ON console.host_snapshot (received_at DESC);
CREATE INDEX IF NOT EXISTS host_operation_host_idx ON console.host_operation (host_uuid, created_at DESC);
CREATE INDEX IF NOT EXISTS host_operation_cc_status_idx ON console.host_operation (control_center_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS host_operation_event_op_idx ON console.host_operation_event (operation_id, occurred_at);

CREATE OR REPLACE FUNCTION console.host_operation_transition_allowed(from_status text, to_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, console
AS $$
  SELECT (from_status, to_status) IN (
    ('requested', 'approved'),
    ('requested', 'rejected'),
    ('requested', 'cancelled'),
    ('requested', 'expired'),
    ('approved', 'dispatched'),
    ('approved', 'cancelled'),
    ('approved', 'expired'),
    ('dispatched', 'succeeded'),
    ('dispatched', 'failed'),
    ('dispatched', 'expired')
  );
$$;

CREATE OR REPLACE FUNCTION console.enforce_host_operation_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
DECLARE
  mode text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' THEN
      RAISE EXCEPTION 'host operations must be created in the requested state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.request_id <> OLD.request_id
     OR NEW.host_uuid <> OLD.host_uuid
     OR NEW.control_center_id <> OLD.control_center_id
     OR NEW.operation <> OLD.operation
     OR NEW.requested_by <> OLD.requested_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'host operation identity is immutable';
  END IF;

  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed host operation % is immutable', OLD.id;
  END IF;

  -- What an approver approved is exactly what may be dispatched.  Content may
  -- still be edited while the request is under review, but the update that
  -- moves it out of 'requested' may not also rewrite it, and no later update
  -- may touch it at all.  Otherwise a request could be approved as one thing
  -- and dispatched as another.
  IF (OLD.status <> 'requested' OR NEW.status <> 'requested')
     AND (NEW.parameters IS DISTINCT FROM OLD.parameters
          OR NEW.reason IS DISTINCT FROM OLD.reason) THEN
    RAISE EXCEPTION 'reviewed host operation content is immutable';
  END IF;

  IF NEW.status <> OLD.status
     AND NOT console.host_operation_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal host operation transition % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'dispatched' THEN
    SELECT host_control_mode INTO mode FROM console.control_center WHERE id = NEW.control_center_id;
    IF mode IS DISTINCT FROM 'governed-write' THEN
      RAISE EXCEPTION 'control center % is in read-only host_control_mode; dispatch is refused', NEW.control_center_id;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_operation_state_machine ON console.host_operation;
CREATE TRIGGER host_operation_state_machine
  BEFORE INSERT OR UPDATE ON console.host_operation
  FOR EACH ROW EXECUTE FUNCTION console.enforce_host_operation_state();
ALTER TABLE console.host_operation ENABLE ALWAYS TRIGGER host_operation_state_machine;

CREATE OR REPLACE FUNCTION console.reject_host_operation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
BEGIN
  RAISE EXCEPTION 'console.host_operation_event is append-only';
END;
$$;

DROP TRIGGER IF EXISTS host_operation_event_append_only ON console.host_operation_event;
CREATE TRIGGER host_operation_event_append_only
  BEFORE UPDATE OR DELETE ON console.host_operation_event
  FOR EACH ROW EXECUTE FUNCTION console.reject_host_operation_event_mutation();
ALTER TABLE console.host_operation_event ENABLE ALWAYS TRIGGER host_operation_event_append_only;

ALTER TABLE console.host ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.host_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.host_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.host_operation_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS host_read_assigned ON console.host;
CREATE POLICY host_read_assigned ON console.host FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM console.operator_control_center a
    WHERE a.user_id = auth.uid()
      AND a.control_center_id = console.host.control_center_id
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));

DROP POLICY IF EXISTS host_snapshot_read_assigned ON console.host_snapshot;
CREATE POLICY host_snapshot_read_assigned ON console.host_snapshot FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM console.host h
    JOIN console.operator_control_center a ON a.control_center_id = h.control_center_id
    WHERE h.id = console.host_snapshot.host_uuid
      AND a.user_id = auth.uid()
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));

DROP POLICY IF EXISTS host_operation_read_assigned ON console.host_operation;
CREATE POLICY host_operation_read_assigned ON console.host_operation FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM console.operator_control_center a
    WHERE a.user_id = auth.uid()
      AND a.control_center_id = console.host_operation.control_center_id
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));

DROP POLICY IF EXISTS host_operation_event_read_assigned ON console.host_operation_event;
CREATE POLICY host_operation_event_read_assigned ON console.host_operation_event FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM console.host_operation o
    JOIN console.operator_control_center a ON a.control_center_id = o.control_center_id
    WHERE o.id = console.host_operation_event.operation_id
      AND a.user_id = auth.uid()
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));

DROP POLICY IF EXISTS rcc_backend_host ON console.host;
CREATE POLICY rcc_backend_host ON console.host FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rcc_backend_host_snapshot ON console.host_snapshot;
CREATE POLICY rcc_backend_host_snapshot ON console.host_snapshot FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rcc_backend_host_operation ON console.host_operation;
CREATE POLICY rcc_backend_host_operation ON console.host_operation FOR ALL TO opensphere_console_backend
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS rcc_backend_host_operation_event_read ON console.host_operation_event;
CREATE POLICY rcc_backend_host_operation_event_read ON console.host_operation_event FOR SELECT TO opensphere_console_backend
  USING (true);
DROP POLICY IF EXISTS rcc_backend_host_operation_event_insert ON console.host_operation_event;
CREATE POLICY rcc_backend_host_operation_event_insert ON console.host_operation_event FOR INSERT TO opensphere_console_backend
  WITH CHECK (true);

GRANT SELECT ON console.host, console.host_snapshot, console.host_operation,
  console.host_operation_event TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON console.host, console.host_snapshot, console.host_operation,
  console.host_operation_event FROM anon, authenticated;
REVOKE ALL ON console.host, console.host_snapshot, console.host_operation,
  console.host_operation_event FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON console.host, console.host_snapshot,
  console.host_operation TO opensphere_console_backend;
GRANT SELECT, INSERT ON console.host_operation_event TO opensphere_console_backend;
REVOKE UPDATE, DELETE, TRUNCATE ON console.host_operation_event FROM opensphere_console_backend;
-- A completed operation is immutable, and the state machine trigger enforces
-- that on UPDATE. Deletion is the way around it: the row simply stops existing
-- and its history goes with it. Nothing in the backend deletes an operation, so
-- the privilege only exists to be misused.
REVOKE DELETE, TRUNCATE ON console.host_operation FROM opensphere_console_backend;

INSERT INTO console.permission (code, risk_level) VALUES
  ('console.hosts.read', 'low'),
  ('console.hosts.operate', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
WHERE r.code = 'console-admins' AND p.code IN ('console.hosts.read', 'console.hosts.operate')
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p ON p.code = 'console.hosts.read'
WHERE r.code IN ('console-operators', 'console-viewers')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE console.host IS
  'Linux hosts bound to a control center. Stores the agent key id only; agent signing secrets never enter the database.';
COMMENT ON TABLE console.host_snapshot IS
  'Latest bounded read-only snapshot per host. RCC keeps no snapshot history and runs no second time-series store.';
COMMENT ON TABLE console.host_operation IS
  'Host operation state machine. Dispatch is refused while the control center host_control_mode is read-only.';
COMMENT ON TABLE console.host_operation_event IS
  'Append-only immutable result boundary for host operations; pairs with audit.event.';

-- ── Stage 2: governed typed host operations ──
-- Stage 2: governed typed host operations.
--
-- Stage 1 established the host authority and an operation table whose only
-- reachable state was 'requested'.  Stage 2 makes a bounded set of typed
-- operations executable end to end while keeping every safety property that
-- made Stage 1 acceptable:
--
--   * the agent stays outbound-only; the control center never connects to a host
--   * only declared operation types exist; there is no shell or free-form command
--   * high-risk operations need two distinct people, both currently assigned
--   * approval binds the exact content digest, so an edit invalidates it
--   * a lease expiring must never make an already-started operation runnable again
--   * results are immutable and append-only
--
-- The whole migration is idempotent.


-- ── permissions ──────────────────────────────────────────────────────────────
-- Seeded before the operation catalog, which references them by foreign key.
INSERT INTO console.permission (code, risk_level) VALUES
  ('console.hosts.journal', 'medium'),
  ('console.hosts.approve', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
WHERE r.code = 'console-admins'
  AND p.code IN ('console.hosts.journal', 'console.hosts.approve')
ON CONFLICT DO NOTHING;

-- Operators may read the journal.  Restart, reboot and approval stay with
-- administrators; separating request from approval is the point of the control.
INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p ON p.code = 'console.hosts.journal'
WHERE r.code = 'console-operators'
ON CONFLICT DO NOTHING;

-- ── operation catalog ────────────────────────────────────────────────────────
-- The set of executable operations is data, not code, so the database can refuse
-- anything the backend or an agent invents.  Rows are seeded, never user-created.
CREATE TABLE IF NOT EXISTS console.host_operation_type (
  operation text PRIMARY KEY,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  requires_second_person boolean NOT NULL,
  requires_maintenance boolean NOT NULL,
  required_permission text NOT NULL REFERENCES console.permission(code) ON DELETE RESTRICT,
  max_lease_seconds integer NOT NULL CHECK (max_lease_seconds BETWEEN 30 AND 3600),
  description text NOT NULL DEFAULT ''
);

INSERT INTO console.host_operation_type
  (operation, risk_level, requires_second_person, requires_maintenance, required_permission, max_lease_seconds, description)
VALUES
  ('journal.query',   'low',  false, false, 'console.hosts.journal',  120,
   'Read a bounded slice of the systemd journal. Read-only on the host.'),
  ('service.restart', 'high', true,  false, 'console.hosts.operate',  300,
   'Restart one allowlisted systemd unit. The agent refuses units outside its own allowlist.'),
  ('host.reboot',     'high', true,  true,  'console.hosts.operate',  900,
   'Reboot the host after Kubernetes cordon and drain. Proves a boot id change before reporting success.')
ON CONFLICT (operation) DO UPDATE SET
  risk_level = EXCLUDED.risk_level,
  requires_second_person = EXCLUDED.requires_second_person,
  requires_maintenance = EXCLUDED.requires_maintenance,
  required_permission = EXCLUDED.required_permission,
  max_lease_seconds = EXCLUDED.max_lease_seconds,
  description = EXCLUDED.description;

-- ── operation columns ────────────────────────────────────────────────────────
ALTER TABLE console.host_operation
  ADD COLUMN IF NOT EXISTS content_digest text,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_digest text,
  ADD COLUMN IF NOT EXISTS decided_reason text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS not_before timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS result_digest text,
  ADD COLUMN IF NOT EXISTS maintenance jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Digest of the canonical (operation, parameters) content.  Approval binds this
-- exact value, so any edit invalidates the approval rather than silently
-- carrying it forward.
ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_content_digest_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_content_digest_check
  CHECK (content_digest IS NULL OR content_digest ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_approved_digest_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_approved_digest_check
  CHECK (approved_digest IS NULL OR approved_digest ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_result_digest_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_result_digest_check
  CHECK (result_digest IS NULL OR result_digest ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_lease_attempt_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_lease_attempt_check
  CHECK (lease_attempt >= 0 AND lease_attempt <= 100);

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_result_size_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_result_size_check
  CHECK (result IS NULL OR pg_column_size(result) <= 262144);

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_parameters_size_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_parameters_size_check
  CHECK (pg_column_size(parameters) <= 16384);

-- Only catalogued operations may exist.
ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_operation_fkey;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_operation_fkey
  FOREIGN KEY (operation) REFERENCES console.host_operation_type(operation) ON DELETE RESTRICT;

-- ── state machine ────────────────────────────────────────────────────────────
ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_status_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_status_check
  CHECK (status IN (
    'requested', 'awaiting_approval', 'approved', 'preparing', 'dispatchable',
    'leased', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired'
  ));

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_completed_at_check;
ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_completed_at_terminal_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_completed_at_terminal_check
  CHECK ((status IN ('succeeded', 'failed', 'rejected', 'cancelled', 'expired')) = (completed_at IS NOT NULL));

CREATE OR REPLACE FUNCTION console.host_operation_transition_allowed(from_status text, to_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, console
AS $$
  SELECT (from_status, to_status) IN (
    -- request intake
    ('requested', 'awaiting_approval'),
    ('requested', 'approved'),            -- low risk, single-person path
    ('requested', 'rejected'),
    ('requested', 'cancelled'),
    ('requested', 'expired'),
    -- review
    ('awaiting_approval', 'approved'),
    ('awaiting_approval', 'rejected'),
    ('awaiting_approval', 'cancelled'),
    ('awaiting_approval', 'expired'),
    -- Kubernetes maintenance preparation
    ('approved', 'preparing'),
    ('approved', 'dispatchable'),
    ('approved', 'cancelled'),
    ('approved', 'expired'),
    ('preparing', 'dispatchable'),
    ('preparing', 'failed'),              -- preflight refused
    ('preparing', 'cancelled'),
    ('preparing', 'expired'),
    -- dispatch
    ('dispatchable', 'leased'),
    ('dispatchable', 'cancelled'),
    ('dispatchable', 'expired'),
    -- the agent has the plan but has not started work
    ('leased', 'running'),
    ('leased', 'dispatchable'),           -- lease expired before start only
    ('leased', 'cancelled'),
    ('leased', 'expired'),
    -- work has begun; only the agent's receipt may finish it
    ('running', 'succeeded'),
    ('running', 'failed'),
    ('running', 'expired')
  );
$$;

CREATE OR REPLACE FUNCTION console.enforce_host_operation_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
DECLARE
  mode text;
  spec record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' THEN
      RAISE EXCEPTION 'host operations must be created in the requested state';
    END IF;
    IF NEW.content_digest IS NULL THEN
      RAISE EXCEPTION 'host operation must carry a content digest at creation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.request_id <> OLD.request_id
     OR NEW.host_uuid <> OLD.host_uuid
     OR NEW.control_center_id <> OLD.control_center_id
     OR NEW.operation <> OLD.operation
     OR NEW.requested_by <> OLD.requested_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'host operation identity is immutable';
  END IF;

  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed host operation % is immutable', OLD.id;
  END IF;

  -- Reviewed content is frozen: what an approver saw is what runs.
  IF (OLD.status <> 'requested' OR NEW.status <> 'requested')
     AND (NEW.parameters IS DISTINCT FROM OLD.parameters
          OR NEW.reason IS DISTINCT FROM OLD.reason
          OR NEW.content_digest IS DISTINCT FROM OLD.content_digest) THEN
    RAISE EXCEPTION 'reviewed host operation content is immutable';
  END IF;

  IF NEW.status <> OLD.status
     AND NOT console.host_operation_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal host operation transition % -> %', OLD.status, NEW.status;
  END IF;

  SELECT * INTO spec FROM console.host_operation_type WHERE operation = NEW.operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown host operation type %', NEW.operation;
  END IF;

  -- Approval rules.
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'approval must record the approver and time';
    END IF;
    IF NEW.approved_digest IS DISTINCT FROM NEW.content_digest THEN
      RAISE EXCEPTION 'approval must bind the current content digest';
    END IF;
    IF spec.requires_second_person AND NEW.approved_by = NEW.requested_by THEN
      RAISE EXCEPTION 'operation % requires a second person to approve', NEW.operation;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM console.operator_control_center a
      WHERE a.user_id = NEW.approved_by
        AND a.control_center_id = NEW.control_center_id
        AND (a.expires_at IS NULL OR a.expires_at > now())
    ) THEN
      RAISE EXCEPTION 'approver is not currently assigned to control center %', NEW.control_center_id;
    END IF;
  END IF;

  -- Nothing may reach an agent without a binding approval.
  IF NEW.status IN ('preparing', 'dispatchable', 'leased', 'running')
     AND (NEW.approved_by IS NULL OR NEW.approved_digest IS DISTINCT FROM NEW.content_digest) THEN
    RAISE EXCEPTION 'host operation % has no approval bound to its current content', NEW.id;
  END IF;

  -- Maintenance-bearing operations must carry preparation evidence.
  IF NEW.status = 'dispatchable' AND spec.requires_maintenance
     AND COALESCE(NEW.maintenance->>'prepared', 'false') <> 'true' THEN
    RAISE EXCEPTION 'operation % requires completed Kubernetes maintenance preparation', NEW.operation;
  END IF;

  -- A lease may only be handed out from dispatchable, and must be bounded.
  IF NEW.status = 'leased' AND OLD.status <> 'leased' THEN
    IF NEW.lease_owner IS NULL OR NEW.lease_expires_at IS NULL THEN
      RAISE EXCEPTION 'lease must record an owner and an expiry';
    END IF;
    IF NEW.lease_attempt <= OLD.lease_attempt THEN
      RAISE EXCEPTION 'each lease must use a new attempt number';
    END IF;
    IF NEW.lease_expires_at > now() + make_interval(secs => spec.max_lease_seconds) THEN
      RAISE EXCEPTION 'lease for % exceeds its maximum of % seconds', NEW.operation, spec.max_lease_seconds;
    END IF;
  END IF;

  -- Guarding only the entry edge would leave the bound trivially escapable: an
  -- UPDATE that leaves the row leased could hand it to a different owner, or
  -- push the expiry out arbitrarily, without ever crossing into 'leased'. The
  -- lease is what stops a second executor picking the same work up, so it is
  -- fixed for as long as it is held.
  IF OLD.status IN ('leased', 'running') AND NEW.status IN ('leased', 'running') THEN
    IF NEW.lease_attempt IS DISTINCT FROM OLD.lease_attempt THEN
      RAISE EXCEPTION 'the attempt number of a held lease cannot change';
    END IF;
    IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner THEN
      RAISE EXCEPTION 'a held lease cannot change owner';
    END IF;
    IF NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
      RAISE EXCEPTION 'a held lease cannot be extended';
    END IF;
  END IF;

  -- Returning a started operation to the queue would risk a second execution.
  IF OLD.status = 'running' AND NEW.status = 'dispatchable' THEN
    RAISE EXCEPTION 'a started host operation can never become dispatchable again';
  END IF;
  IF OLD.status = 'leased' AND NEW.status = 'dispatchable' AND OLD.started_at IS NOT NULL THEN
    RAISE EXCEPTION 'lease expiry cannot requeue an operation that already started';
  END IF;

  IF NEW.status = 'running' AND NEW.started_at IS NULL THEN
    RAISE EXCEPTION 'a running host operation must record started_at';
  END IF;
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'started_at is immutable once set';
  END IF;

  -- The attempt that reports a result must be the attempt that was leased.
  IF NEW.status IN ('succeeded', 'failed') AND NEW.result IS NULL THEN
    RAISE EXCEPTION 'a finished host operation must carry its result receipt';
  END IF;
  IF NEW.result IS NOT NULL AND NEW.result_digest IS NULL THEN
    RAISE EXCEPTION 'a stored result must carry its digest';
  END IF;
  -- A receipt names the attempt it belongs to. Filing one against a different
  -- attempt is how a result from a lease that was already superseded gets
  -- recorded as the outcome of the current one. Results the platform generates
  -- itself — a refused maintenance preparation, say — carry no attempt, and
  -- there is nothing to check.
  IF NEW.result ? 'attempt'
     AND (NEW.result->>'attempt') IS DISTINCT FROM NEW.lease_attempt::text THEN
    RAISE EXCEPTION 'a receipt from attempt % cannot be filed against attempt %',
      NEW.result->>'attempt', NEW.lease_attempt;
  END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'host operation results are immutable';
  END IF;
  -- The digest is what pins the bytes the agent signed. Leaving it out of the
  -- immutability rule would let the stored result stay put while the thing that
  -- proves it is what arrived was rewritten.
  IF OLD.result_digest IS NOT NULL AND NEW.result_digest IS DISTINCT FROM OLD.result_digest THEN
    RAISE EXCEPTION 'a stored result digest cannot be rewritten';
  END IF;

  -- Stage boundary: a read-only control center never dispatches anything.
  IF NEW.status IN ('dispatchable', 'leased', 'running') THEN
    SELECT host_control_mode INTO mode FROM console.control_center WHERE id = NEW.control_center_id;
    IF mode IS DISTINCT FROM 'governed-write' THEN
      RAISE EXCEPTION 'control center % is in read-only host_control_mode; dispatch is refused', NEW.control_center_id;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_operation_state_machine ON console.host_operation;
CREATE TRIGGER host_operation_state_machine
  BEFORE INSERT OR UPDATE ON console.host_operation
  FOR EACH ROW EXECUTE FUNCTION console.enforce_host_operation_state();
ALTER TABLE console.host_operation ENABLE ALWAYS TRIGGER host_operation_state_machine;

-- ── concurrency ──────────────────────────────────────────────────────────────
-- One host runs at most one operation at a time.  A partial unique index makes a
-- second concurrent dispatch impossible even if two backends race.
-- Not dropped and recreated: a re-run of this migration would then spend the
-- rebuild with no single-active guarantee at all, which is precisely the window
-- in which two backends could both dispatch.
CREATE UNIQUE INDEX IF NOT EXISTS host_operation_single_active_idx
  ON console.host_operation (host_uuid)
  WHERE status IN ('preparing', 'dispatchable', 'leased', 'running');

CREATE INDEX IF NOT EXISTS host_operation_dispatch_idx
  ON console.host_operation (control_center_id, host_uuid, status, created_at);

-- ── append-only events ───────────────────────────────────────────────────────
ALTER TABLE console.host_operation_event DROP CONSTRAINT IF EXISTS host_operation_event_phase_check;
ALTER TABLE console.host_operation_event ADD CONSTRAINT host_operation_event_phase_check
  CHECK (phase IN (
    'requested', 'awaiting_approval', 'approved', 'preparing', 'dispatchable',
    'leased', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired',
    'maintenance.cordon', 'maintenance.drain', 'maintenance.uncordon', 'maintenance.refused'
  ));

ALTER TABLE console.host_operation_event DROP CONSTRAINT IF EXISTS host_operation_event_detail_size_check;
ALTER TABLE console.host_operation_event ADD CONSTRAINT host_operation_event_detail_size_check
  CHECK (pg_column_size(detail) <= 65536);

-- ── catalog exposure ─────────────────────────────────────────────────────────
GRANT SELECT ON console.host_operation_type TO authenticated;
GRANT SELECT ON console.host_operation_type TO opensphere_console_backend;
REVOKE INSERT, UPDATE, DELETE ON console.host_operation_type FROM anon, authenticated;
REVOKE ALL ON console.host_operation_type FROM anon;
-- Explicit, because migration 0002 sets ALTER DEFAULT PRIVILEGES granting the
-- backend role full DML on every table created in this schema afterwards. That
-- default does not exist on a clean install from the consolidated baseline, so
-- without this line an upgraded region and a fresh one disagree about whether
-- the backend can rewrite the operation catalogue — the closed list of what
-- this platform can do to a host, including each entry's lease bound and
-- whether it needs a second approver.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON console.host_operation_type FROM opensphere_console_backend;

ALTER TABLE console.host_operation_type ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS host_operation_type_read ON console.host_operation_type;
CREATE POLICY host_operation_type_read ON console.host_operation_type FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS rcc_backend_host_operation_type ON console.host_operation_type;
CREATE POLICY rcc_backend_host_operation_type ON console.host_operation_type FOR SELECT
  TO opensphere_console_backend USING (true);

COMMENT ON TABLE console.host_operation_type IS
  'Closed catalog of executable host operations. There is no arbitrary command type and no shell.';
COMMENT ON COLUMN console.host_operation.content_digest IS
  'sha256 of the canonical (operation, parameters) content. Approval binds this value so an edit invalidates approval.';
COMMENT ON COLUMN console.host_operation.lease_attempt IS
  'Monotonic attempt counter. A receipt is accepted only for the attempt that was leased, giving exactly-once semantics.';
COMMENT ON COLUMN console.host_operation.maintenance IS
  'Kubernetes maintenance evidence: node, preflight findings, cordon/drain state. Never contains credentials.';

-- Host maintenance recovery and post-review immutability
-- (mirrors backend/supabase/migrations/0029_host_maintenance_recovery.sql)

-- ── durable degradation state ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS console.host_maintenance_degradation (
  host_uuid uuid PRIMARY KEY REFERENCES console.host(id) ON DELETE RESTRICT,
  control_center_id text NOT NULL,
  operation_id uuid REFERENCES console.host_operation(id) ON DELETE RESTRICT,
  node text NOT NULL CHECK (length(btrim(node)) BETWEEN 1 AND 253),
  code text NOT NULL CHECK (code IN ('uncordon-failed')),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 2000),
  detected_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  -- Automatic recovery is bounded. Past the bound this is a human's problem,
  -- and pretending otherwise would retry forever while the node stays unusable.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  escalated boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  resolution text CHECK (resolution IS NULL OR resolution IN ('automatic', 'manual')),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

CREATE INDEX IF NOT EXISTS host_maintenance_degradation_open_idx
  ON console.host_maintenance_degradation (control_center_id)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE console.host_maintenance_degradation IS
  'Open maintenance degradations, one row per host. A node left cordoned by a failed uncordon is recorded here so it can be retried, escalated, and used to refuse further disruptive work on that host.';

GRANT SELECT ON console.host_maintenance_degradation TO authenticated;
GRANT SELECT, INSERT, UPDATE ON console.host_maintenance_degradation TO opensphere_console_backend;
REVOKE INSERT, UPDATE, DELETE ON console.host_maintenance_degradation FROM anon, authenticated;
REVOKE ALL ON console.host_maintenance_degradation FROM anon;
-- Explicit, because migration 0002 sets ALTER DEFAULT PRIVILEGES granting the
-- backend role DELETE on every table created in this schema afterwards, and a
-- clean install from the consolidated baseline carries no such default. Without
-- this the two install paths disagree, and on the upgraded one "a resolved
-- degradation is history" would hold only until somebody deleted the row.
REVOKE DELETE, TRUNCATE ON console.host_maintenance_degradation FROM opensphere_console_backend;

ALTER TABLE console.host_maintenance_degradation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS host_maintenance_degradation_read ON console.host_maintenance_degradation;
-- Scoped to the reader's own control centers, like console.host itself. A
-- degradation names a cordoned Kubernetes node, and an operator with no
-- assignment to that region has no reason to learn its node names.
CREATE POLICY host_maintenance_degradation_read ON console.host_maintenance_degradation
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM console.operator_control_center a
    WHERE a.user_id = auth.uid()
      AND a.control_center_id = console.host_maintenance_degradation.control_center_id
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));
DROP POLICY IF EXISTS rcc_backend_host_maintenance_degradation ON console.host_maintenance_degradation;
CREATE POLICY rcc_backend_host_maintenance_degradation ON console.host_maintenance_degradation
  FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);

-- A resolved degradation is history. Reopening the same row would lose when the
-- first one happened, so resolution is one-way.
CREATE OR REPLACE FUNCTION console.host_maintenance_degradation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'a resolved maintenance degradation cannot be reopened';
  END IF;
  IF NEW.host_uuid <> OLD.host_uuid OR NEW.detected_at <> OLD.detected_at THEN
    RAISE EXCEPTION 'the identity and detection time of a degradation are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_maintenance_degradation_guard ON console.host_maintenance_degradation;
CREATE TRIGGER host_maintenance_degradation_guard
  BEFORE UPDATE ON console.host_maintenance_degradation
  FOR EACH ROW EXECUTE FUNCTION console.host_maintenance_degradation_guard();
-- ALWAYS, not the default ORIGIN: a session that sets session_replication_role
-- to 'replica' would otherwise silently switch this guard off, and so would any
-- logical-replication apply worker.
ALTER TABLE console.host_maintenance_degradation
  ENABLE ALWAYS TRIGGER host_maintenance_degradation_guard;

-- ── parameters are immutable once review has begun ───────────────────────────

CREATE OR REPLACE FUNCTION console.host_operation_content_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- `requested` is the only state in which the content is still being decided.
  IF OLD.status = 'requested' THEN
    RETURN NEW;
  END IF;
  IF NEW.operation IS DISTINCT FROM OLD.operation THEN
    RAISE EXCEPTION 'the operation of a reviewed request cannot change';
  END IF;
  IF NEW.parameters IS DISTINCT FROM OLD.parameters THEN
    RAISE EXCEPTION 'the parameters of a reviewed request cannot change';
  END IF;
  IF NEW.content_digest IS DISTINCT FROM OLD.content_digest THEN
    RAISE EXCEPTION 'the content digest of a reviewed request cannot change';
  END IF;
  -- An approval, once recorded, describes what was actually approved.
  IF OLD.approved_digest IS NOT NULL AND NEW.approved_digest IS DISTINCT FROM OLD.approved_digest THEN
    RAISE EXCEPTION 'the approved digest cannot be rewritten';
  END IF;
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'the approver of a request cannot be rewritten';
  END IF;
  -- The policy binding is part of what was approved. The dispatch guard refuses
  -- an operation whose bound policy_version is no longer current, and that
  -- check is worth nothing if the binding itself can be re-pointed at the new
  -- version just before dispatch. Freezing it here is what makes "an approval
  -- does not survive a policy edit" a property of the database.
  IF OLD.policy_id IS NOT NULL AND NEW.policy_id IS DISTINCT FROM OLD.policy_id THEN
    RAISE EXCEPTION 'the policy a request was approved under cannot be rewritten';
  END IF;
  IF OLD.policy_version IS NOT NULL AND NEW.policy_version IS DISTINCT FROM OLD.policy_version THEN
    RAISE EXCEPTION 'the policy version a request was approved under cannot be rewritten';
  END IF;
  -- policy_window_id is deliberately not frozen: it records which window
  -- instance permitted the *dispatch*, which is re-evaluated each time and is
  -- legitimately a different window from the one the request was made in.
  IF NEW.policy_emergency IS DISTINCT FROM OLD.policy_emergency THEN
    RAISE EXCEPTION 'whether a request was an emergency cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_operation_content_immutable ON console.host_operation;
CREATE TRIGGER host_operation_content_immutable
  BEFORE UPDATE ON console.host_operation
  FOR EACH ROW EXECUTE FUNCTION console.host_operation_content_immutable();
-- ALWAYS, not the default ORIGIN: session_replication_role = 'replica' would
-- otherwise switch off the guard that makes an approval mean something.
ALTER TABLE console.host_operation
  ENABLE ALWAYS TRIGGER host_operation_content_immutable;

COMMENT ON FUNCTION console.host_operation_content_immutable() IS
  'Refuses any edit to what was approved once a request has left `requested`. The application also compares digests; this makes the guarantee independent of it.';

-- ── the degradation itself is a journal entry ────────────────────────────────

ALTER TABLE console.host_operation_event DROP CONSTRAINT IF EXISTS host_operation_event_phase_check;
ALTER TABLE console.host_operation_event ADD CONSTRAINT host_operation_event_phase_check
  CHECK (phase IN (
    'requested', 'awaiting_approval', 'approved', 'preparing', 'dispatchable',
    'leased', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired',
    'maintenance.cordon', 'maintenance.drain', 'maintenance.uncordon',
    'maintenance.refused', 'maintenance.degraded'
  ));

-- ── the restart allowlist is enrolment configuration, not a host claim ───────
--
-- The agent reports the allowlist it will honour, and it enforces that list
-- itself. But a reported list is the host describing its own authority, and the
-- console must not present it to an operator as if the platform had granted it.
-- A compromised or misconfigured agent that reported every unit on the machine
-- would otherwise render a console full of legitimate-looking restart buttons.
--
-- So the authoritative list is recorded here at enrolment. The agent's own copy
-- still constrains it independently: both must permit a unit for it to restart.

ALTER TABLE console.host
  ADD COLUMN IF NOT EXISTS restart_allowlist text[] NOT NULL DEFAULT '{}'::text[];

-- A CHECK cannot contain a subquery, so the per-element test lives in an
-- IMMUTABLE function the constraint can call.
CREATE OR REPLACE FUNCTION console.restart_allowlist_is_valid(units text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT units IS NULL
      OR coalesce(array_length(units, 1), 0) = 0
      OR (array_length(units, 1) <= 64
          AND array_length(units, 1) = (
            SELECT count(*) FROM unnest(units) AS unit
            WHERE unit ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$'
          ));
$$;

ALTER TABLE console.host DROP CONSTRAINT IF EXISTS host_restart_allowlist_check;
ALTER TABLE console.host ADD CONSTRAINT host_restart_allowlist_check
  CHECK (console.restart_allowlist_is_valid(restart_allowlist));

COMMENT ON COLUMN console.host.restart_allowlist IS
  'Units this control center permits restarting on this host. Authoritative: the console gates on this, never on the units the agent reports.';

-- Stage 3: package/kernel maintenance and maintenance-window policy
-- (mirrors backend/supabase/migrations/0030_host_maintenance_policy.sql)

-- ── the operations themselves ────────────────────────────────────────────────

ALTER TABLE console.host_operation_type
  ADD COLUMN IF NOT EXISTS requires_policy boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN console.host_operation_type.requires_policy IS
  'Whether this operation may only run inside an approved maintenance window. Operations with this set are refused outright on a host with no policy.';

-- ── permission ───────────────────────────────────────────────────────────────

INSERT INTO console.permission (code, risk_level) VALUES
  ('console.hosts.packages', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

-- Requesting package maintenance is an administrator action. Approving it still
-- needs console.hosts.approve, held by a different person: separating the
-- request from the approval is the entire point of the control.
INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
WHERE r.code = 'console-admins'
  AND p.code = 'console.hosts.packages'
ON CONFLICT DO NOTHING;

INSERT INTO console.host_operation_type
  (operation, risk_level, requires_second_person, requires_maintenance, required_permission,
   max_lease_seconds, description, requires_policy)
VALUES
  ('package.refresh', 'low',  false, false, 'console.hosts.packages',  300,
   'Refresh the local package index. Installs nothing and changes no installed package.', true),
  ('package.update',  'high', true,  false, 'console.hosts.packages',  1800,
   'Upgrade an explicitly named, allowlisted set of packages. Never removes a package and never touches a package the cluster depends on.', true),
  ('kernel.update',   'high', true,  false, 'console.hosts.packages',  1800,
   'Install a kernel image. Never reboots: the running kernel is unchanged until host.reboot is separately requested and approved.', true)
ON CONFLICT (operation) DO UPDATE SET
  risk_level = EXCLUDED.risk_level,
  requires_second_person = EXCLUDED.requires_second_person,
  requires_maintenance = EXCLUDED.requires_maintenance,
  required_permission = EXCLUDED.required_permission,
  max_lease_seconds = EXCLUDED.max_lease_seconds,
  description = EXCLUDED.description,
  requires_policy = EXCLUDED.requires_policy;

-- The event journal gains the phases policy evaluation produces.
ALTER TABLE console.host_operation_event DROP CONSTRAINT IF EXISTS host_operation_event_phase_check;
ALTER TABLE console.host_operation_event ADD CONSTRAINT host_operation_event_phase_check
  CHECK (phase IN (
    'requested', 'awaiting_approval', 'approved', 'preparing', 'dispatchable',
    'leased', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired',
    'maintenance.cordon', 'maintenance.drain', 'maintenance.uncordon',
    'maintenance.refused', 'maintenance.degraded',
    'policy.evaluated', 'policy.refused', 'policy.superseded'
  ));

-- ── host policy ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS console.host_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_center_id text NOT NULL REFERENCES console.control_center(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128),
  -- A policy either targets one host or every host in the control center.
  -- Precedence is decided by this column alone, so it cannot be ambiguous:
  -- a host-scoped policy always wins over a control-center-scoped one.
  host_uuid uuid REFERENCES console.host(id) ON DELETE RESTRICT,
  scope text GENERATED ALWAYS AS (CASE WHEN host_uuid IS NULL THEN 'control-center' ELSE 'host' END) STORED,

  -- Incremented by the database on every substantive edit. An approval binds
  -- this number, so changing the policy invalidates work approved under it.
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Bumped by the window trigger. It exists so a window edit is a substantive
  -- change to *this* row, which is what makes the version guard notice it: the
  -- guard recomputes `version` itself, so a trigger that set `version` directly
  -- would simply have its value overwritten.
  window_revision integer NOT NULL DEFAULT 0 CHECK (window_revision >= 0),

  -- An IANA zone name. Windows are declared in local time and resolved against
  -- this zone, so "every Sunday 02:00-04:00" stays at 02:00 local across a DST
  -- transition instead of drifting by an hour twice a year.
  timezone text NOT NULL CHECK (length(btrim(timezone)) BETWEEN 1 AND 64),

  -- Operations this policy permits. An operation absent from this list is
  -- refused even inside a window: a window is when, not what.
  allowed_operations text[] NOT NULL DEFAULT '{}'::text[],

  -- Whether an emergency request may bypass the *window*. It never bypasses
  -- approval, AAL2, the two-person rule, or any Kubernetes safety gate; those
  -- are not window questions and there is no column here that touches them.
  emergency_allowed boolean NOT NULL DEFAULT false,
  emergency_requires_second_person boolean NOT NULL DEFAULT true,

  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One policy per scope. Two policies claiming the same host would make
  -- precedence a question of ordering, which is how a deny becomes an allow.
  CONSTRAINT host_policy_unique_host UNIQUE (control_center_id, host_uuid)
);

-- A control-center-wide policy has a NULL host_uuid, which a UNIQUE constraint
-- does not constrain. This does.
CREATE UNIQUE INDEX IF NOT EXISTS host_policy_one_default_per_cc
  ON console.host_policy (control_center_id)
  WHERE host_uuid IS NULL;

COMMENT ON TABLE console.host_policy IS
  'When a host may be disturbed by package and kernel maintenance. Default-deny: a host with no policy accepts none of it.';
COMMENT ON COLUMN console.host_policy.version IS
  'Bumped by trigger on every substantive edit. Approvals bind this number, so editing a policy invalidates work approved under the previous one.';
COMMENT ON COLUMN console.host_policy.emergency_allowed IS
  'Whether an emergency request may run outside a window. It never relaxes approval, assurance level, the two-person rule, or any Kubernetes gate.';

-- ── maintenance windows ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS console.host_maintenance_window (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES console.host_policy(id) ON DELETE CASCADE,

  -- 0 = Sunday, matching PostgreSQL's `dow`.
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  -- Local wall-clock time in the policy's timezone.
  start_time time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1440),

  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (policy_id, day_of_week, start_time)
);

COMMENT ON TABLE console.host_maintenance_window IS
  'Recurring local-time windows. Stored as day-of-week plus wall-clock start so a window keeps its local meaning across daylight-saving transitions.';

GRANT SELECT ON console.host_policy TO authenticated;
GRANT SELECT ON console.host_maintenance_window TO authenticated;
GRANT SELECT ON console.host_policy TO opensphere_console_backend;
GRANT SELECT ON console.host_maintenance_window TO opensphere_console_backend;
REVOKE INSERT, UPDATE, DELETE ON console.host_policy FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON console.host_maintenance_window FROM anon, authenticated;
REVOKE ALL ON console.host_policy FROM anon;
REVOKE ALL ON console.host_maintenance_window FROM anon;
-- The backend reads a policy to decide whether an operation may run and never
-- writes one: there is no API, no route and no UI that edits a policy, by
-- design. Making that a privilege rather than an observation about the current
-- code means a compromised backend cannot widen the rules it is being judged
-- by — which matters more here than usual, because a policy edit is the one
-- change on this surface that does not itself go through approval.
--
-- These REVOKEs are also what keeps the two install paths honest: migration
-- 0002 sets default privileges that would otherwise hand the backend full DML
-- on both tables the moment they are created.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON console.host_policy FROM opensphere_console_backend;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON console.host_maintenance_window FROM opensphere_console_backend;

ALTER TABLE console.host_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.host_maintenance_window ENABLE ROW LEVEL SECURITY;

-- Reads are scoped to the operator's own control centers, the same rule
-- console.host itself uses. A policy row names the operations, container image
-- digests and mount roots a region permits, and a window says when that region
-- is disturbable; neither is something an operator with no assignment to that
-- region has any reason to enumerate.
DROP POLICY IF EXISTS host_policy_read ON console.host_policy;
CREATE POLICY host_policy_read ON console.host_policy FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM console.operator_control_center a
    WHERE a.user_id = auth.uid()
      AND a.control_center_id = console.host_policy.control_center_id
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));
DROP POLICY IF EXISTS rcc_backend_host_policy ON console.host_policy;
CREATE POLICY rcc_backend_host_policy ON console.host_policy
  FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS host_window_read ON console.host_maintenance_window;
CREATE POLICY host_window_read ON console.host_maintenance_window FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM console.host_policy p
    JOIN console.operator_control_center a ON a.control_center_id = p.control_center_id
    WHERE p.id = console.host_maintenance_window.policy_id
      AND a.user_id = auth.uid()
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));
DROP POLICY IF EXISTS rcc_backend_host_window ON console.host_maintenance_window;
CREATE POLICY rcc_backend_host_window ON console.host_maintenance_window
  FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);

-- ── the timezone must be real ────────────────────────────────────────────────

-- A policy whose timezone PostgreSQL cannot resolve would silently fall back to
-- something, and "silently falls back" is exactly what a maintenance window must
-- never do. The check runs against the server's own zone database, which is the
-- same one the window evaluation uses.
CREATE OR REPLACE FUNCTION console.timezone_is_known(zone text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM now() AT TIME ZONE zone;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE console.host_policy DROP CONSTRAINT IF EXISTS host_policy_timezone_check;
ALTER TABLE console.host_policy ADD CONSTRAINT host_policy_timezone_check
  CHECK (console.timezone_is_known(timezone));

-- ── the allowed-operations list must name real operations ────────────────────

CREATE OR REPLACE FUNCTION console.host_policy_operations_valid(operations text[])
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, console
AS $$
  SELECT operations IS NULL
      OR coalesce(array_length(operations, 1), 0) = 0
      OR (array_length(operations, 1) <= 16
          AND array_length(operations, 1) = (
            SELECT count(DISTINCT op) FROM unnest(operations) AS op
            WHERE op IN (SELECT operation FROM console.host_operation_type)
          ));
$$;

ALTER TABLE console.host_policy DROP CONSTRAINT IF EXISTS host_policy_operations_check;
ALTER TABLE console.host_policy ADD CONSTRAINT host_policy_operations_check
  CHECK (console.host_policy_operations_valid(allowed_operations));

-- ── versioning ───────────────────────────────────────────────────────────────

-- The version is the database's own count of substantive changes. The
-- application cannot set it, so an approval bound to version 7 cannot be made
-- to look current by an edit that forgets to bump it.
CREATE OR REPLACE FUNCTION console.host_policy_version_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    RETURN NEW;
  END IF;

  IF NEW.control_center_id IS DISTINCT FROM OLD.control_center_id
     OR NEW.host_uuid IS DISTINCT FROM OLD.host_uuid THEN
    RAISE EXCEPTION 'the scope of a policy is immutable; create a new policy instead';
  END IF;

  IF NEW.timezone IS DISTINCT FROM OLD.timezone
     OR NEW.allowed_operations IS DISTINCT FROM OLD.allowed_operations
     OR NEW.emergency_allowed IS DISTINCT FROM OLD.emergency_allowed
     OR NEW.emergency_requires_second_person IS DISTINCT FROM OLD.emergency_requires_second_person
     OR NEW.enabled IS DISTINCT FROM OLD.enabled
     OR NEW.window_revision IS DISTINCT FROM OLD.window_revision THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_policy_version_guard ON console.host_policy;
CREATE TRIGGER host_policy_version_guard
  BEFORE INSERT OR UPDATE ON console.host_policy
  FOR EACH ROW EXECUTE FUNCTION console.host_policy_version_guard();
-- ALWAYS, not the default ORIGIN: session_replication_role = 'replica' would
-- otherwise switch this guard off, silently, for any session that set it.
ALTER TABLE console.host_policy ENABLE ALWAYS TRIGGER host_policy_version_guard;

-- ── what a policy edit leaves behind ─────────────────────────────────────────
--
-- A policy is permanent configuration, and this platform has no API that edits
-- one: it is written by a database administrator with direct SQL. That is a
-- deliberate boundary and it is stated as such in the manual, but a change made
-- that way would otherwise leave nothing except a higher version number — no
-- record of who, when, or what moved.
--
-- This is not approval. Nobody is asked. It is evidence, so that a widened
-- allowlist can be found afterwards and attributed, and so the claim "policy
-- changes are controlled by permission and audit" is not made without something
-- behind it.

CREATE TABLE IF NOT EXISTS console.host_policy_change (
  id bigserial PRIMARY KEY,
  policy_id uuid NOT NULL,
  control_center_id text NOT NULL,
  -- The version this edit produced, so a change lines up with the approvals it
  -- invalidated.
  version integer NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  -- The database session that did it. There is no application identity to
  -- record because no application makes this change.
  changed_by text NOT NULL DEFAULT current_user,
  before jsonb,
  after jsonb
);

CREATE INDEX IF NOT EXISTS host_policy_change_policy_idx
  ON console.host_policy_change (policy_id, changed_at DESC);

COMMENT ON TABLE console.host_policy_change IS
  'Append-only record of every edit to a maintenance policy. Policies have no write API and are changed by direct SQL; this is the evidence that such a change happened, not an approval of it.';

CREATE OR REPLACE FUNCTION console.host_policy_change_record()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO console.host_policy_change
      (policy_id, control_center_id, version, action, before)
    VALUES (OLD.id, OLD.control_center_id, OLD.version, 'deleted', to_jsonb(OLD));
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO console.host_policy_change
      (policy_id, control_center_id, version, action, after)
    VALUES (NEW.id, NEW.control_center_id, NEW.version, 'created', to_jsonb(NEW));
    RETURN NEW;
  END IF;
  -- An UPDATE that changed nothing substantive is not an edit worth recording;
  -- the version guard is the authority on what "substantive" means, so this
  -- follows it rather than keeping a second opinion.
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    INSERT INTO console.host_policy_change
      (policy_id, control_center_id, version, action, before, after)
    VALUES (NEW.id, NEW.control_center_id, NEW.version, 'updated',
            to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_policy_change_record ON console.host_policy;
CREATE TRIGGER host_policy_change_record
  AFTER INSERT OR UPDATE OR DELETE ON console.host_policy
  FOR EACH ROW EXECUTE FUNCTION console.host_policy_change_record();
ALTER TABLE console.host_policy ENABLE ALWAYS TRIGGER host_policy_change_record;

CREATE OR REPLACE FUNCTION console.reject_host_policy_change_mutation()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
BEGIN
  RAISE EXCEPTION 'console.host_policy_change is append-only';
END;
$$;

DROP TRIGGER IF EXISTS host_policy_change_append_only ON console.host_policy_change;
CREATE TRIGGER host_policy_change_append_only
  BEFORE UPDATE OR DELETE ON console.host_policy_change
  FOR EACH ROW EXECUTE FUNCTION console.reject_host_policy_change_mutation();
ALTER TABLE console.host_policy_change
  ENABLE ALWAYS TRIGGER host_policy_change_append_only;

ALTER TABLE console.host_policy_change ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS host_policy_change_read ON console.host_policy_change;
CREATE POLICY host_policy_change_read ON console.host_policy_change FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM console.operator_control_center a
    WHERE a.user_id = auth.uid()
      AND a.control_center_id = console.host_policy_change.control_center_id
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));
DROP POLICY IF EXISTS rcc_backend_host_policy_change ON console.host_policy_change;
CREATE POLICY rcc_backend_host_policy_change ON console.host_policy_change
  FOR SELECT TO opensphere_console_backend USING (true);

GRANT SELECT ON console.host_policy_change TO authenticated;
GRANT SELECT ON console.host_policy_change TO opensphere_console_backend;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON console.host_policy_change
  FROM anon, authenticated, opensphere_console_backend;
REVOKE ALL ON console.host_policy_change FROM anon;

-- Editing a window changes when the host may be disturbed, which is exactly the
-- kind of change an approval must not survive. So window edits bump the policy
-- version too.
CREATE OR REPLACE FUNCTION console.host_window_bumps_policy()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
DECLARE
  target uuid;
BEGIN
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.policy_id ELSE NEW.policy_id END;
  -- Touch window_revision, not version: the BEFORE trigger on host_policy owns
  -- the version number and would overwrite anything set here.
  UPDATE console.host_policy
     SET window_revision = window_revision + 1
   WHERE id = target;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS host_window_bumps_policy ON console.host_maintenance_window;
CREATE TRIGGER host_window_bumps_policy
  AFTER INSERT OR UPDATE OR DELETE ON console.host_maintenance_window
  FOR EACH ROW EXECUTE FUNCTION console.host_window_bumps_policy();
ALTER TABLE console.host_maintenance_window ENABLE ALWAYS TRIGGER host_window_bumps_policy;

-- ── window evaluation ────────────────────────────────────────────────────────

-- Resolves the window occurrence covering an instant, in the policy's own zone.
--
-- Working in local time is what makes this daylight-saving-safe. A window
-- declared as Sunday 02:00 for two hours is Sunday 02:00 local in March and in
-- November; converting it to a fixed UTC offset once would move it by an hour
-- for half the year. The comparison happens after `AT TIME ZONE` has already
-- resolved the offset for that specific date.
--
-- The lookback covers windows that started on the previous local day and are
-- still open, so a 23:00 window lasting four hours still contains 01:00.
CREATE OR REPLACE FUNCTION console.host_policy_window_at(
  p_policy_id uuid,
  p_at timestamptz
)
RETURNS TABLE (window_id uuid, window_start timestamptz, window_end timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, console
AS $$
DECLARE
  zone text;
BEGIN
  SELECT timezone INTO zone FROM console.host_policy
   WHERE id = p_policy_id AND enabled;
  IF zone IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH local_now AS (
    SELECT (p_at AT TIME ZONE zone) AS local_ts
  ),
  candidate_days AS (
    -- Today and yesterday in local time. A window that began yesterday and is
    -- still running must still be found.
    SELECT (SELECT local_ts FROM local_now)::date - offset_days AS local_day
      FROM generate_series(0, 1) AS offset_days
  ),
  occurrences AS (
    SELECT w.id AS window_id,
           ((c.local_day + w.start_time) AT TIME ZONE zone) AS starts_at,
           ((c.local_day + w.start_time) AT TIME ZONE zone)
             + make_interval(mins => w.duration_minutes) AS ends_at
      FROM console.host_maintenance_window w
      JOIN candidate_days c ON extract(dow FROM c.local_day) = w.day_of_week
     WHERE w.policy_id = p_policy_id AND w.enabled
  )
  SELECT o.window_id, o.starts_at, o.ends_at
    FROM occurrences o
   WHERE p_at >= o.starts_at AND p_at < o.ends_at
   ORDER BY o.ends_at DESC
   LIMIT 1;
END;
$$;

COMMENT ON FUNCTION console.host_policy_window_at(uuid, timestamptz) IS
  'The window occurrence covering an instant, resolved in the policy timezone so a recurring local-time window keeps its meaning across DST transitions.';

-- Resolves which policy governs a host. Host-scoped beats control-center-scoped;
-- there is never more than one of each, so the answer is always unambiguous.
CREATE OR REPLACE FUNCTION console.host_effective_policy(p_host_uuid uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, console
AS $$
  SELECT p.id
    FROM console.host_policy p
    JOIN console.host h ON h.id = p_host_uuid
   WHERE p.enabled
     AND p.control_center_id = h.control_center_id
     AND (p.host_uuid = p_host_uuid OR p.host_uuid IS NULL)
   ORDER BY (p.host_uuid IS NOT NULL) DESC
   LIMIT 1;
$$;

COMMENT ON FUNCTION console.host_effective_policy(uuid) IS
  'The policy governing a host: its own if it has one, otherwise the control center default. NULL means no policy, which is a refusal, not a permission.';

-- ── the operation carries the policy it was approved under ───────────────────

ALTER TABLE console.host_operation
  ADD COLUMN IF NOT EXISTS policy_id uuid REFERENCES console.host_policy(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS policy_version integer,
  ADD COLUMN IF NOT EXISTS policy_emergency boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS policy_window_id uuid REFERENCES console.host_maintenance_window(id) ON DELETE SET NULL;

COMMENT ON COLUMN console.host_operation.policy_version IS
  'The policy version this operation was approved under. A later version means the approval no longer describes the rules in force.';

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_policy_pair_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_policy_pair_check
  CHECK ((policy_id IS NULL) = (policy_version IS NULL));

-- An operation that needs a policy must have one before it can be dispatched.
-- Enforcing it here means an application bug cannot dispatch ungoverned work.
CREATE OR REPLACE FUNCTION console.host_operation_policy_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
DECLARE
  needs_policy boolean;
  current_version integer;
BEGIN
  SELECT requires_policy INTO needs_policy
    FROM console.host_operation_type WHERE operation = NEW.operation;

  IF NOT coalesce(needs_policy, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('preparing', 'dispatchable', 'leased', 'running') THEN
    IF NEW.policy_id IS NULL THEN
      RAISE EXCEPTION 'operation % requires a maintenance policy and has none', NEW.operation;
    END IF;
    SELECT version INTO current_version FROM console.host_policy WHERE id = NEW.policy_id;
    IF current_version IS NULL THEN
      RAISE EXCEPTION 'the policy governing this operation no longer exists';
    END IF;
    IF current_version <> NEW.policy_version THEN
      -- The rules changed after this was approved. Whether the new rules would
      -- also have permitted it is not the point: nobody reviewed it under them.
      RAISE EXCEPTION 'policy % has moved to version % since this operation was approved at version %',
        NEW.policy_id, current_version, NEW.policy_version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_operation_policy_guard ON console.host_operation;
CREATE TRIGGER host_operation_policy_guard
  BEFORE INSERT OR UPDATE ON console.host_operation
  FOR EACH ROW EXECUTE FUNCTION console.host_operation_policy_guard();
ALTER TABLE console.host_operation ENABLE ALWAYS TRIGGER host_operation_policy_guard;

-- ============================================================================
-- Stage 4: network, storage and image-based OS operations
-- (mirrors backend/supabase/migrations/0031_host_network_storage_image.sql)
-- ============================================================================

-- ── permissions ──────────────────────────────────────────────────────────────

-- Three separate permissions, not one. The three authorities need different
-- widenings of the host sandbox and none of them implies another; an operator
-- who may grow a filesystem has no business reconfiguring a network.
INSERT INTO console.permission (code, risk_level) VALUES
  ('console.hosts.network', 'high'),
  ('console.hosts.storage', 'high'),
  ('console.hosts.osimage', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
WHERE r.code = 'console-admins'
  AND p.code IN ('console.hosts.network', 'console.hosts.storage', 'console.hosts.osimage')
ON CONFLICT DO NOTHING;

-- ── the operations ───────────────────────────────────────────────────────────

-- requires_rollback marks an operation the platform must be able to undo by
-- itself. It is enforced below: such an operation cannot be dispatched without a
-- deadline, so a build that forgot to set one fails closed rather than making an
-- unrevertable change.
ALTER TABLE console.host_operation_type
  ADD COLUMN IF NOT EXISTS requires_rollback boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN console.host_operation_type.requires_rollback IS
  'Whether this operation must carry a rollback deadline. An operation with this set cannot be dispatched without one.';

INSERT INTO console.host_operation_type
  (operation, risk_level, requires_second_person, requires_maintenance, required_permission,
   max_lease_seconds, description, requires_policy, requires_rollback)
VALUES
  ('network.configure', 'high', true, false, 'console.hosts.network', 900,
   'Reconfigure one allowlisted NetworkManager profile. Never touches the interface carrying the default route, and reverts itself if the control center stops being reachable.',
   true, true),
  ('mount.configure', 'high', true, false, 'console.hosts.storage', 600,
   'Mount an existing filesystem persistently through a generated systemd mount unit. Never formats, never partitions and never writes to /etc/fstab.',
   true, false),
  ('filesystem.grow', 'high', true, false, 'console.hosts.storage', 1800,
   'Grow a mounted ext4 or xfs filesystem to fill the block device it already sits on. There is no size argument, so it cannot shrink and cannot move data.',
   true, false),
  ('osimage.stage', 'high', true, false, 'console.hosts.osimage', 3600,
   'Stage a digest-pinned operating system image on an rpm-ostree or bootc host. Never reboots: the running system is unchanged until host.reboot is separately approved.',
   true, false),
  ('osimage.rollback', 'high', true, false, 'console.hosts.osimage', 600,
   'Select the previous deployment for the next boot on an rpm-ostree or bootc host. Never reboots.',
   true, false)
ON CONFLICT (operation) DO UPDATE SET
  risk_level = EXCLUDED.risk_level,
  requires_second_person = EXCLUDED.requires_second_person,
  requires_maintenance = EXCLUDED.requires_maintenance,
  required_permission = EXCLUDED.required_permission,
  max_lease_seconds = EXCLUDED.max_lease_seconds,
  description = EXCLUDED.description,
  requires_policy = EXCLUDED.requires_policy,
  requires_rollback = EXCLUDED.requires_rollback;

-- The event journal gains the phases preflight and rollback produce.
ALTER TABLE console.host_operation_event DROP CONSTRAINT IF EXISTS host_operation_event_phase_check;
ALTER TABLE console.host_operation_event ADD CONSTRAINT host_operation_event_phase_check
  CHECK (phase IN (
    'requested', 'awaiting_approval', 'approved', 'preparing', 'dispatchable',
    'leased', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired',
    'maintenance.cordon', 'maintenance.drain', 'maintenance.uncordon',
    'maintenance.refused', 'maintenance.degraded',
    'policy.evaluated', 'policy.refused', 'policy.superseded',
    'preflight.refused', 'rollback.armed', 'rollback.confirmed', 'rollback.executed'
  ));

-- ── the target must be governed, not only the verb ───────────────────────────

ALTER TABLE console.host_policy
  ADD COLUMN IF NOT EXISTS allowed_images text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS allowed_mount_roots text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN console.host_policy.allowed_images IS
  'Digest-pinned image references this policy permits staging. Permitting osimage.stage without naming images would permit any image.';
COMMENT ON COLUMN console.host_policy.allowed_mount_roots IS
  'Directories beneath which this policy permits a mount point to be created. A root itself is never a valid target.';

-- An image reference must be digest-pinned. A tag can be moved by whoever
-- controls the registry, which makes it a target nobody can review; a digest
-- cannot. The pattern mirrors the agent and the backend exactly.
CREATE OR REPLACE FUNCTION console.host_policy_images_valid(images text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT images IS NULL
      OR coalesce(array_length(images, 1), 0) = 0
      OR (array_length(images, 1) <= 32
          AND NOT EXISTS (
            SELECT 1 FROM unnest(images) AS image
            WHERE image !~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]{1,5})?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?){1,6}@sha256:[0-9a-f]{64}$'
          ));
$$;

ALTER TABLE console.host_policy DROP CONSTRAINT IF EXISTS host_policy_images_check;
ALTER TABLE console.host_policy ADD CONSTRAINT host_policy_images_check
  CHECK (console.host_policy_images_valid(allowed_images));

-- A mount root must be an absolute path built from safe segments, and must not
-- be one of the paths the platform protects. Enforcing it here means a policy
-- cannot be written that the host would then refuse, which is the kind of
-- disagreement that only surfaces at 3am.
CREATE OR REPLACE FUNCTION console.host_policy_mount_roots_valid(roots text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT roots IS NULL
      OR coalesce(array_length(roots, 1), 0) = 0
      OR (array_length(roots, 1) <= 16
          AND NOT EXISTS (
            SELECT 1 FROM unnest(roots) AS root
            WHERE root !~ '^(/[A-Za-z0-9_][A-Za-z0-9._-]{0,62}){1,8}$'
               OR root = '/'
               OR root ~ '^/(boot|usr|etc|var|proc|sys|dev|run)(/|$)'
          ));
$$;

ALTER TABLE console.host_policy DROP CONSTRAINT IF EXISTS host_policy_mount_roots_check;
ALTER TABLE console.host_policy ADD CONSTRAINT host_policy_mount_roots_check
  CHECK (console.host_policy_mount_roots_valid(allowed_mount_roots));

-- Editing either list changes what may be done, so both are substantive edits
-- and both bump the version. Approvals bind the version, so an operation
-- approved against one image list cannot execute against another.
CREATE OR REPLACE FUNCTION console.host_policy_version_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    RETURN NEW;
  END IF;

  IF NEW.control_center_id IS DISTINCT FROM OLD.control_center_id
     OR NEW.host_uuid IS DISTINCT FROM OLD.host_uuid THEN
    RAISE EXCEPTION 'the scope of a policy is immutable; create a new policy instead';
  END IF;

  IF NEW.timezone IS DISTINCT FROM OLD.timezone
     OR NEW.allowed_operations IS DISTINCT FROM OLD.allowed_operations
     OR NEW.allowed_images IS DISTINCT FROM OLD.allowed_images
     OR NEW.allowed_mount_roots IS DISTINCT FROM OLD.allowed_mount_roots
     OR NEW.emergency_allowed IS DISTINCT FROM OLD.emergency_allowed
     OR NEW.emergency_requires_second_person IS DISTINCT FROM OLD.emergency_requires_second_person
     OR NEW.enabled IS DISTINCT FROM OLD.enabled
     OR NEW.window_revision IS DISTINCT FROM OLD.window_revision THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── the rollback an operator sees is the one the host acted on ───────────────

ALTER TABLE console.host_operation
  ADD COLUMN IF NOT EXISTS adapter text,
  ADD COLUMN IF NOT EXISTS rollback_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS rollback_state text NOT NULL DEFAULT 'none';

COMMENT ON COLUMN console.host_operation.rollback_deadline_at IS
  'When the agent stops waiting for its own connectivity proof and puts the previous settings back. Set at dispatch, from the approved rollbackSeconds.';
COMMENT ON COLUMN console.host_operation.rollback_state IS
  'none, armed, confirmed, rolled-back, rollback-failed or not-recorded. Derived from the agent receipt; never set by an operator.';

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_rollback_state_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_rollback_state_check
  CHECK (rollback_state IN ('none', 'armed', 'confirmed', 'rolled-back', 'rollback-failed', 'not-recorded'));

ALTER TABLE console.host_operation DROP CONSTRAINT IF EXISTS host_operation_adapter_check;
ALTER TABLE console.host_operation ADD CONSTRAINT host_operation_adapter_check
  CHECK (adapter IS NULL OR adapter IN ('NetworkManager', 'systemd-mount', 'rpm-ostree', 'bootc'));

-- An operation that must be revertable cannot be dispatched without a deadline.
--
-- This is the same argument as the policy guard beside it: an application bug
-- that forgot to arm the rollback would otherwise produce exactly the change
-- this whole mechanism exists to prevent — one that severs the control path with
-- nothing scheduled to undo it.
CREATE OR REPLACE FUNCTION console.host_operation_rollback_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
DECLARE
  needs_rollback boolean;
BEGIN
  SELECT requires_rollback INTO needs_rollback
    FROM console.host_operation_type WHERE operation = NEW.operation;

  IF NOT coalesce(needs_rollback, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('leased', 'running') THEN
    IF NEW.rollback_deadline_at IS NULL THEN
      RAISE EXCEPTION 'operation % must carry a rollback deadline before it is dispatched', NEW.operation;
    END IF;
    IF NEW.rollback_state = 'none' THEN
      RAISE EXCEPTION 'operation % must have its rollback armed before it is dispatched', NEW.operation;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_operation_rollback_guard ON console.host_operation;
CREATE TRIGGER host_operation_rollback_guard
  BEFORE INSERT OR UPDATE ON console.host_operation
  FOR EACH ROW EXECUTE FUNCTION console.host_operation_rollback_guard();
-- ALWAYS, not the default ORIGIN: session_replication_role = 'replica' would
-- otherwise switch this guard off, silently, for any session that set it.
ALTER TABLE console.host_operation ENABLE ALWAYS TRIGGER host_operation_rollback_guard;

-- 0032_host_ssh_ban.sql
-- Governed SSH ban management for the fixed Fail2ban sshd jail.
INSERT INTO console.permission (code, risk_level) VALUES
  ('console.hosts.ssh-ban', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
WHERE r.code = 'console-admins'
  AND p.code = 'console.hosts.ssh-ban'
ON CONFLICT DO NOTHING;

INSERT INTO console.host_operation_type
  (operation, risk_level, requires_second_person, requires_maintenance, required_permission,
   max_lease_seconds, description, requires_policy, requires_rollback)
VALUES
  ('ssh.ban', 'high', true, false, 'console.hosts.ssh-ban', 120,
   'Ban one exact IP address in the fixed Fail2ban sshd jail after rechecking the reviewed live state. CIDR ranges, arbitrary jails and protected management addresses are refused.',
   false, false),
  ('ssh.unban', 'high', true, false, 'console.hosts.ssh-ban', 120,
   'Remove one exact IP address from the fixed Fail2ban sshd jail after rechecking the reviewed live state.',
   false, false)
ON CONFLICT (operation) DO UPDATE SET
  risk_level = EXCLUDED.risk_level,
  requires_second_person = EXCLUDED.requires_second_person,
  requires_maintenance = EXCLUDED.requires_maintenance,
  required_permission = EXCLUDED.required_permission,
  max_lease_seconds = EXCLUDED.max_lease_seconds,
  description = EXCLUDED.description,
  requires_policy = EXCLUDED.requires_policy,
  requires_rollback = EXCLUDED.requires_rollback;

-- 0033_host_ssh_protection.sql
-- Fixed, reviewed Fail2ban installation and sshd baseline activation.
INSERT INTO console.host_operation_type
  (operation, risk_level, requires_second_person, requires_maintenance, required_permission,
   max_lease_seconds, description, requires_policy, requires_rollback)
VALUES
  ('ssh.protection.enable', 'high', true, true, 'console.hosts.ssh-ban', 1800,
   'Install the exact reported Fail2ban package version when absent, write the fixed rcc-ssh-baseline-v1 sshd profile with host-protected management addresses, start the service and verify the jail.',
   true, false)
ON CONFLICT (operation) DO UPDATE SET
  risk_level = EXCLUDED.risk_level,
  requires_second_person = EXCLUDED.requires_second_person,
  requires_maintenance = EXCLUDED.requires_maintenance,
  required_permission = EXCLUDED.required_permission,
  max_lease_seconds = EXCLUDED.max_lease_seconds,
  description = EXCLUDED.description,
  requires_policy = EXCLUDED.requires_policy,
  requires_rollback = EXCLUDED.requires_rollback;
