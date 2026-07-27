-- Stage 4: conservative network and storage change, and image-based OS staging.
--
-- Everything here follows the shape Stage 3 established, because the shape is
-- what makes these operations reviewable: a closed catalog entry, a permission
-- that is not the one used for reading, a policy that must name the operation,
-- and a window it must run inside.
--
-- Two things are genuinely new.
--
-- The first is a rollback deadline. A network change can sever the path the
-- control center uses to find out whether the network change worked, so the
-- agent proves reachability afterwards and undoes the change if it cannot. The
-- deadline and the outcome are recorded here so an operator sees the same
-- history the host acted on.
--
-- The second is a target allowlist. An operation that names an image or a mount
-- point needs the *target* to be governed, not only the verb: permitting
-- osimage.stage without saying which images is permitting any image.

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
