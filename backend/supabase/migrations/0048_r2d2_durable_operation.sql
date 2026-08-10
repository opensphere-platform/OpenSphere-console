\set ON_ERROR_STOP on

-- Wave 4: extend the existing Console module operation receipt. This does not
-- create a competing R2D2 operation authority.

ALTER TABLE console.module_operation DROP CONSTRAINT IF EXISTS module_operation_action_check;
ALTER TABLE console.module_operation ADD CONSTRAINT module_operation_action_check CHECK (action IN (
  'install','verify','upgrade','rollback','delete-runtime','reinstall','purge',
  'restart-workload','scale-workload','rollback-image','run-cronjob','owner-recover','retry-delivery',
  'engineering-remediation'
));
ALTER TABLE console.module_operation DROP CONSTRAINT IF EXISTS module_operation_phase_check;
ALTER TABLE console.module_operation ADD CONSTRAINT module_operation_phase_check CHECK (phase IN (
  'Queued','AwaitingApproval','Claimed','Preflighting','AuthorizationExpired','PreflightBlocked',
  'Running','Ambiguous','Reconciling','Verifying','Succeeded','Failed','VerificationFailed',
  'Inconclusive','Cancelled','TimedOut','RollingBack','RolledBack'
));

ALTER TABLE console.module_operation
  ADD COLUMN IF NOT EXISTS agent_run_id uuid,
  ADD COLUMN IF NOT EXISTS incident_id uuid,
  ADD COLUMN IF NOT EXISTS descriptor_revision text,
  ADD COLUMN IF NOT EXISTS descriptor_digest text CHECK (descriptor_digest IS NULL OR descriptor_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS tool_id text,
  ADD COLUMN IF NOT EXISTS verifier_id text,
  ADD COLUMN IF NOT EXISTS target_uid text,
  ADD COLUMN IF NOT EXISTS target_generation bigint,
  ADD COLUMN IF NOT EXISTS desired_revision text,
  ADD COLUMN IF NOT EXISTS requested_risk_class text CHECK (requested_risk_class IS NULL OR requested_risk_class IN ('R0','R1','R2','R3')),
  ADD COLUMN IF NOT EXISTS required_assurance text CHECK (required_assurance IS NULL OR required_assurance IN ('aal1','aal2')),
  ADD COLUMN IF NOT EXISTS actor_assurance_at_accept text CHECK (actor_assurance_at_accept IS NULL OR actor_assurance_at_accept IN ('aal1','aal2')),
  ADD COLUMN IF NOT EXISTS auth_session_id uuid,
  ADD COLUMN IF NOT EXISTS authz_revision text,
  ADD COLUMN IF NOT EXISTS authz_revalidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_evidence_ref text,
  ADD COLUMN IF NOT EXISTS claim_owner text,
  ADD COLUMN IF NOT EXISTS claim_epoch bigint CHECK (claim_epoch IS NULL OR claim_epoch > 0),
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS downstream_operation_id text,
  ADD COLUMN IF NOT EXISTS downstream_idempotency_key text,
  ADD COLUMN IF NOT EXISTS execution_state text NOT NULL DEFAULT 'accepted' CHECK (execution_state IN (
    'accepted','awaiting_approval','claimed','preflighting','authorization_expired','preflight_blocked',
    'executing','ambiguous','reconciling','complete','failed','cancelled','timed_out','rolling_back','rolled_back'
  )),
  ADD COLUMN IF NOT EXISTS verification_state text NOT NULL DEFAULT 'pending' CHECK (verification_state IN (
    'pending','verifying','succeeded','failed','inconclusive','not_required'
  )),
  ADD COLUMN IF NOT EXISTS precondition jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(precondition) = 'object'),
  ADD COLUMN IF NOT EXISTS expected_postcondition jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(expected_postcondition) = 'object');

CREATE UNIQUE INDEX IF NOT EXISTS module_operation_downstream_idempotency_idx
  ON console.module_operation(downstream_idempotency_key)
  WHERE downstream_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS module_operation_claim_idx
  ON console.module_operation(next_attempt_at, created_at)
  WHERE phase IN ('Queued','Ambiguous','Reconciling','Verifying');

