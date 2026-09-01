ALTER TABLE console_identity.browser_session
  ADD COLUMN last_reauthenticated_at timestamptz;

CREATE OR REPLACE FUNCTION console_identity.mark_browser_session_aal2_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, console_identity
AS $$
BEGIN
  IF NEW.aal = 'aal2' AND OLD.aal <> 'aal2' AND NEW.last_reauthenticated_at IS NULL THEN
    NEW.last_reauthenticated_at := statement_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER browser_session_aal2_transition
  BEFORE UPDATE OF aal ON console_identity.browser_session
  FOR EACH ROW EXECUTE FUNCTION console_identity.mark_browser_session_aal2_transition();

CREATE OR REPLACE FUNCTION console_identity.get_browser_session_step_up_credentials(
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
    RAISE EXCEPTION 'step-up session proof is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp()
      OR v_session.absolute_expires_at <= statement_timestamp()
      OR v_session.csrf_token_digest <> p_csrf_token_digest
      OR v_session.access_token_ciphertext IS NULL OR v_session.refresh_token_ciphertext IS NULL
      OR v_session.access_token_expires_at IS NULL THEN
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
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'accessTokenCiphertext', v_session.access_token_ciphertext,
    'expectedAccessCiphertextDigest', encode(
      sha256(convert_to(v_session.access_token_ciphertext, 'UTF8')), 'hex'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.get_browser_session_step_up_credentials(bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.get_browser_session_step_up_credentials(bytea, bytea) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.complete_browser_session_step_up(
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
      OR p_access_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_access_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_refresh_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_refresh_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_auth_session_ref IS NULL OR length(p_auth_session_ref) NOT BETWEEN 1 AND 256
      OR p_auth_session_ref ~ '[[:cntrl:]]'
      OR p_access_token_expires_at <= v_now OR p_access_token_expires_at > v_now + interval '30 days'
      OR p_correlation_id IS NULL OR length(p_correlation_id) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'browser session step-up completion request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_subject_id OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_now OR v_session.absolute_expires_at <= v_now
      OR sha256(convert_to(v_session.access_token_ciphertext, 'UTF8'))
        <> p_expected_access_ciphertext_digest THEN
    RAISE EXCEPTION 'active step-up session changed or expired'
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
    SET aal = 'aal2', last_reauthenticated_at = v_now,
        auth_session_ref = p_auth_session_ref,
        access_token_ciphertext = p_access_token_ciphertext,
        refresh_token_ciphertext = p_refresh_token_ciphertext,
        access_token_expires_at = p_access_token_expires_at
    WHERE session_id = v_session.session_id RETURNING * INTO v_session;
  PERFORM console_audit.append_event_internal(
    NULL, p_correlation_id, p_subject_id::text, 'console.identity.session.step_up',
    'browser-session:' || v_session.session_id::text, 'succeeded', 'aal2',
    jsonb_build_object(
      'sessionId', v_session.session_id, 'aal', v_session.aal,
      'reauthenticatedAt', v_session.last_reauthenticated_at,
      'permissionRevision', v_session.permission_revision, 'revokeEpoch', v_session.revoke_epoch
    )
  );
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'state', 'active', 'aal', v_session.aal,
    'reauthenticatedAt', v_session.last_reauthenticated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.complete_browser_session_step_up(
  uuid, uuid, bytea, text, text, text, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.complete_browser_session_step_up(
  uuid, uuid, bytea, text, text, text, timestamptz, text
) TO console_api;
