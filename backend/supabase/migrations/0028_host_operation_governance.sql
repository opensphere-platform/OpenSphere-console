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

\set ON_ERROR_STOP on

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

-- 0027 allowed a 'dispatched' status that this migration replaces with the
-- finer-grained 'dispatchable' / 'leased' / 'running' set, and it allowed any
-- operation name. Both of the constraints below would hard-fail on a region
-- that already carries such a row, so the rows are settled first. An operation
-- that was mid-flight when this ran cannot be adopted into the new state
-- machine — nothing here knows whether the host acted on it — so it is closed
-- as expired, which is the state that means "nobody can say".
UPDATE console.host_operation
   SET status = 'expired',
       completed_at = COALESCE(completed_at, now())
 WHERE status = 'dispatched';

-- The catalogue is a closed list, and a row naming something outside it would
-- fail the foreign key below. Refusing here names the offending operations
-- instead of leaving the operator with a constraint violation to decode.
-- History is never deleted to make a migration pass.
DO $$
DECLARE
  orphans text;
BEGIN
  SELECT string_agg(DISTINCT operation, ', ') INTO orphans
    FROM console.host_operation
   WHERE operation NOT IN (SELECT operation FROM console.host_operation_type);
  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION 'console.host_operation holds operations that are not in the catalogue: %. Reconcile them before applying this migration.', orphans;
  END IF;
END;
$$;

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
