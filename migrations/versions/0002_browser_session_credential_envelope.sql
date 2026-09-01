-- Add server-side Supabase credential custody to the fresh Console session ledger.
-- Browser-visible values remain an opaque session handle and a CSRF token only.

ALTER TABLE console_identity.browser_session
  ADD COLUMN auth_session_ref text,
  ADD COLUMN access_token_ciphertext text,
  ADD COLUMN refresh_token_ciphertext text;

ALTER TABLE console_identity.browser_session
  ADD CONSTRAINT browser_session_auth_session_ref_shape
    CHECK (auth_session_ref IS NULL OR (
      length(auth_session_ref) BETWEEN 1 AND 256
      AND auth_session_ref !~ '[[:cntrl:]]'
    )),
  ADD CONSTRAINT browser_session_access_envelope_shape
    CHECK (access_token_ciphertext IS NULL OR (
      length(access_token_ciphertext) BETWEEN 32 AND 16384
      AND access_token_ciphertext ~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
    )),
  ADD CONSTRAINT browser_session_refresh_envelope_shape
    CHECK (refresh_token_ciphertext IS NULL OR (
      length(refresh_token_ciphertext) BETWEEN 32 AND 16384
      AND refresh_token_ciphertext ~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
    ));

CREATE OR REPLACE FUNCTION console_identity.issue_browser_session(
  p_subject_id uuid,
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_auth_session_ref text,
  p_aal text,
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
    auth_session_ref, access_token_ciphertext, refresh_token_ciphertext
  ) VALUES (
    p_subject_id, p_token_digest, p_csrf_token_digest, p_aal,
    v_authority.permission_revision, v_authority.revoke_epoch, p_expires_at,
    CASE WHEN p_pending_mfa THEN v_now ELSE NULL END,
    CASE WHEN p_pending_mfa THEN 'pending-mfa' ELSE NULL END,
    p_auth_session_ref, p_access_token_ciphertext, p_refresh_token_ciphertext
  ) RETURNING * INTO v_session;

  PERFORM console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    p_subject_id::text,
    'console.identity.session.login',
    'browser-session:' || v_session.session_id::text,
    CASE WHEN p_pending_mfa THEN 'accepted' ELSE 'succeeded' END,
    CASE WHEN p_pending_mfa THEN 'pending-mfa' ELSE '' END,
    jsonb_build_object(
      'sessionId', v_session.session_id,
      'state', CASE WHEN p_pending_mfa THEN 'pending_mfa' ELSE 'active' END,
      'aal', v_session.aal,
      'expiresAt', v_session.expires_at,
      'permissionRevision', v_session.permission_revision,
      'revokeEpoch', v_session.revoke_epoch
    )
  );

  RETURN jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'state', CASE WHEN p_pending_mfa THEN 'pending_mfa' ELSE 'active' END,
    'createdAt', v_session.created_at,
    'lastSeenAt', v_session.last_seen_at,
    'expiresAt', v_session.expires_at,
    'aal', v_session.aal,
    'permissionRevision', v_session.permission_revision,
    'revokeEpoch', v_session.revoke_epoch
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, boolean, text
) TO console_api;

COMMENT ON FUNCTION console_identity.issue_browser_session(
  uuid, bytea, bytea, text, text, text, text, timestamptz, boolean, text
) IS 'Issues one opaque browser session from a Supabase-authenticated subject while retaining encrypted credentials only inside the server authority boundary';
