\set ON_ERROR_STOP on

-- Minimal durable receipt for administrator-initiated module lifecycle work.
-- This table is not desired/live state authority: product owners still own
-- convergence and Kubernetes remains the observed runtime authority.
CREATE TABLE IF NOT EXISTS console.module_operation (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  module_id text NOT NULL
    CHECK (module_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  action text NOT NULL
    CHECK (action IN (
      'install', 'verify', 'upgrade', 'rollback',
      'delete-runtime', 'reinstall', 'purge'
    )),
  actor_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 1000),
  assurance text NOT NULL CHECK (assurance IN ('aal1', 'aal2')),
  risk_class text NOT NULL CHECK (risk_class IN ('R0', 'R1', 'R2', 'R3')),
  target_fingerprint text NOT NULL
    CHECK (target_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  phase text NOT NULL DEFAULT 'Queued'
    CHECK (phase IN (
      'Queued', 'AwaitingApproval', 'Running', 'Verifying',
      'Succeeded', 'Failed', 'RolledBack'
    )),
  result jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(result) = 'object'),
  error_code text,
  evidence_ref text,
  rollback_result jsonb
    CHECK (rollback_result IS NULL OR jsonb_typeof(rollback_result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS module_operation_module_time_idx
  ON console.module_operation(module_id, created_at DESC);
CREATE INDEX IF NOT EXISTS module_operation_actor_time_idx
  ON console.module_operation(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS module_operation_active_idx
  ON console.module_operation(phase, updated_at)
  WHERE phase IN ('Queued', 'AwaitingApproval', 'Running', 'Verifying');

COMMENT ON TABLE console.module_operation IS
  'Durable lifecycle receipt only. Module desired state belongs to the existing owner and live state belongs to the owner/Kubernetes observation.';

ALTER TABLE console.module_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.module_operation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE console.module_operation FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE console.module_operation TO opensphere_console_backend;

DROP POLICY IF EXISTS console_backend_module_operation ON console.module_operation;
CREATE POLICY console_backend_module_operation ON console.module_operation
  FOR ALL TO opensphere_console_backend
  USING (true)
  WITH CHECK (true);
