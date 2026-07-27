-- Linux host authority for the RCC host control plane.
--
-- Boundaries this migration makes explicit:
--   * Host records carry an agent KEY ID only.  Agent signing secrets are held
--     in a root-mounted backend file and MUST NOT exist in any column reachable
--     through PostgREST.
--   * Host operations have a declared state machine.  Stage 1 control centers
--     run in host_control_mode = 'read-only', where dispatch is refused by the
--     database itself, so an operator UI or API defect cannot execute anything.
--   * Operation history is append-only: console.host_operation_event is the
--     immutable result boundary that pairs with audit.event.

CREATE SCHEMA IF NOT EXISTS console AUTHORIZATION supabase_admin;

-- Mirrors console.control_center.kubernetes_mode so the host surface has its
-- own escalation switch instead of inheriting the Kubernetes one.
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
  -- Identifier only.  A secret in this table would be readable by any role that
  -- can reach the host list through PostgREST.
  agent_key_id text NOT NULL CHECK (agent_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'retired')),
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  enrolled_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (control_center_id, host_id)
);

-- One row per host.  RCC deliberately stores only the latest snapshot: history
-- and trending belong to the platform observability stack, not to a second
-- time-series database inside the console.
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

-- The immutable result boundary.  Every transition and every terminal result is
-- recorded here and can never be rewritten.
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

-- Declared state machine.  Anything not listed here is refused.
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

  -- Stage 1 boundary: a read-only control center cannot dispatch, no matter what
  -- the API or UI believes.
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

-- Operators see only hosts inside control centers they are currently assigned to.
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

-- Stage 1 grants read only.  console.hosts.operate stays with administrators
-- until the executable stage is reviewed and enabled.
INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p ON p.code = 'console.hosts.read'
WHERE r.code IN ('console-operators', 'console-viewers')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE console.host IS
  'Linux hosts bound to a control center. Stores the agent key id only; agent signing secrets never enter the database.';
COMMENT ON COLUMN console.host.agent_key_id IS
  'Identifier of the HMAC key held in the backend key file. Never contains key material.';
COMMENT ON TABLE console.host_snapshot IS
  'Latest bounded read-only snapshot per host. RCC keeps no snapshot history and runs no second time-series store.';
COMMENT ON TABLE console.host_operation IS
  'Host operation state machine. Dispatch is refused while the control center host_control_mode is read-only.';
COMMENT ON TABLE console.host_operation_event IS
  'Append-only immutable result boundary for host operations; pairs with audit.event.';
