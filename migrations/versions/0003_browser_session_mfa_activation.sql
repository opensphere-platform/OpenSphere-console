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
  IF octet_length(p_token_digest) <> 32 OR octet_length(p_csrf_token_digest) <> 32 THEN
    RAISE EXCEPTION 'pending MFA session proof is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND
      OR v_session.revoked_at IS NULL
      OR v_session.revoke_reason <> 'pending-mfa'
      OR v_session.aal <> 'aal1'
      OR v_session.expires_at <= statement_timestamp()
      OR v_session.access_token_ciphertext IS NULL
      OR v_session.refresh_token_ciphertext IS NULL THEN
    RAISE EXCEPTION 'pending MFA session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF v_session.csrf_token_digest <> p_csrf_token_digest THEN
    RAISE EXCEPTION 'Console session CSRF validation failed'
      USING ERRCODE = '42501', DETAIL = 'CsrfRejected';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id;
  IF NOT FOUND
      OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'expiresAt', v_session.expires_at,
    'accessTokenCiphertext', v_session.access_token_ciphertext,
    'refreshTokenCiphertext', v_session.refresh_token_ciphertext,
    'authSessionRef', v_session.auth_session_ref,
    'permissionRevision', v_session.permission_revision,
    'revokeEpoch', v_session.revoke_epoch,
    'aal', v_session.aal
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.get_pending_browser_session_mfa(bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.get_pending_browser_session_mfa(bytea, bytea) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.activate_browser_session_mfa(
  p_session_id uuid,
  p_subject_id uuid,
  p_expected_access_ciphertext_digest bytea,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_auth_session_ref text,
  p_expires_at timestamptz,
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
  IF p_session_id IS NULL
      OR p_subject_id IS NULL
      OR octet_length(p_expected_access_ciphertext_digest) <> 32
      OR p_access_token_ciphertext IS NULL
      OR p_access_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_access_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_refresh_token_ciphertext IS NULL
      OR p_refresh_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_refresh_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_auth_session_ref IS NULL
      OR length(p_auth_session_ref) NOT BETWEEN 1 AND 256
      OR p_auth_session_ref ~ '[[:cntrl:]]'
      OR p_expires_at <= v_now
      OR p_expires_at > v_now + interval '30 days'
      OR p_correlation_id IS NULL
      OR length(p_correlation_id) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'browser session MFA activation request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND
      OR v_session.subject_id <> p_subject_id
      OR v_session.revoked_at IS NULL
      OR v_session.revoke_reason <> 'pending-mfa'
      OR v_session.aal <> 'aal1'
      OR v_session.expires_at <= v_now
      OR sha256(convert_to(v_session.access_token_ciphertext, 'UTF8'))
         <> p_expected_access_ciphertext_digest THEN
    RAISE EXCEPTION 'pending MFA session changed or expired'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_subject_id
    FOR SHARE;
  IF NOT FOUND
      OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  UPDATE console_identity.browser_session
    SET aal = 'aal2',
        expires_at = p_expires_at,
        revoked_at = NULL,
        revoke_reason = NULL,
        last_seen_at = v_now,
        auth_session_ref = p_auth_session_ref,
        access_token_ciphertext = p_access_token_ciphertext,
        refresh_token_ciphertext = p_refresh_token_ciphertext
    WHERE session_id = v_session.session_id
    RETURNING * INTO v_session;

  PERFORM console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    p_subject_id::text,
    'console.identity.session.mfa',
    'browser-session:' || v_session.session_id::text,
    'succeeded',
    'aal2',
    jsonb_build_object(
      'sessionId', v_session.session_id,
      'aal', v_session.aal,
      'expiresAt', v_session.expires_at,
      'permissionRevision', v_session.permission_revision,
      'revokeEpoch', v_session.revoke_epoch
    )
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'state', 'active',
    'createdAt', v_session.created_at,
    'lastSeenAt', v_session.last_seen_at,
    'expiresAt', v_session.expires_at,
    'aal', v_session.aal,
    'permissionRevision', v_session.permission_revision,
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

COMMENT ON FUNCTION console_identity.get_pending_browser_session_mfa(bytea, bytea)
IS 'Returns a CSRF-bound pending MFA credential envelope only to the Console API runtime role';
COMMENT ON FUNCTION console_identity.activate_browser_session_mfa(
  uuid, uuid, bytea, text, text, text, timestamptz, text
) IS 'Atomically activates one unchanged pending browser session after Supabase Auth returns current aal2 credentials';
