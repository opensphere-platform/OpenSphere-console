ALTER TABLE console_identity.browser_session
  ADD COLUMN absolute_expires_at timestamptz,
  ADD COLUMN persistence text;

UPDATE console_identity.browser_session
SET absolute_expires_at = expires_at,
    persistence = '24h';

ALTER TABLE console_identity.browser_session
  ALTER COLUMN absolute_expires_at SET NOT NULL,
  ALTER COLUMN persistence SET NOT NULL,
  ADD CONSTRAINT browser_session_persistence_closed
    CHECK (persistence IN ('browser', '1h', '4h', '8h', '12h', '24h', '3d', '7d', '14d', '30d')),
  ADD CONSTRAINT browser_session_idle_within_absolute
    CHECK (expires_at <= absolute_expires_at AND absolute_expires_at > created_at);

REVOKE ALL ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, timestamptz, boolean, text
) FROM console_api;

CREATE OR REPLACE FUNCTION console_identity.issue_browser_session(
  p_subject_id uuid,
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_auth_session_ref text,
  p_aal text,
  p_access_token_expires_at timestamptz,
  p_absolute_expires_at timestamptz,
  p_persistence text,
  p_pending_mfa boolean,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_authority console_identity.subject_authority;
  v_session console_identity.browser_session;
  v_now timestamptz := statement_timestamp();
  v_duration interval;
  v_idle_expires_at timestamptz;
BEGIN
  v_duration := CASE p_persistence
    WHEN 'browser' THEN interval '24 hours'
    WHEN '1h' THEN interval '1 hour'
    WHEN '4h' THEN interval '4 hours'
    WHEN '8h' THEN interval '8 hours'
    WHEN '12h' THEN interval '12 hours'
    WHEN '24h' THEN interval '24 hours'
    WHEN '3d' THEN interval '3 days'
    WHEN '7d' THEN interval '7 days'
    WHEN '14d' THEN interval '14 days'
    WHEN '30d' THEN interval '30 days'
    ELSE NULL
  END;
  IF p_subject_id IS NULL
      OR octet_length(p_token_digest) <> 32
      OR octet_length(p_csrf_token_digest) <> 32
      OR p_token_digest = p_csrf_token_digest
      OR p_access_token_ciphertext IS NULL
      OR p_access_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_access_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_refresh_token_ciphertext IS NULL
      OR p_refresh_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_refresh_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_auth_session_ref IS NULL
      OR length(p_auth_session_ref) NOT BETWEEN 1 AND 256
      OR p_auth_session_ref ~ '[[:cntrl:]]'
      OR p_aal NOT IN ('aal1', 'aal2')
      OR p_access_token_expires_at <= v_now
      OR p_access_token_expires_at > v_now + interval '30 days'
      OR v_duration IS NULL
      OR p_absolute_expires_at < v_now + v_duration - interval '2 minutes'
      OR p_absolute_expires_at > v_now + v_duration + interval '2 minutes'
      OR p_pending_mfa IS NULL
      OR (p_pending_mfa AND p_aal <> 'aal1')
      OR p_correlation_id IS NULL
      OR length(p_correlation_id) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'browser session issue request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_subject_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Console subject authority is unavailable'
      USING ERRCODE = '28000', DETAIL = 'SubjectAuthorityMissing';
  END IF;

  v_idle_expires_at := LEAST(
    p_absolute_expires_at,
    v_now + CASE WHEN p_pending_mfa THEN interval '5 minutes' ELSE interval '12 hours' END
  );
  INSERT INTO console_identity.browser_session(
    subject_id, token_digest, csrf_token_digest, aal,
    permission_revision, revoke_epoch, expires_at, absolute_expires_at, persistence,
    revoked_at, revoke_reason, auth_session_ref, access_token_ciphertext,
    refresh_token_ciphertext, access_token_expires_at
  ) VALUES (
    p_subject_id, p_token_digest, p_csrf_token_digest, p_aal,
    v_authority.permission_revision, v_authority.revoke_epoch,
    v_idle_expires_at, p_absolute_expires_at, p_persistence,
    CASE WHEN p_pending_mfa THEN v_now ELSE NULL END,
    CASE WHEN p_pending_mfa THEN 'pending-mfa' ELSE NULL END,
    p_auth_session_ref, p_access_token_ciphertext,
    p_refresh_token_ciphertext, p_access_token_expires_at
  ) RETURNING * INTO v_session;

  PERFORM console_audit.append_event_internal(
    NULL, p_correlation_id, p_subject_id::text, 'console.identity.session.login',
    'browser-session:' || v_session.session_id::text,
    CASE WHEN p_pending_mfa THEN 'accepted' ELSE 'succeeded' END,
    CASE WHEN p_pending_mfa THEN 'pending-mfa' ELSE '' END,
    jsonb_build_object(
      'sessionId', v_session.session_id,
      'state', CASE WHEN p_pending_mfa THEN 'pending_mfa' ELSE 'active' END,
      'aal', v_session.aal,
      'persistence', v_session.persistence,
      'idleExpiresAt', v_session.expires_at,
      'absoluteExpiresAt', v_session.absolute_expires_at,
      'accessTokenExpiresAt', v_session.access_token_expires_at,
      'permissionRevision', v_session.permission_revision,
      'revokeEpoch', v_session.revoke_epoch
    )
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'state', CASE WHEN p_pending_mfa THEN 'pending_mfa' ELSE 'active' END,
    'createdAt', v_session.created_at, 'lastSeenAt', v_session.last_seen_at,
    'expiresAt', v_session.expires_at, 'idleExpiresAt', v_session.expires_at,
    'absoluteExpiresAt', v_session.absolute_expires_at, 'persistence', v_session.persistence,
    'accessTokenExpiresAt', v_session.access_token_expires_at,
    'aal', v_session.aal, 'permissionRevision', v_session.permission_revision,
    'revokeEpoch', v_session.revoke_epoch
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, timestamptz, text, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, timestamptz, text, boolean, text
) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.get_pending_browser_session_mfa(
  p_token_digest bytea,
  p_csrf_token_digest bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NULL OR v_session.revoke_reason <> 'pending-mfa'
      OR v_session.aal <> 'aal1' OR v_session.expires_at <= statement_timestamp()
      OR v_session.csrf_token_digest <> p_csrf_token_digest THEN
    RAISE EXCEPTION 'pending MFA session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'accessTokenCiphertext', v_session.access_token_ciphertext,
    'expectedAccessCiphertextDigest', encode(sha256(convert_to(v_session.access_token_ciphertext, 'UTF8')), 'hex'),
    'persistence', v_session.persistence, 'absoluteExpiresAt', v_session.absolute_expires_at,
    'expiresAt', v_session.expires_at, 'accessTokenExpiresAt', v_session.access_token_expires_at,
    'permissionRevision', v_session.permission_revision, 'revokeEpoch', v_session.revoke_epoch
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.activate_browser_session_mfa(
  uuid, uuid, bytea, text, text, text, timestamptz, timestamptz, text
) FROM console_api;

DROP FUNCTION console_identity.activate_browser_session_mfa(
  uuid, uuid, bytea, text, text, text, timestamptz, text
);

CREATE OR REPLACE FUNCTION console_identity.activate_browser_session_mfa(
  p_session_id uuid,
  p_subject_id uuid,
  p_expected_access_ciphertext_digest bytea,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_auth_session_ref text,
  p_access_token_expires_at timestamptz,
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
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_session_id IS NULL OR p_subject_id IS NULL
      OR octet_length(p_expected_access_ciphertext_digest) <> 32
      OR p_access_token_ciphertext IS NULL
      OR p_access_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_access_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_refresh_token_ciphertext IS NULL
      OR p_refresh_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_refresh_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_auth_session_ref IS NULL OR length(p_auth_session_ref) NOT BETWEEN 1 AND 256
      OR p_auth_session_ref ~ '[[:cntrl:]]'
      OR p_access_token_expires_at <= v_now OR p_access_token_expires_at > v_now + interval '30 days'
      OR p_correlation_id IS NULL OR length(p_correlation_id) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'browser session MFA activation request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_subject_id OR v_session.revoked_at IS NULL
      OR v_session.revoke_reason <> 'pending-mfa' OR v_session.aal <> 'aal1'
      OR v_session.expires_at <= v_now OR v_session.absolute_expires_at <= v_now
      OR sha256(convert_to(v_session.access_token_ciphertext, 'UTF8')) <> p_expected_access_ciphertext_digest THEN
    RAISE EXCEPTION 'pending MFA session changed or expired'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = p_subject_id FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  UPDATE console_identity.browser_session
    SET aal = 'aal2', expires_at = LEAST(v_session.absolute_expires_at, v_now + interval '12 hours'),
        revoked_at = NULL, revoke_reason = NULL, last_seen_at = v_now,
        auth_session_ref = p_auth_session_ref,
        access_token_ciphertext = p_access_token_ciphertext,
        refresh_token_ciphertext = p_refresh_token_ciphertext,
        access_token_expires_at = p_access_token_expires_at
    WHERE session_id = v_session.session_id RETURNING * INTO v_session;

  PERFORM console_audit.append_event_internal(
    NULL, p_correlation_id, p_subject_id::text, 'console.identity.session.mfa',
    'browser-session:' || v_session.session_id::text, 'succeeded', 'aal2',
    jsonb_build_object(
      'sessionId', v_session.session_id, 'aal', v_session.aal,
      'persistence', v_session.persistence, 'idleExpiresAt', v_session.expires_at,
      'absoluteExpiresAt', v_session.absolute_expires_at,
      'accessTokenExpiresAt', v_session.access_token_expires_at,
      'permissionRevision', v_session.permission_revision, 'revokeEpoch', v_session.revoke_epoch
    )
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id, 'state', 'active',
    'createdAt', v_session.created_at, 'lastSeenAt', v_session.last_seen_at,
    'expiresAt', v_session.expires_at, 'idleExpiresAt', v_session.expires_at,
    'absoluteExpiresAt', v_session.absolute_expires_at, 'persistence', v_session.persistence,
    'accessTokenExpiresAt', v_session.access_token_expires_at,
    'aal', v_session.aal, 'permissionRevision', v_session.permission_revision,
    'revokeEpoch', v_session.revoke_epoch
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.activate_browser_session_mfa(
  uuid, uuid, bytea, text, text, text, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.activate_browser_session_mfa(
  uuid, uuid, bytea, text, text, text, timestamptz, text
) TO console_api;

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
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF p_require_csrf AND (p_csrf_token_digest IS NULL OR v_session.csrf_token_digest <> p_csrf_token_digest) THEN
    RAISE EXCEPTION 'Console session CSRF validation failed' USING ERRCODE = '42501', DETAIL = 'CsrfRejected';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT permission ORDER BY permission), ARRAY[]::text[])
    INTO v_permissions FROM console_identity.permission_grant
    WHERE subject_id = v_session.subject_id
      AND grant_revision <= v_authority.permission_revision AND revoked_at IS NULL;
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'expiresAt', v_session.expires_at, 'idleExpiresAt', v_session.expires_at,
    'absoluteExpiresAt', v_session.absolute_expires_at, 'persistence', v_session.persistence,
    'lastSeenAt', v_session.last_seen_at, 'accessTokenExpiresAt', v_session.access_token_expires_at,
    'revokedAt', v_session.revoked_at, 'authorityFresh', true,
    'permissions', to_jsonb(v_permissions), 'permissionRevision', v_authority.permission_revision,
    'revokeEpoch', v_authority.revoke_epoch, 'aal', v_session.aal
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.touch_browser_session_activity(
  p_token_digest bytea,
  p_csrf_token_digest bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF octet_length(p_token_digest) <> 32 OR octet_length(p_csrf_token_digest) <> 32 THEN
    RAISE EXCEPTION 'browser session activity proof is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest FOR UPDATE;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= v_now
      OR v_session.csrf_token_digest <> p_csrf_token_digest THEN
    RAISE EXCEPTION 'active Console session with CSRF proof is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF v_session.last_seen_at <= v_now - interval '1 minute' THEN
    UPDATE console_identity.browser_session
      SET last_seen_at = v_now,
          expires_at = LEAST(absolute_expires_at, v_now + interval '12 hours')
      WHERE session_id = v_session.session_id
      RETURNING * INTO v_session;
  END IF;
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'state', 'active', 'createdAt', v_session.created_at, 'lastSeenAt', v_session.last_seen_at,
    'idleExpiresAt', v_session.expires_at, 'absoluteExpiresAt', v_session.absolute_expires_at,
    'persistence', v_session.persistence, 'aal', v_session.aal
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.touch_browser_session_activity(bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.touch_browser_session_activity(bytea, bytea) TO console_api;

COMMENT ON COLUMN console_identity.browser_session.expires_at
  IS 'Current idle expiry; every protected authority function checks it and activity may extend it only up to absolute_expires_at.';
COMMENT ON COLUMN console_identity.browser_session.absolute_expires_at
  IS 'Immutable login lifetime bound selected from the closed account persistence policy.';
COMMENT ON COLUMN console_identity.browser_session.persistence
  IS 'Closed account session persistence policy applied by C_API at login.';
COMMENT ON FUNCTION console_identity.touch_browser_session_activity(bytea, bytea)
  IS 'C_API-only trusted activity touch, rate-limited in-row to one write per minute and bounded by absolute lifetime.';
