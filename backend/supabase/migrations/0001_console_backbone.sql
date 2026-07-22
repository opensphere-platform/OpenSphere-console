\set ON_ERROR_STOP on

-- migration-adr-006 canonical application schemas. Supabase-owned auth/storage
-- schemas are consumed through supported contracts and are never redefined here.
CREATE SCHEMA IF NOT EXISTS console;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS internal;

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

CREATE TABLE IF NOT EXISTS console.service_principal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_-]{2,63}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  credential_revision bigint NOT NULL DEFAULT 1 CHECK (credential_revision > 0),
  allowed_audiences text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS console.user_setting (
  owner_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE IF NOT EXISTS console.plugin_meta (
  plugin_id text PRIMARY KEY,
  record jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS console.change_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'service', 'break_glass')),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 4),
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
CREATE INDEX IF NOT EXISTS change_request_status_idx ON console.change_request (status, created_at);

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

ALTER TABLE console.operator ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.operator_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.user_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.change_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_read_self ON console.operator;
CREATE POLICY operator_read_self ON console.operator FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS operator_role_read_self ON console.operator_role;
CREATE POLICY operator_role_read_self ON console.operator_role FOR SELECT TO authenticated
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

GRANT USAGE ON SCHEMA console, audit TO authenticated;
GRANT SELECT ON console.operator, console.operator_role, console.change_request, audit.event TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON console.user_setting TO authenticated;

-- Browser identities never receive application-table mutation grants for RBAC,
-- change orchestration, or audit. Only the constrained Backend DB role does.
REVOKE INSERT, UPDATE, DELETE ON console.operator, console.role, console.permission,
  console.role_permission, console.operator_role, console.service_principal,
  console.change_request, console.plugin_meta, audit.event FROM anon, authenticated;

INSERT INTO console.role (code, description, system_managed) VALUES
  ('console-admins', 'Full Console administration', true),
  ('console-operators', 'Day-to-day Console operations', true),
  ('console-viewers', 'Read-only Console access', true)
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, system_managed = true;

INSERT INTO console.permission (code, risk_level) VALUES
  ('console.read', 'low'),
  ('console.settings.write', 'medium'),
  ('console.identity.manage', 'critical'),
  ('console.git.change', 'high'),
  ('console.kubernetes.apply', 'critical'),
  ('console.backup.restore', 'critical')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
WHERE r.code = 'console-admins'
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p
  ON p.code IN ('console.read', 'console.settings.write', 'console.git.change')
WHERE r.code = 'console-operators'
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p ON p.code = 'console.read'
WHERE r.code = 'console-viewers'
ON CONFLICT DO NOTHING;

-- Storage buckets are metadata; object bytes remain on the Storage PVC/backend.
INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES
  ('plugin-bundles', 'plugin-bundles', false, 524288000),
  ('console-uploads', 'console-uploads', false, 52428800),
  ('operation-artifacts', 'operation-artifacts', false, 524288000)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS console_storage_read_own ON storage.objects;
CREATE POLICY console_storage_read_own ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id IN ('console-uploads', 'operation-artifacts') AND owner_id = auth.uid()::text);

DROP POLICY IF EXISTS console_upload_own ON storage.objects;
CREATE POLICY console_upload_own ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'console-uploads' AND owner_id = auth.uid()::text);
