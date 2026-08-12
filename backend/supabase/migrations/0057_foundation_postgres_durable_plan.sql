\set ON_ERROR_STOP on

-- PostgreSQL control planning is part of the existing Console module operation
-- authority. Plans are immutable, actor-bound, expiring inputs to that ledger;
-- they are not a second execution ledger.

ALTER TABLE console.module_operation DROP CONSTRAINT IF EXISTS module_operation_action_check;
ALTER TABLE console.module_operation ADD CONSTRAINT module_operation_action_check CHECK (action IN (
  'install','verify','upgrade','rollback','delete-runtime','reinstall','purge',
  'restart-workload','scale-workload','rollback-image','run-cronjob','owner-recover','retry-delivery',
  'create-postgres-cluster','engineering-remediation'
));

ALTER TABLE console.module_operation_approval
  ADD COLUMN IF NOT EXISTS auth_session_id uuid,
  ADD COLUMN IF NOT EXISTS authz_revision text;

COMMENT ON COLUMN console.module_operation_approval.auth_session_id IS
  'Server-owned browser session used to revalidate an independent AAL2 approver at execution; no bearer token is stored.';

CREATE TABLE IF NOT EXISTS console.module_operation_plan (
  plan_id text PRIMARY KEY CHECK (plan_id ~ '^pgplan-[0-9a-f-]{36}$'),
  actor_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  action text NOT NULL CHECK (action = 'create-postgres-cluster'),
  descriptor_revision text NOT NULL,
  descriptor_digest text NOT NULL CHECK (descriptor_digest ~ '^sha256:[0-9a-f]{64}$'),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_revision text NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('R0','R1','R2','R3')),
  required_assurance text NOT NULL CHECK (required_assurance IN ('aal1','aal2')),
  expected_confirmation text NOT NULL,
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  expected_postcondition jsonb NOT NULL CHECK (jsonb_typeof(expected_postcondition) = 'object'),
  expires_at timestamptz NOT NULL,
  consumed_operation_id uuid REFERENCES console.module_operation(operation_id) ON DELETE RESTRICT,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((consumed_operation_id IS NULL) = (consumed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS module_operation_plan_actor_time_idx
  ON console.module_operation_plan(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS module_operation_plan_expiry_idx
  ON console.module_operation_plan(expires_at) WHERE consumed_operation_id IS NULL;

ALTER TABLE console.module_operation_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.module_operation_plan FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE console.module_operation_plan FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE console.module_operation_plan TO opensphere_console_backend;
CREATE POLICY console_backend_module_operation_plan ON console.module_operation_plan
  FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);

COMMENT ON TABLE console.module_operation_plan IS
  'Immutable actor/session-bound expiring plan inputs for Console module_operation; contains no bearer tokens or credentials.';
