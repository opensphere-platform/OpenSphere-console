CREATE TABLE console_identity.cli_device (
  device_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 128 AND label !~ '[\r\n]'),
  public_jwk jsonb NOT NULL CHECK (
    jsonb_typeof(public_jwk) = 'object'
    AND public_jwk->>'kty' = 'EC'
    AND public_jwk->>'crv' = 'P-256'
    AND public_jwk->>'x' ~ '^[A-Za-z0-9_-]{43}$'
    AND public_jwk->>'y' ~ '^[A-Za-z0-9_-]{43}$'
    AND public_jwk - 'kty' - 'crv' - 'x' - 'y' = '{}'::jsonb
  ),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{2}(:[a-f0-9]{2}){31}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  UNIQUE(subject_id, fingerprint),
  CHECK ((status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND length(btrim(revoke_reason)) BETWEEN 8 AND 500))
);

CREATE TABLE console_identity.cli_enrollment (
  enrollment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 128 AND label !~ '[\r\n]'),
  public_jwk jsonb NOT NULL CHECK (
    jsonb_typeof(public_jwk) = 'object'
    AND public_jwk->>'kty' = 'EC'
    AND public_jwk->>'crv' = 'P-256'
    AND public_jwk->>'x' ~ '^[A-Za-z0-9_-]{43}$'
    AND public_jwk->>'y' ~ '^[A-Za-z0-9_-]{43}$'
    AND public_jwk - 'kty' - 'crv' - 'x' - 'y' = '{}'::jsonb
  ),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{2}(:[a-f0-9]{2}){31}$'),
  user_code_digest bytea NOT NULL UNIQUE CHECK (octet_length(user_code_digest) = 32),
  poll_token_digest bytea NOT NULL UNIQUE CHECK (octet_length(poll_token_digest) = 32),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  expires_at timestamptz NOT NULL,
  subject_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  device_id uuid UNIQUE REFERENCES console_identity.cli_device(device_id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (expires_at > created_at),
  CHECK ((status = 'pending' AND subject_id IS NULL AND device_id IS NULL AND approved_at IS NULL)
    OR (status = 'approved' AND subject_id IS NOT NULL AND device_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE console_identity.cli_challenge (
  challenge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES console_identity.cli_device(device_id) ON DELETE RESTRICT,
  nonce_digest bytea NOT NULL UNIQUE CHECK (octet_length(nonce_digest) = 32),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE TABLE console_identity.cli_session (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES console_identity.cli_device(device_id) ON DELETE RESTRICT,
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  permission_revision bigint NOT NULL CHECK (permission_revision >= 0),
  revoke_epoch bigint NOT NULL CHECK (revoke_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND length(btrim(revoke_reason)) > 0))
);

CREATE INDEX cli_device_subject_created_idx
  ON console_identity.cli_device(subject_id, created_at DESC);
CREATE INDEX cli_enrollment_expiry_idx
  ON console_identity.cli_enrollment(expires_at) WHERE status = 'pending';
CREATE INDEX cli_challenge_device_expiry_idx
  ON console_identity.cli_challenge(device_id, expires_at DESC) WHERE used_at IS NULL;
CREATE INDEX cli_session_subject_active_idx
  ON console_identity.cli_session(subject_id, expires_at DESC) WHERE revoked_at IS NULL;

ALTER TABLE console_identity.cli_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.cli_device FORCE ROW LEVEL SECURITY;
ALTER TABLE console_identity.cli_enrollment ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.cli_enrollment FORCE ROW LEVEL SECURITY;
ALTER TABLE console_identity.cli_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.cli_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE console_identity.cli_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_identity.cli_session FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE console_identity.cli_device, console_identity.cli_enrollment,
  console_identity.cli_challenge, console_identity.cli_session FROM PUBLIC, authenticated, console_api;

CREATE OR REPLACE FUNCTION console_identity.create_cli_device_enrollment(
  p_label text,
  p_public_jwk jsonb,
  p_fingerprint text,
  p_user_code_digest bytea,
  p_poll_token_digest bytea,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_enrollment console_identity.cli_enrollment;
BEGIN
  IF length(btrim(COALESCE(p_label, ''))) NOT BETWEEN 1 AND 128 OR p_label ~ '[\r\n]'
      OR p_public_jwk IS NULL
      OR jsonb_typeof(p_public_jwk) <> 'object'
      OR p_public_jwk->>'kty' <> 'EC' OR p_public_jwk->>'crv' <> 'P-256'
      OR p_public_jwk->>'x' !~ '^[A-Za-z0-9_-]{43}$'
      OR p_public_jwk->>'y' !~ '^[A-Za-z0-9_-]{43}$'
      OR p_public_jwk - 'kty' - 'crv' - 'x' - 'y' <> '{}'::jsonb
      OR p_fingerprint !~ '^[a-f0-9]{2}(:[a-f0-9]{2}){31}$'
      OR octet_length(COALESCE(p_user_code_digest, ''::bytea)) <> 32
      OR octet_length(COALESCE(p_poll_token_digest, ''::bytea)) <> 32
      OR p_expires_at IS NULL OR p_expires_at <= statement_timestamp()
      OR p_expires_at > statement_timestamp() + interval '5 minutes 30 seconds' THEN
    RAISE EXCEPTION 'CLI enrollment request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  INSERT INTO console_identity.cli_enrollment(
    label, public_jwk, fingerprint, user_code_digest, poll_token_digest, expires_at
  ) VALUES (
    btrim(p_label), p_public_jwk, p_fingerprint, p_user_code_digest, p_poll_token_digest, p_expires_at
  ) RETURNING * INTO v_enrollment;
  RETURN jsonb_build_object('enrollmentId', v_enrollment.enrollment_id, 'expiresAt', v_enrollment.expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.get_cli_device_enrollment(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_enrollment_id uuid,
  p_user_code_digest bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_enrollment console_identity.cli_enrollment;
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session WHERE session_id = p_session_id;
  SELECT * INTO v_authority FROM console_identity.subject_authority WHERE subject_id = p_actor_ref;
  IF v_session.session_id IS NULL OR v_authority.subject_id IS NULL
      OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() OR v_session.absolute_expires_at <= statement_timestamp()
      OR v_session.permission_revision <> v_authority.permission_revision
      OR v_session.revoke_epoch <> v_authority.revoke_epoch
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_enrollment FROM console_identity.cli_enrollment
   WHERE enrollment_id = p_enrollment_id
     AND status = 'pending' AND expires_at > statement_timestamp()
     AND user_code_digest = p_user_code_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLI enrollment was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  RETURN jsonb_build_object(
    'enrollmentId', v_enrollment.enrollment_id,
    'label', v_enrollment.label,
    'fingerprint', v_enrollment.fingerprint,
    'expiresAt', v_enrollment.expires_at,
    'status', v_enrollment.status,
    'approvingUser', p_actor_ref
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.approve_cli_device_enrollment(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_enrollment_id uuid,
  p_user_code_digest bytea,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_enrollment console_identity.cli_enrollment;
  v_device console_identity.cli_device;
  v_event console_audit.event;
BEGIN
  IF length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'CLI enrollment approval is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.browser_session WHERE session_id = p_session_id FOR UPDATE;
  SELECT * INTO v_authority FROM console_identity.subject_authority WHERE subject_id = p_actor_ref FOR UPDATE;
  IF v_session.session_id IS NULL OR v_authority.subject_id IS NULL
      OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() OR v_session.absolute_expires_at <= statement_timestamp()
      OR v_session.permission_revision <> v_authority.permission_revision
      OR v_session.revoke_epoch <> v_authority.revoke_epoch
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF v_session.aal <> 'aal2' OR v_session.last_reauthenticated_at IS NULL
      OR v_session.last_reauthenticated_at < statement_timestamp() - interval '5 minutes'
      OR v_session.last_reauthenticated_at > statement_timestamp() + interval '30 seconds' THEN
    RAISE EXCEPTION 'recent aal2 is required for CLI device approval'
      USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;
  SELECT * INTO v_enrollment FROM console_identity.cli_enrollment
   WHERE enrollment_id = p_enrollment_id FOR UPDATE;
  IF NOT FOUND OR v_enrollment.expires_at <= statement_timestamp()
      OR v_enrollment.user_code_digest <> p_user_code_digest THEN
    RAISE EXCEPTION 'CLI enrollment was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  IF v_enrollment.status = 'approved' THEN
    IF v_enrollment.subject_id <> p_actor_ref THEN
      RAISE EXCEPTION 'CLI enrollment was already claimed'
        USING ERRCODE = '23505', DETAIL = 'Conflict';
    END IF;
    SELECT * INTO v_device FROM console_identity.cli_device WHERE device_id = v_enrollment.device_id;
    RETURN jsonb_build_object('deviceId', v_device.device_id, 'label', v_device.label,
      'fingerprint', v_device.fingerprint, 'replayed', true);
  END IF;
  INSERT INTO console_identity.cli_device(subject_id, label, public_jwk, fingerprint)
    VALUES (p_actor_ref, v_enrollment.label, v_enrollment.public_jwk, v_enrollment.fingerprint)
    RETURNING * INTO v_device;
  UPDATE console_identity.cli_enrollment
     SET status = 'approved', subject_id = p_actor_ref,
         device_id = v_device.device_id, approved_at = statement_timestamp()
   WHERE enrollment_id = v_enrollment.enrollment_id;
  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, p_actor_ref::text, 'console.identity.cli.device.approved',
    'cli-device:' || v_device.device_id::text, 'succeeded', 'browser-approved CLI device enrollment',
    jsonb_build_object('enrollmentId', v_enrollment.enrollment_id,
      'fingerprint', v_device.fingerprint, 'permissionRevision', v_authority.permission_revision)
  );
  RETURN jsonb_build_object('deviceId', v_device.device_id, 'label', v_device.label,
    'fingerprint', v_device.fingerprint, 'replayed', false, 'auditEventId', v_event.event_id);
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.poll_cli_device_enrollment(
  p_enrollment_id uuid,
  p_poll_token_digest bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_enrollment console_identity.cli_enrollment;
BEGIN
  SELECT * INTO v_enrollment FROM console_identity.cli_enrollment
   WHERE enrollment_id = p_enrollment_id AND poll_token_digest = p_poll_token_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLI enrollment was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  IF v_enrollment.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'CLI enrollment expired'
      USING ERRCODE = '22023', DETAIL = 'EnrollmentExpired';
  END IF;
  IF v_enrollment.status = 'pending' THEN
    RETURN jsonb_build_object('status', 'pending');
  END IF;
  RETURN jsonb_build_object('status', 'approved', 'deviceId', v_enrollment.device_id,
    'label', v_enrollment.label, 'fingerprint', v_enrollment.fingerprint);
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.create_cli_device_challenge(
  p_device_id uuid,
  p_nonce_digest bytea,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_device console_identity.cli_device;
  v_authority console_identity.subject_authority;
  v_challenge console_identity.cli_challenge;
BEGIN
  IF octet_length(COALESCE(p_nonce_digest, ''::bytea)) <> 32
      OR p_expires_at IS NULL OR p_expires_at <= statement_timestamp()
      OR p_expires_at > statement_timestamp() + interval '90 seconds' THEN
    RAISE EXCEPTION 'CLI challenge request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_device FROM console_identity.cli_device WHERE device_id = p_device_id;
  SELECT * INTO v_authority FROM console_identity.subject_authority WHERE subject_id = v_device.subject_id;
  IF v_device.device_id IS NULL OR v_device.status <> 'active' OR v_authority.subject_id IS NULL THEN
    RAISE EXCEPTION 'CLI device is inactive or unknown'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  INSERT INTO console_identity.cli_challenge(device_id, nonce_digest, expires_at)
    VALUES (p_device_id, p_nonce_digest, p_expires_at) RETURNING * INTO v_challenge;
  RETURN jsonb_build_object('challengeId', v_challenge.challenge_id, 'expiresAt', v_challenge.expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.get_cli_device_challenge(
  p_device_id uuid,
  p_challenge_id uuid,
  p_nonce_digest bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_challenge console_identity.cli_challenge;
  v_device console_identity.cli_device;
BEGIN
  SELECT * INTO v_challenge FROM console_identity.cli_challenge
   WHERE challenge_id = p_challenge_id AND device_id = p_device_id
     AND nonce_digest = p_nonce_digest AND used_at IS NULL
     AND expires_at > statement_timestamp();
  SELECT * INTO v_device FROM console_identity.cli_device
   WHERE device_id = p_device_id AND status = 'active';
  IF v_challenge.challenge_id IS NULL OR v_device.device_id IS NULL THEN
    RAISE EXCEPTION 'CLI challenge is unavailable'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  RETURN jsonb_build_object('deviceId', v_device.device_id, 'subjectId', v_device.subject_id,
    'challengeId', v_challenge.challenge_id, 'publicJwk', v_device.public_jwk,
    'expiresAt', v_challenge.expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.complete_cli_device_session(
  p_device_id uuid,
  p_challenge_id uuid,
  p_nonce_digest bytea,
  p_token_digest bytea,
  p_expires_at timestamptz,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_challenge console_identity.cli_challenge;
  v_device console_identity.cli_device;
  v_authority console_identity.subject_authority;
  v_session console_identity.cli_session;
  v_event console_audit.event;
BEGIN
  IF octet_length(COALESCE(p_nonce_digest, ''::bytea)) <> 32
      OR octet_length(COALESCE(p_token_digest, ''::bytea)) <> 32
      OR p_expires_at IS NULL OR p_expires_at <= statement_timestamp()
      OR p_expires_at > statement_timestamp() + interval '15 minutes 30 seconds'
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'CLI session completion is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_challenge FROM console_identity.cli_challenge
   WHERE challenge_id = p_challenge_id AND device_id = p_device_id FOR UPDATE;
  SELECT * INTO v_device FROM console_identity.cli_device
   WHERE device_id = p_device_id FOR UPDATE;
  SELECT * INTO v_authority FROM console_identity.subject_authority
   WHERE subject_id = v_device.subject_id FOR UPDATE;
  IF v_challenge.challenge_id IS NULL OR v_challenge.used_at IS NOT NULL
      OR v_challenge.expires_at <= statement_timestamp()
      OR v_challenge.nonce_digest <> p_nonce_digest
      OR v_device.device_id IS NULL OR v_device.status <> 'active'
      OR v_authority.subject_id IS NULL THEN
    RAISE EXCEPTION 'CLI challenge is unavailable'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  UPDATE console_identity.cli_challenge SET used_at = statement_timestamp()
   WHERE challenge_id = v_challenge.challenge_id AND used_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLI challenge was already consumed'
      USING ERRCODE = '23505', DETAIL = 'Conflict';
  END IF;
  INSERT INTO console_identity.cli_session(
    subject_id, device_id, token_digest, permission_revision, revoke_epoch, expires_at
  ) VALUES (
    v_device.subject_id, v_device.device_id, p_token_digest,
    v_authority.permission_revision, v_authority.revoke_epoch, p_expires_at
  ) RETURNING * INTO v_session;
  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, v_device.subject_id::text, 'console.identity.cli.session.issued',
    'cli-device:' || v_device.device_id::text, 'succeeded', '',
    jsonb_build_object('sessionId', v_session.session_id, 'expiresAt', v_session.expires_at,
      'permissionRevision', v_session.permission_revision, 'revokeEpoch', v_session.revoke_epoch)
  );
  RETURN jsonb_build_object('sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'deviceId', v_session.device_id, 'expiresAt', v_session.expires_at,
    'permissionRevision', v_session.permission_revision, 'revokeEpoch', v_session.revoke_epoch,
    'auditEventId', v_event.event_id);
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.resolve_cli_session(p_token_digest bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.cli_session;
  v_device console_identity.cli_device;
  v_authority console_identity.subject_authority;
  v_permissions text[];
BEGIN
  IF octet_length(COALESCE(p_token_digest, ''::bytea)) <> 32 THEN
    RAISE EXCEPTION 'CLI session token is invalid'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_session FROM console_identity.cli_session
   WHERE token_digest = p_token_digest FOR UPDATE;
  SELECT * INTO v_device FROM console_identity.cli_device WHERE device_id = v_session.device_id;
  SELECT * INTO v_authority FROM console_identity.subject_authority WHERE subject_id = v_session.subject_id;
  IF v_session.session_id IS NULL OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_device.device_id IS NULL OR v_device.status <> 'active'
      OR v_authority.subject_id IS NULL
      OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'CLI session is inactive or stale'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT permission ORDER BY permission), ARRAY[]::text[])
    INTO v_permissions FROM console_identity.permission_grant
   WHERE subject_id = v_session.subject_id
     AND grant_revision <= v_authority.permission_revision AND revoked_at IS NULL;
  IF v_session.last_used_at < statement_timestamp() - interval '1 minute' THEN
    UPDATE console_identity.cli_session SET last_used_at = statement_timestamp()
     WHERE session_id = v_session.session_id;
    UPDATE console_identity.cli_device SET last_used_at = statement_timestamp()
     WHERE device_id = v_device.device_id;
  END IF;
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'deviceId', v_session.device_id,
    'expiresAt', v_session.expires_at,
    'idleExpiresAt', v_session.expires_at,
    'absoluteExpiresAt', v_session.expires_at,
    'lastSeenAt', v_session.last_used_at,
    'revokedAt', v_session.revoked_at,
    'authorityFresh', true,
    'permissions', to_jsonb(v_permissions),
    'permissionRevision', v_session.permission_revision,
    'revokeEpoch', v_session.revoke_epoch,
    'aal', 'aal1',
    'credentialType', 'cli-device'
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.list_owned_cli_devices(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_items jsonb;
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session WHERE session_id = p_session_id;
  SELECT * INTO v_authority FROM console_identity.subject_authority WHERE subject_id = p_actor_ref;
  IF v_session.session_id IS NULL OR v_authority.subject_id IS NULL
      OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() OR v_session.absolute_expires_at <= statement_timestamp()
      OR v_session.permission_revision <> v_authority.permission_revision
      OR v_session.revoke_epoch <> v_authority.revoke_epoch
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', d.device_id, 'label', d.label, 'fingerprint', d.fingerprint,
    'status', d.status, 'createdAt', d.created_at, 'lastUsedAt', d.last_used_at,
    'revokedAt', d.revoked_at, 'lastSessionExpiresAt', s.last_session_expires_at,
    'user', d.subject_id
  ) ORDER BY d.created_at DESC), '[]'::jsonb) INTO v_items
  FROM console_identity.cli_device d
  LEFT JOIN LATERAL (
    SELECT max(expires_at) AS last_session_expires_at
    FROM console_identity.cli_session cs WHERE cs.device_id = d.device_id
  ) s ON true
  WHERE d.subject_id = p_actor_ref;
  RETURN jsonb_build_object('devices', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.revoke_owned_cli_device(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_device_id uuid,
  p_reason text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_device console_identity.cli_device;
  v_revoked integer := 0;
  v_event console_audit.event;
BEGIN
  IF length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 500 OR p_reason ~ '[\r\n]'
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'CLI device revocation is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.browser_session WHERE session_id = p_session_id FOR UPDATE;
  SELECT * INTO v_authority FROM console_identity.subject_authority WHERE subject_id = p_actor_ref FOR UPDATE;
  IF v_session.session_id IS NULL OR v_authority.subject_id IS NULL
      OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() OR v_session.absolute_expires_at <= statement_timestamp()
      OR v_session.permission_revision <> v_authority.permission_revision
      OR v_session.revoke_epoch <> v_authority.revoke_epoch
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_device FROM console_identity.cli_device
   WHERE device_id = p_device_id AND subject_id = p_actor_ref AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active CLI device was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  UPDATE console_identity.cli_device
     SET status = 'revoked', revoked_at = statement_timestamp(), revoke_reason = btrim(p_reason)
   WHERE device_id = v_device.device_id;
  UPDATE console_identity.cli_session
     SET revoked_at = statement_timestamp(), revoke_reason = 'device-revoked'
   WHERE device_id = v_device.device_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, p_actor_ref::text, 'console.identity.cli.device.revoked',
    'cli-device:' || v_device.device_id::text, 'succeeded', btrim(p_reason),
    jsonb_build_object('revokedSessionCount', v_revoked)
  );
  RETURN jsonb_build_object('deviceId', v_device.device_id,
    'revokedSessionCount', v_revoked, 'auditEventId', v_event.event_id);
END;
$$;

REVOKE ALL ON FUNCTION console_identity.create_cli_device_enrollment(text, jsonb, text, bytea, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.get_cli_device_enrollment(uuid, uuid, bigint, bigint, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.approve_cli_device_enrollment(uuid, uuid, bigint, bigint, uuid, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.poll_cli_device_enrollment(uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.create_cli_device_challenge(uuid, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.get_cli_device_challenge(uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.complete_cli_device_session(uuid, uuid, bytea, bytea, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.resolve_cli_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.list_owned_cli_devices(uuid, uuid, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.revoke_owned_cli_device(uuid, uuid, bigint, bigint, uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION console_identity.create_cli_device_enrollment(text, jsonb, text, bytea, bytea, timestamptz) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.get_cli_device_enrollment(uuid, uuid, bigint, bigint, uuid, bytea) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.approve_cli_device_enrollment(uuid, uuid, bigint, bigint, uuid, bytea, text) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.poll_cli_device_enrollment(uuid, bytea) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.create_cli_device_challenge(uuid, bytea, timestamptz) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.get_cli_device_challenge(uuid, uuid, bytea) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.complete_cli_device_session(uuid, uuid, bytea, bytea, timestamptz, text) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.resolve_cli_session(bytea) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.list_owned_cli_devices(uuid, uuid, bigint, bigint) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.revoke_owned_cli_device(uuid, uuid, bigint, bigint, uuid, text, text) TO console_api;

COMMENT ON TABLE console_identity.cli_device IS 'Browser-approved P-256 public keys for interactive OS CLI login; private keys never enter Console.';
COMMENT ON TABLE console_identity.cli_enrollment IS 'Five-minute device enrollment handshakes with digest-only approval and poll secrets.';
COMMENT ON TABLE console_identity.cli_challenge IS 'One-time digest-only possession challenges for approved CLI devices.';
COMMENT ON TABLE console_identity.cli_session IS 'Fifteen-minute opaque CLI sessions bound to current permission revision and revoke epoch.';
