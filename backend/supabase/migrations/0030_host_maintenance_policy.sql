-- Stage 3: package and kernel maintenance, governed by maintenance windows.
--
-- Two things arrive together, and they have to, because either alone is worse
-- than neither.
--
-- Package and kernel updates are the first operations whose *timing* matters as
-- much as their content. Restarting an allowlisted service at 03:00 and at
-- 15:00 are the same act; installing a kernel is not, because what follows it
-- is a reboot somebody has to be awake for. So Stage 3 adds a policy: an
-- explicit, versioned statement of when a host may be disturbed.
--
-- The policy is default-deny. A host with no policy accepts no package or
-- kernel maintenance at all. That is deliberate: the failure mode of "we forgot
-- to write a policy" should be that nothing happens, not that anything may
-- happen at any time.

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
