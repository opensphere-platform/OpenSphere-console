-- Host maintenance recovery and post-review immutability.
--
-- Two gaps this closes.
--
-- 1. A failed uncordon is invisible. Preparation cordons a node before it
--    drains, and uncordons it again if the drain is refused. When that
--    compensating uncordon itself fails, the node stays cordoned: the scheduler
--    silently stops placing work on a healthy machine and nothing anywhere
--    says so. The evidence has to outlive the process that observed it, or the
--    only way to notice is for someone to wonder why capacity shrank.
--
-- 2. Approval binds a content digest, but nothing stopped the row's operation
--    or parameters being rewritten afterwards. The digest comparison catches
--    the mismatch at dispatch, which is late and depends on application code
--    being correct. The database can simply refuse the edit.

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
