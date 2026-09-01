-- OpenSphere Console fresh-start authority baseline.
-- This file is the proposed baseline-0001 model. It does not migrate a legacy DB.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'console_api') THEN
    CREATE ROLE console_api NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA console_identity;
CREATE SCHEMA console_operation;
CREATE SCHEMA console_audit;

REVOKE ALL ON SCHEMA console_identity, console_operation, console_audit FROM PUBLIC;
GRANT USAGE ON SCHEMA console_identity, console_operation TO authenticated;
GRANT USAGE ON SCHEMA console_identity, console_operation TO console_api;

CREATE TABLE console_identity.subject_authority (
  subject_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  revoke_epoch bigint NOT NULL DEFAULT 0 CHECK (revoke_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE console_identity.browser_session (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  token_digest bytea NOT NULL UNIQUE,
  csrf_token_digest bytea NOT NULL UNIQUE,
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

ALTER TABLE console_identity.subject_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.subject_authority FORCE ROW LEVEL SECURITY;
ALTER TABLE console_identity.browser_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.browser_session FORCE ROW LEVEL SECURITY;
ALTER TABLE console_identity.permission_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.permission_grant FORCE ROW LEVEL SECURITY;

CREATE POLICY subject_authority_self_read
  ON console_identity.subject_authority
  FOR SELECT TO authenticated
  USING (subject_id = auth.uid());

CREATE POLICY browser_session_self_read
  ON console_identity.browser_session
  FOR SELECT TO authenticated
  USING (subject_id = auth.uid());

CREATE POLICY permission_grant_self_read
  ON console_identity.permission_grant
  FOR SELECT TO authenticated
  USING (subject_id = auth.uid() AND revoked_at IS NULL);

GRANT SELECT ON console_identity.subject_authority,
  console_identity.browser_session,
  console_identity.permission_grant TO authenticated;

CREATE TABLE console_operation.operation (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id text NOT NULL CHECK (action_id ~ '^[a-z][a-z0-9.-]{2,127}$'),
  action_version text NOT NULL CHECK (action_version ~ '^[0-9]+\.[0-9]+$'),
  actor_ref uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_ref text NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 512),
  required_permission text NOT NULL CHECK (required_permission ~ '^[a-z][a-z0-9_.:-]{2,127}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  risk text NOT NULL CHECK (risk IN ('R0', 'R1', 'R2', 'R3')),
  reason text NOT NULL DEFAULT '',
  aal text NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  plan_revision text NOT NULL CHECK (length(plan_revision) BETWEEN 1 AND 128),
  approval_required boolean NOT NULL,
  approval_revision text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 8 AND 128),
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
  CHECK (risk = 'R0' OR length(btrim(reason)) BETWEEN 3 AND 500),
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

GRANT SELECT ON console_operation.operation TO authenticated;

CREATE TABLE console_audit.event (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  operation_id uuid REFERENCES console_operation.operation(operation_id) ON DELETE RESTRICT,
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

CREATE OR REPLACE FUNCTION console_audit.append_event_internal(
  p_operation_id uuid,
  p_correlation_id text,
  p_actor_ref text,
  p_action text,
  p_target_ref text,
  p_outcome text,
  p_reason text,
  p_evidence jsonb
)
RETURNS console_audit.event
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_audit
AS $$
DECLARE
  v_event console_audit.event;
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := statement_timestamp();
  v_previous_hash text;
  v_event_hash text;
  v_chain_input jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(471920260901);
  SELECT event_hash INTO v_previous_hash
    FROM console_audit.event
    ORDER BY sequence_id DESC
    LIMIT 1;

  v_chain_input := jsonb_build_object(
    'eventId', v_event_id,
    'operationId', p_operation_id,
    'occurredAt', v_occurred_at,
    'correlationId', p_correlation_id,
    'actorRef', p_actor_ref,
    'action', p_action,
    'targetRef', p_target_ref,
    'outcome', p_outcome,
    'reason', p_reason,
    'evidence', COALESCE(p_evidence, '{}'::jsonb),
    'previousHash', v_previous_hash
  );
  v_event_hash := 'sha256:' || encode(sha256(convert_to(v_chain_input::text, 'UTF8')), 'hex');

  INSERT INTO console_audit.event(
    event_id, operation_id, occurred_at, correlation_id, actor_ref, action,
    target_ref, outcome, reason, evidence, previous_hash, event_hash
  ) VALUES (
    v_event_id, p_operation_id, v_occurred_at, p_correlation_id, p_actor_ref, p_action,
    p_target_ref, p_outcome, COALESCE(p_reason, ''), COALESCE(p_evidence, '{}'::jsonb),
    v_previous_hash, v_event_hash
  ) RETURNING * INTO v_event;
  RETURN v_event;
END;
$$;

REVOKE ALL ON FUNCTION console_audit.append_event_internal(uuid, text, text, text, text, text, text, jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION console_identity.resolve_browser_session(
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_require_csrf boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_permissions text[];
BEGIN
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF p_require_csrf AND (p_csrf_token_digest IS NULL OR v_session.csrf_token_digest <> p_csrf_token_digest) THEN
    RAISE EXCEPTION 'Console session CSRF validation failed' USING ERRCODE = '42501', DETAIL = 'CsrfRejected';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT permission ORDER BY permission), ARRAY[]::text[])
    INTO v_permissions
    FROM console_identity.permission_grant
    WHERE subject_id = v_session.subject_id
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL;

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'expiresAt', v_session.expires_at,
    'revokedAt', v_session.revoked_at,
    'authorityFresh', true,
    'permissions', to_jsonb(v_permissions),
    'permissionRevision', v_authority.permission_revision,
    'revokeEpoch', v_authority.revoke_epoch,
    'aal', v_session.aal
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.resolve_browser_session(bytea, bytea, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.resolve_browser_session(bytea, bytea, boolean) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.accept_operation(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_required_permission text,
  p_action_id text,
  p_action_version text,
  p_target_ref text,
  p_payload_digest text,
  p_risk text,
  p_reason text,
  p_plan_revision text,
  p_approval_required boolean,
  p_idempotency_key text,
  p_correlation_id text,
  p_source_revision text DEFAULT NULL,
  p_owner_ref text DEFAULT NULL,
  p_expected_postcondition jsonb DEFAULT NULL
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_operation console_operation.operation;
  v_request_digest text;
  v_outbox_payload jsonb;
BEGIN
  IF p_payload_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid payload digest' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_risk NOT IN ('R0', 'R1', 'R2', 'R3') THEN
    RAISE EXCEPTION 'invalid operation risk' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_risk <> 'R0' AND length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'operation reason is required' USING ERRCODE = '22023', DETAIL = 'ReasonRequired';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = p_required_permission
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF p_risk IN ('R2', 'R3') AND v_session.aal <> 'aal2' THEN
    RAISE EXCEPTION 'recent aal2 is required' USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'actionId', p_action_id,
    'actionVersion', p_action_version,
    'targetRef', p_target_ref,
    'requiredPermission', p_required_permission,
    'payloadDigest', p_payload_digest,
    'risk', p_risk,
    'reason', COALESCE(p_reason, ''),
    'planRevision', p_plan_revision,
    'approvalRequired', p_approval_required,
    'sourceRevision', p_source_revision,
    'ownerRef', p_owner_ref,
    'expectedPostcondition', p_expected_postcondition
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_ref::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE actor_ref = p_actor_ref AND idempotency_key = p_idempotency_key
    FOR UPDATE;
  IF FOUND THEN
    IF v_operation.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request'
        USING ERRCODE = '23505', DETAIL = 'IdempotencyMismatch';
    END IF;
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;

  INSERT INTO console_operation.operation(
    action_id, action_version, actor_ref, target_ref, required_permission,
    payload_digest, request_digest, risk, reason, aal, permission_revision,
    plan_revision, approval_required, idempotency_key, correlation_id,
    source_revision, owner_ref, state, expected_postcondition
  ) VALUES (
    p_action_id, p_action_version, p_actor_ref, p_target_ref, p_required_permission,
    p_payload_digest, v_request_digest, p_risk, COALESCE(p_reason, ''), v_session.aal,
    v_authority.permission_revision, p_plan_revision, p_approval_required,
    p_idempotency_key, p_correlation_id, p_source_revision, p_owner_ref,
    'Planned', p_expected_postcondition
  ) RETURNING * INTO v_operation;

  v_outbox_payload := jsonb_build_object(
    'schemaVersion', '1.0',
    'eventType', 'OperationPlanned',
    'operationId', v_operation.operation_id,
    'actionId', v_operation.action_id,
    'actionVersion', v_operation.action_version,
    'targetRef', v_operation.target_ref,
    'payloadDigest', v_operation.payload_digest,
    'risk', v_operation.risk,
    'approvalRequired', v_operation.approval_required,
    'correlationId', v_operation.correlation_id
  );
  INSERT INTO console_operation.outbox(operation_id, event_type, payload, payload_digest)
  VALUES (v_operation.operation_id, 'OperationPlanned', v_outbox_payload, v_operation.payload_digest);

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    v_operation.actor_ref::text,
    v_operation.action_id,
    v_operation.target_ref,
    'accepted',
    v_operation.reason,
    jsonb_build_object(
      'requestDigest', v_operation.request_digest,
      'payloadDigest', v_operation.payload_digest,
      'risk', v_operation.risk,
      'aal', v_operation.aal,
      'permissionRevision', v_operation.permission_revision,
      'approvalRequired', v_operation.approval_required
    )
  );

  UPDATE console_identity.browser_session
    SET last_seen_at = statement_timestamp()
    WHERE session_id = v_session.session_id;

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.accept_operation(
  uuid, uuid, bigint, bigint, text, text, text, text, text, text, text, text,
  boolean, text, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.accept_operation(
  uuid, uuid, bigint, bigint, text, text, text, text, text, text, text, text,
  boolean, text, text, text, text, jsonb
) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.get_operation(
  p_session_id uuid,
  p_actor_ref uuid,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_operation console_operation.operation;
BEGIN
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id AND actor_ref = p_actor_ref;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_operation);
END;
$$;

REVOKE ALL ON FUNCTION console_operation.get_operation(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.get_operation(uuid, uuid, uuid) TO console_api;

COMMENT ON SCHEMA console_identity IS 'Supabase-backed Console identity projections and opaque sessions';
COMMENT ON SCHEMA console_operation IS 'Durable intent, idempotency and external-effect outbox authority';
COMMENT ON SCHEMA console_audit IS 'Append-only Console security and operation evidence';
COMMENT ON TABLE console_operation.operation IS 'State changes require compare-and-set on state_version by constrained functions';
COMMENT ON FUNCTION console_operation.accept_operation(
  uuid, uuid, bigint, bigint, text, text, text, text, text, text, text, text,
  boolean, text, text, text, text, jsonb
) IS 'Atomically revalidates session and permission, accepts an idempotent intent, and appends audit/outbox evidence';

COMMIT;