CREATE TABLE IF NOT EXISTS console.module_operation_step (
  operation_id uuid NOT NULL REFERENCES console.module_operation(operation_id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  attempt integer NOT NULL CHECK (attempt >= 0),
  step_type text NOT NULL CHECK (step_type IN (
    'accepted','approval','claim','authorization','precondition','owner-call','receipt',
    'reconcile','verification','rollback','terminal'
  )),
  tool_id text,
  precondition_digest text CHECK (precondition_digest IS NULL OR precondition_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_digest text CHECK (request_digest IS NULL OR request_digest ~ '^sha256:[0-9a-f]{64}$'),
  receipt_digest text CHECK (receipt_digest IS NULL OR receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  verifier_id text,
  status text NOT NULL CHECK (status IN ('pending','running','succeeded','failed','blocked','inconclusive')),
  error_code text,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  PRIMARY KEY (operation_id, sequence),
  UNIQUE (operation_id, attempt, step_type, request_digest)
);

CREATE TABLE IF NOT EXISTS console.module_operation_approval (
  operation_id uuid NOT NULL REFERENCES console.module_operation(operation_id) ON DELETE RESTRICT,
  approver_id uuid NOT NULL,
  assurance text NOT NULL CHECK (assurance = 'aal2'),
  approval_digest text NOT NULL CHECK (approval_digest ~ '^sha256:[0-9a-f]{64}$'),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (operation_id, approver_id)
);

CREATE OR REPLACE FUNCTION console.assert_module_operation_ready(p_operation_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
DECLARE op console.module_operation%ROWTYPE; approval_count integer;
BEGIN
  SELECT * INTO op FROM console.module_operation WHERE operation_id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation not found'; END IF;
  IF op.deadline_at IS NULL OR op.deadline_at <= clock_timestamp() THEN RAISE EXCEPTION 'operation deadline exceeded'; END IF;
  SELECT count(DISTINCT approver_id) INTO approval_count
  FROM console.module_operation_approval
  WHERE operation_id = p_operation_id AND revoked_at IS NULL AND assurance = 'aal2';
  IF op.requested_risk_class = 'R2' AND approval_count < 1 THEN RAISE EXCEPTION 'R2 active AAL2 approval required'; END IF;
  IF op.requested_risk_class = 'R3' AND approval_count < 2 THEN RAISE EXCEPTION 'R3 two-person AAL2 approval required'; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION console.claim_module_operation(
  p_worker text, p_claim_epoch bigint, p_limit integer DEFAULT 10
) RETURNS SETOF console.module_operation LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
BEGIN
  IF length(btrim(coalesce(p_worker, ''))) < 3 OR p_claim_epoch < 1 THEN RAISE EXCEPTION 'worker and epoch required'; END IF;
  -- Expire work for which no downstream mutation can have started. Executing and
  -- later phases must reconcile instead, because timeout may not hide real state.
  UPDATE console.module_operation SET
    phase = 'TimedOut', execution_state = 'timed_out', updated_at = clock_timestamp()
  WHERE deadline_at <= clock_timestamp()
    AND phase IN ('Queued','AwaitingApproval','Claimed','Preflighting');
  RETURN QUERY
  WITH candidates AS (
    SELECT operation_id FROM console.module_operation
    WHERE phase IN ('Queued','Running','Ambiguous','Reconciling','Verifying')
      AND next_attempt_at <= clock_timestamp()
      AND deadline_at > clock_timestamp()
      AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
      AND (
        requested_risk_class NOT IN ('R2','R3')
        OR (requested_risk_class = 'R2' AND (
          SELECT count(DISTINCT a.approver_id) FROM console.module_operation_approval a
          WHERE a.operation_id = module_operation.operation_id
            AND a.revoked_at IS NULL AND a.assurance = 'aal2'
        ) >= 1)
        OR (requested_risk_class = 'R3' AND (
          SELECT count(DISTINCT a.approver_id) FROM console.module_operation_approval a
          WHERE a.operation_id = module_operation.operation_id
            AND a.revoked_at IS NULL AND a.assurance = 'aal2'
        ) >= 2)
      )
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT greatest(1, least(p_limit, 50))
  )
  UPDATE console.module_operation o SET phase = CASE
      WHEN o.phase = 'Queued' THEN 'Claimed'
      WHEN o.phase = 'Running' THEN 'Ambiguous'
      ELSE o.phase END,
    execution_state = CASE
      WHEN o.phase = 'Queued' THEN 'claimed'
      WHEN o.phase = 'Running' THEN 'ambiguous'
      ELSE o.execution_state END,
    claim_owner = p_worker, claim_epoch = p_claim_epoch,
    lease_expires_at = clock_timestamp() + interval '30 seconds', heartbeat_at = clock_timestamp(),
    attempt = attempt + 1, updated_at = clock_timestamp()
  FROM candidates c WHERE o.operation_id = c.operation_id RETURNING o.*;
END $$;

CREATE OR REPLACE FUNCTION console.heartbeat_module_operation(
  p_operation_id uuid, p_worker text, p_claim_epoch bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
BEGIN
  UPDATE console.module_operation SET lease_expires_at = clock_timestamp() + interval '30 seconds',
    heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE operation_id = p_operation_id AND claim_owner = p_worker AND claim_epoch = p_claim_epoch
    AND phase NOT IN ('Succeeded','Failed','VerificationFailed','Cancelled','TimedOut','RolledBack');
  RETURN FOUND;
END $$;

ALTER TABLE console.module_operation_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.module_operation_step FORCE ROW LEVEL SECURITY;
ALTER TABLE console.module_operation_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.module_operation_approval FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE console.module_operation_step, console.module_operation_approval
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON console.module_operation_step, console.module_operation_approval TO opensphere_console_backend;
CREATE POLICY console_backend_module_operation_step ON console.module_operation_step FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_module_operation_approval ON console.module_operation_approval FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
REVOKE ALL ON FUNCTION console.claim_module_operation(text,bigint,integer), console.heartbeat_module_operation(uuid,text,bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION console.claim_module_operation(text,bigint,integer), console.heartbeat_module_operation(uuid,text,bigint)
  TO opensphere_console_backend;
REVOKE ALL ON FUNCTION console.assert_module_operation_ready(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION console.assert_module_operation_ready(uuid) TO opensphere_console_backend;

COMMENT ON TABLE console.module_operation_step IS 'Append-style durable R2D2/module execution, receipt and verification evidence; never stores bearer tokens.';
COMMENT ON TABLE console.module_operation_approval IS 'Person-distinct AAL2 approvals. R3 remains unavailable until two active distinct approvers are present.';
