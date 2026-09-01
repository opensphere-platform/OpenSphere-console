ALTER TABLE console_identity.browser_session
  ADD COLUMN access_token_expires_at timestamptz;

UPDATE console_identity.browser_session
SET access_token_expires_at = LEAST(expires_at, statement_timestamp())
WHERE access_token_ciphertext IS NOT NULL
  AND refresh_token_ciphertext IS NOT NULL;

ALTER TABLE console_identity.browser_session
  ADD CONSTRAINT browser_session_credential_expiry_complete
  CHECK (
    (access_token_ciphertext IS NULL AND refresh_token_ciphertext IS NULL AND access_token_expires_at IS NULL)
    OR
    (access_token_ciphertext IS NOT NULL AND refresh_token_ciphertext IS NOT NULL AND access_token_expires_at IS NOT NULL)
  );

REVOKE ALL ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, boolean, text
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
  p_expires_at timestamptz,
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
BEGIN
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
      OR p_expires_at <= v_now
      OR p_expires_at > v_now + interval '30 days'
      OR p_pending_mfa IS NULL
      OR (p_pending_mfa AND (p_aal <> 'aal1' OR p_expires_at > v_now + interval '5 minutes'))
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

  INSERT INTO console_identity.browser_session(
    subject_id, token_digest, csrf_token_digest, aal,
    permission_revision, revoke_epoch, expires_at, revoked_at, revoke_reason,
    auth_session_ref, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at
  ) VALUES (
    p_subject_id, p_token_digest, p_csrf_token_digest, p_aal,
    v_authority.permission_revision, v_authority.revoke_epoch, p_expires_at,
    CASE WHEN p_pending_mfa THEN v_now ELSE NULL END,
    CASE WHEN p_pending_mfa THEN 'pending-mfa' ELSE NULL END,
    p_auth_session_ref, p_access_token_ciphertext, p_refresh_token_ciphertext, p_access_token_expires_at
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
      'expiresAt', v_session.expires_at,
      'accessTokenExpiresAt', v_session.access_token_expires_at,
      'permissionRevision', v_session.permission_revision,
      'revokeEpoch', v_session.revoke_epoch
    )
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id,
    'state', CASE WHEN p_pending_mfa THEN 'pending_mfa' ELSE 'active' END,
    'createdAt', v_session.created_at, 'lastSeenAt', v_session.last_seen_at,
    'expiresAt', v_session.expires_at, 'accessTokenExpiresAt', v_session.access_token_expires_at,
    'aal', v_session.aal, 'permissionRevision', v_session.permission_revision,
    'revokeEpoch', v_session.revoke_epoch
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, timestamptz, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, timestamptz, boolean, text
) TO console_api;

REVOKE ALL ON FUNCTION console_identity.activate_browser_session_mfa(
  uuid, uuid, bytea, text, text, text, timestamptz, text
) FROM console_api;

