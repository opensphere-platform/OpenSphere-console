CREATE OR REPLACE FUNCTION console_identity.get_browser_session_preference_credentials(
  p_token_digest bytea
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
  IF octet_length(p_token_digest) <> 32 THEN
    RAISE EXCEPTION 'session preference proof is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_session.absolute_expires_at <= statement_timestamp()
      OR v_session.access_token_ciphertext IS NULL
      OR v_session.access_token_expires_at IS NULL
      OR v_session.access_token_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session credential is required'
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
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'accessTokenCiphertext', v_session.access_token_ciphertext
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.prepare_browser_session_preference_update(
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_persistence text,
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
  v_event console_audit.event;
BEGIN
  IF octet_length(p_token_digest) <> 32 OR octet_length(p_csrf_token_digest) <> 32
      OR p_persistence NOT IN ('browser', '1h', '4h', '8h', '12h', '24h', '3d', '7d', '14d', '30d')
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'session preference update request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_session.absolute_expires_at <= statement_timestamp()
      OR v_session.csrf_token_digest <> p_csrf_token_digest
      OR v_session.access_token_ciphertext IS NULL
      OR v_session.access_token_expires_at IS NULL
      OR v_session.access_token_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session with CSRF proof is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  v_event := console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    v_session.subject_id::text,
    'console.identity.session.preference.update',
    'subject:' || v_session.subject_id::text || ':session-preference',
    'accepted',
    'self-service-session-preference',
    jsonb_build_object(
      'sessionId', v_session.session_id,
      'duration', p_persistence,
      'appliesTo', 'next-login',
      'permissionRevision', v_session.permission_revision,
      'revokeEpoch', v_session.revoke_epoch
    )
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'accessTokenCiphertext', v_session.access_token_ciphertext,
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.get_browser_session_preference_credentials(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.prepare_browser_session_preference_update(bytea, bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.get_browser_session_preference_credentials(bytea) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.prepare_browser_session_preference_update(bytea, bytea, text, text) TO console_api;

COMMENT ON FUNCTION console_identity.get_browser_session_preference_credentials(bytea)
  IS 'Returns C_API-only encrypted Auth context for reading the current subject session preference.';
COMMENT ON FUNCTION console_identity.prepare_browser_session_preference_update(bytea, bytea, text, text)
  IS 'Persists no-secret self-service preference intent before C_API updates the same Supabase subject.';
