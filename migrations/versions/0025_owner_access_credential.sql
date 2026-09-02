CREATE OR REPLACE FUNCTION console_identity.prepare_owner_access_credential(
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
  v_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session
   WHERE token_digest = p_token_digest FOR SHARE;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_now OR v_session.absolute_expires_at <= v_now
      OR v_session.access_token_expires_at <= v_now + interval '30 seconds'
      OR v_session.access_token_ciphertext IS NULL THEN
    RAISE EXCEPTION 'active browser owner credential is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF p_require_csrf AND (
      p_csrf_token_digest IS NULL OR v_session.csrf_token_digest <> p_csrf_token_digest
  ) THEN
    RAISE EXCEPTION 'Console session CSRF validation failed'
      USING ERRCODE = '42501', DETAIL = 'CsrfRejected';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
   WHERE subject_id = v_session.subject_id FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'accessTokenCiphertext', v_session.access_token_ciphertext,
    'accessTokenExpiresAt', v_session.access_token_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.resolve_owner_access_authority(
  p_subject_id uuid,
  p_auth_session_ref text
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
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_subject_id IS NULL OR p_auth_session_ref IS NULL
      OR length(p_auth_session_ref) NOT BETWEEN 1 AND 256
      OR p_auth_session_ref ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'owner access authority request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.browser_session
   WHERE subject_id = p_subject_id
     AND auth_session_ref = p_auth_session_ref
     AND revoked_at IS NULL
     AND expires_at > v_now
     AND absolute_expires_at > v_now
     AND access_token_expires_at > v_now
   ORDER BY created_at DESC
   LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active owner access authority is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
   WHERE subject_id = p_subject_id FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT permission ORDER BY permission), ARRAY[]::text[])
    INTO v_permissions FROM console_identity.permission_grant
   WHERE subject_id = p_subject_id
     AND grant_revision <= v_authority.permission_revision
     AND revoked_at IS NULL;
  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'expiresAt', v_session.expires_at,
    'absoluteExpiresAt', v_session.absolute_expires_at,
    'accessTokenExpiresAt', v_session.access_token_expires_at,
    'revokedAt', v_session.revoked_at,
    'authorityFresh', true,
    'permissions', to_jsonb(v_permissions),
    'permissionRevision', v_authority.permission_revision,
    'revokeEpoch', v_authority.revoke_epoch,
    'aal', v_session.aal
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.prepare_owner_access_credential(bytea, bytea, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.resolve_owner_access_authority(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.prepare_owner_access_credential(bytea, bytea, boolean) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.resolve_owner_access_authority(uuid, text) TO console_api;

COMMENT ON FUNCTION console_identity.prepare_owner_access_credential(bytea, bytea, boolean)
  IS 'Revalidates one current opaque browser session before C_API exchanges its encrypted Supabase access credential for an internal Owner request.';
COMMENT ON FUNCTION console_identity.resolve_owner_access_authority(uuid, text)
  IS 'Binds an Owner-presented Supabase access credential to its still-active target browser session and current permission revision.';