CREATE OR REPLACE FUNCTION console_identity.activate_browser_session_mfa(
  p_session_id uuid,
  p_subject_id uuid,
  p_expected_access_ciphertext_digest bytea,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_auth_session_ref text,
  p_access_token_expires_at timestamptz,
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
      OR p_expires_at <= v_now OR p_expires_at > v_now + interval '30 days'
      OR p_correlation_id IS NULL OR length(p_correlation_id) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'browser session MFA activation request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_subject_id OR v_session.revoked_at IS NULL
      OR v_session.revoke_reason <> 'pending-mfa' OR v_session.aal <> 'aal1'
      OR v_session.expires_at <= v_now
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
    SET aal = 'aal2', expires_at = p_expires_at, revoked_at = NULL, revoke_reason = NULL,
        last_seen_at = v_now, auth_session_ref = p_auth_session_ref,
        access_token_ciphertext = p_access_token_ciphertext,
        refresh_token_ciphertext = p_refresh_token_ciphertext,
        access_token_expires_at = p_access_token_expires_at
    WHERE session_id = v_session.session_id RETURNING * INTO v_session;

  PERFORM console_audit.append_event_internal(
    NULL, p_correlation_id, p_subject_id::text, 'console.identity.session.mfa',
    'browser-session:' || v_session.session_id::text, 'succeeded', 'aal2',
    jsonb_build_object(
      'sessionId', v_session.session_id, 'aal', v_session.aal,
      'expiresAt', v_session.expires_at, 'accessTokenExpiresAt', v_session.access_token_expires_at,
      'permissionRevision', v_session.permission_revision, 'revokeEpoch', v_session.revoke_epoch
    )
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id, 'subjectId', v_session.subject_id, 'state', 'active',
    'createdAt', v_session.created_at, 'lastSeenAt', v_session.last_seen_at,
    'expiresAt', v_session.expires_at, 'accessTokenExpiresAt', v_session.access_token_expires_at,
    'aal', v_session.aal, 'permissionRevision', v_session.permission_revision,
    'revokeEpoch', v_session.revoke_epoch
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.activate_browser_session_mfa(
  uuid, uuid, bytea, text, text, text, timestamptz, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.activate_browser_session_mfa(
  uuid, uuid, bytea, text, text, text, timestamptz, timestamptz, text
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
    'expiresAt', v_session.expires_at, 'accessTokenExpiresAt', v_session.access_token_expires_at,
    'revokedAt', v_session.revoked_at, 'authorityFresh', true,
    'permissions', to_jsonb(v_permissions), 'permissionRevision', v_authority.permission_revision,
    'revokeEpoch', v_authority.revoke_epoch, 'aal', v_session.aal
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.get_browser_session_refresh_credentials(
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
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp()
      OR v_session.access_token_ciphertext IS NULL OR v_session.refresh_token_ciphertext IS NULL
      OR v_session.access_token_expires_at IS NULL THEN
    RAISE EXCEPTION 'refreshable active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF p_require_csrf AND (p_csrf_token_digest IS NULL OR v_session.csrf_token_digest <> p_csrf_token_digest) THEN
    RAISE EXCEPTION 'Console session CSRF validation failed'
      USING ERRCODE = '42501', DETAIL = 'CsrfRejected';
  END IF;
  IF v_session.access_token_expires_at > statement_timestamp() + interval '30 seconds' THEN
    RAISE EXCEPTION 'browser session access credential does not require refresh'
      USING ERRCODE = '55000', DETAIL = 'RefreshNotRequired';
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
    'authSessionRef', v_session.auth_session_ref, 'aal', v_session.aal,
    'accessTokenCiphertext', v_session.access_token_ciphertext,
    'refreshTokenCiphertext', v_session.refresh_token_ciphertext,
    'accessTokenExpiresAt', v_session.access_token_expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.get_browser_session_refresh_credentials(bytea, bytea, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.get_browser_session_refresh_credentials(bytea, bytea, boolean) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.rotate_browser_session_credentials(
  p_session_id uuid,
  p_subject_id uuid,
  p_expected_refresh_ciphertext_digest bytea,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_auth_session_ref text,
  p_aal text,
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
      OR octet_length(p_expected_refresh_ciphertext_digest) <> 32
      OR p_access_token_ciphertext IS NULL
      OR p_access_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_access_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_refresh_token_ciphertext IS NULL
      OR p_refresh_token_ciphertext !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
      OR length(p_refresh_token_ciphertext) NOT BETWEEN 32 AND 16384
      OR p_auth_session_ref IS NULL OR length(p_auth_session_ref) NOT BETWEEN 1 AND 256
      OR p_auth_session_ref ~ '[[:cntrl:]]' OR p_aal NOT IN ('aal1', 'aal2')
      OR p_access_token_expires_at <= v_now OR p_access_token_expires_at > v_now + interval '30 days'
      OR p_correlation_id IS NULL OR length(p_correlation_id) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'browser session refresh rotation request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_subject_id OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_now THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = p_subject_id FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF sha256(convert_to(v_session.refresh_token_ciphertext, 'UTF8'))
      <> p_expected_refresh_ciphertext_digest THEN
    RETURN jsonb_build_object('outcome', 'peer_rotated');
  END IF;

  UPDATE console_identity.browser_session
    SET access_token_ciphertext = p_access_token_ciphertext,
        refresh_token_ciphertext = p_refresh_token_ciphertext,
        auth_session_ref = p_auth_session_ref,
        aal = p_aal,
        access_token_expires_at = p_access_token_expires_at
    WHERE session_id = v_session.session_id;
  PERFORM console_audit.append_event_internal(
    NULL, p_correlation_id, p_subject_id::text, 'console.identity.session.refresh',
    'browser-session:' || v_session.session_id::text, 'succeeded', '',
    jsonb_build_object(
      'sessionId', v_session.session_id, 'aal', p_aal,
      'accessTokenExpiresAt', p_access_token_expires_at,
      'permissionRevision', v_session.permission_revision, 'revokeEpoch', v_session.revoke_epoch
    )
  );
  RETURN jsonb_build_object('outcome', 'rotated');
END;
$$;

REVOKE ALL ON FUNCTION console_identity.rotate_browser_session_credentials(
  uuid, uuid, bytea, text, text, text, text, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.rotate_browser_session_credentials(
  uuid, uuid, bytea, text, text, text, text, timestamptz, text
) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.reject_browser_session_refresh(
  p_session_id uuid,
  p_subject_id uuid,
  p_expected_refresh_ciphertext_digest bytea,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_session_id IS NULL OR p_subject_id IS NULL
      OR octet_length(p_expected_refresh_ciphertext_digest) <> 32
      OR p_correlation_id IS NULL OR length(p_correlation_id) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'browser session refresh rejection request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_subject_id OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_now THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  IF sha256(convert_to(v_session.refresh_token_ciphertext, 'UTF8'))
      <> p_expected_refresh_ciphertext_digest THEN
    RETURN jsonb_build_object('outcome', 'peer_rotated');
  END IF;
  UPDATE console_identity.browser_session
    SET revoked_at = v_now, revoke_reason = 'refresh-rejected'
    WHERE subject_id = p_subject_id AND auth_session_ref = v_session.auth_session_ref
      AND revoked_at IS NULL;
  PERFORM console_audit.append_event_internal(
    NULL, p_correlation_id, p_subject_id::text, 'console.identity.session.refresh',
    'browser-session:' || v_session.session_id::text, 'rejected', 'refresh-rejected',
    jsonb_build_object(
      'sessionId', v_session.session_id,
      'permissionRevision', v_session.permission_revision, 'revokeEpoch', v_session.revoke_epoch
    )
  );
  RETURN jsonb_build_object('outcome', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION console_identity.reject_browser_session_refresh(uuid, uuid, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.reject_browser_session_refresh(uuid, uuid, bytea, text) TO console_api;

COMMENT ON COLUMN console_identity.browser_session.access_token_expires_at
IS 'Server-observed Supabase access credential expiry used to trigger bounded refresh rotation';
COMMENT ON FUNCTION console_identity.get_browser_session_refresh_credentials(bytea, bytea, boolean)
IS 'Returns an expiring active session credential envelope only to C_API after current authority and optional CSRF checks';
COMMENT ON FUNCTION console_identity.rotate_browser_session_credentials(uuid, uuid, bytea, text, text, text, text, timestamptz, text)
IS 'CAS-rotates one unchanged active browser-session credential pair and appends no-secret audit evidence';
COMMENT ON FUNCTION console_identity.reject_browser_session_refresh(uuid, uuid, bytea, text)
IS 'Revokes the unchanged Supabase auth-session family only after explicit refresh rejection';
