DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION 'Supabase Storage schema must exist before Console profile avatar configuration'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'console-uploads',
  'console-uploads',
  false,
  163840,
  ARRAY['image/webp', 'image/png', 'image/jpeg']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION console_identity.prepare_owned_profile_avatar_access(
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_operation text,
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
  v_mutation boolean;
BEGIN
  v_mutation := p_operation IN ('select', 'upload');
  IF octet_length(p_token_digest) <> 32
      OR p_operation NOT IN ('read', 'content', 'select', 'upload')
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]'
      OR (v_mutation AND octet_length(p_csrf_token_digest) <> 32)
      OR (NOT v_mutation AND p_csrf_token_digest IS NOT NULL) THEN
    RAISE EXCEPTION 'owned profile avatar access request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE token_digest = p_token_digest
    FOR SHARE;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_session.absolute_expires_at <= statement_timestamp()
      OR (v_mutation AND v_session.csrf_token_digest <> p_csrf_token_digest)
      OR v_session.access_token_ciphertext IS NULL
      OR v_session.access_token_expires_at IS NULL
      OR v_session.access_token_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session proof is required for profile avatar access'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = v_session.subject_id
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  IF v_mutation THEN
    v_event := console_audit.append_event_internal(
      NULL,
      p_correlation_id,
      v_session.subject_id::text,
      'console.identity.profile.avatar.' || p_operation,
      'subject:' || v_session.subject_id::text || ':profile-avatar',
      'accepted',
      'self-service-profile-avatar',
      jsonb_build_object(
        'sessionId', v_session.session_id,
        'operation', p_operation,
        'permissionRevision', v_session.permission_revision,
        'revokeEpoch', v_session.revoke_epoch
      )
    );
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'accessTokenCiphertext', v_session.access_token_ciphertext,
    'auditEventId', CASE WHEN v_mutation THEN v_event.event_id ELSE NULL END
  ));
END;
$$;

REVOKE ALL ON FUNCTION console_identity.prepare_owned_profile_avatar_access(bytea, bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.prepare_owned_profile_avatar_access(bytea, bytea, text, text) TO console_api;

COMMENT ON FUNCTION console_identity.prepare_owned_profile_avatar_access(bytea, bytea, text, text)
  IS 'Returns C_API-only current-subject Auth context and records no-secret accepted intents for profile avatar mutations.';
