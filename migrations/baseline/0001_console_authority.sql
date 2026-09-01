-- OpenSphere Console fresh-start authority baseline.
-- This file is the proposed baseline-0001 model. It does not migrate a legacy DB.

BEGIN;

CREATE SCHEMA console_identity;
CREATE SCHEMA console_operation;
CREATE SCHEMA console_audit;

REVOKE ALL ON SCHEMA console_identity, console_operation, console_audit FROM PUBLIC;

CREATE TABLE console_identity.browser_session (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  token_digest bytea NOT NULL UNIQUE,
  aal text NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  revoke_epoch bigint NOT NULL DEFAULT 0 CHECK (revoke_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND length(btrim(revoke_reason)) > 0))
);

CREATE TABLE console_identity.permission_grant (
  subject_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_.:-]{2,127}$'),
  grant_revision bigint NOT NULL CHECK (grant_revision > 0),
  granted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (subject_id, permission, grant_revision)
);

CREATE INDEX browser_session_subject_active_idx
  ON console_identity.browser_session (subject_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE console_identity.browser_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.browser_session FORCE ROW LEVEL SECURITY;
ALTER TABLE console_identity.permission_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.permission_grant FORCE ROW LEVEL SECURITY;

CREATE POLICY browser_session_self_read
  ON console_identity.browser_session
  FOR SELECT TO authenticated
  USING (subject_id = auth.uid());

CREATE POLICY permission_grant_self_read
  ON console_identity.permission_grant
  FOR SELECT TO authenticated
  USING (subject_id = auth.uid() AND revoked_at IS NULL);

CREATE TABLE console_operation.operation (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id text NOT NULL,
  action_version text NOT NULL,
  actor_ref uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_ref text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  risk text NOT NULL CHECK (risk IN ('R0', 'R1', 'R2', 'R3')),
  reason text NOT NULL DEFAULT '',
  aal text NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  plan_revision text NOT NULL,
  approval_revision text,
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL,
  source_revision text,
  owner_ref text,
  state text NOT NULL CHECK (state IN ('Planned', 'Authorized', 'Submitted', 'Reconciling', 'Applied', 'Verified', 'Failed', 'Unknown', 'RolledBack')),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  expected_postcondition jsonb,
  observed_postcondition jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (actor_ref, idempotency_key),
  CHECK (risk = 'R0' OR length(btrim(reason)) > 0),
  CHECK (risk NOT IN ('R2', 'R3') OR aal = 'aal2'),
  CHECK (updated_at >= created_at)
);

CREATE TABLE console_operation.outbox (
  outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES console_operation.operation(operation_id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  UNIQUE (operation_id, event_type, payload_digest)
);

ALTER TABLE console_operation.operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_operation.operation FORCE ROW LEVEL SECURITY;
ALTER TABLE console_operation.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_operation.outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY operation_actor_read
  ON console_operation.operation
  FOR SELECT TO authenticated
  USING (actor_ref = auth.uid());

CREATE TABLE console_audit.event (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  correlation_id text NOT NULL,
  actor_ref text NOT NULL,
  action text NOT NULL,
  target_ref text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'succeeded', 'failed', 'unknown')),
  reason text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash text CHECK (previous_hash IS NULL OR previous_hash ~ '^sha256:[0-9a-f]{64}$'),
  event_hash text NOT NULL UNIQUE CHECK (event_hash ~ '^sha256:[0-9a-f]{64}$')
);

ALTER TABLE console_audit.event ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_audit.event FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION console_audit.reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'console audit events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_event_immutable
  BEFORE UPDATE OR DELETE ON console_audit.event
  FOR EACH ROW EXECUTE FUNCTION console_audit.reject_event_mutation();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON console_audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION console_audit.reject_event_mutation();

COMMENT ON SCHEMA console_identity IS 'Supabase-backed Console identity projections and opaque sessions';
COMMENT ON SCHEMA console_operation IS 'Durable intent, idempotency and external-effect outbox authority';
COMMENT ON SCHEMA console_audit IS 'Append-only Console security and operation evidence';
COMMENT ON TABLE console_operation.operation IS 'State changes require compare-and-set on state_version by the constrained Console API role';

COMMIT;
