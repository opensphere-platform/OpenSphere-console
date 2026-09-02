CREATE OR REPLACE FUNCTION console_identity.prepare_owned_password_recovery_link(
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_idempotency_key text,
  p_correlation_id text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_current jsonb;
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_idempotency_digest text;
  v_event console_audit.event;
BEGIN
  IF octet_length(p_token_digest) <> 32 OR octet_length(p_csrf_token_digest) <> 32
      OR length(COALESCE(p_idempotency_key, '')) NOT BETWEEN 8 AND 256
      OR p_idempotency_key ~ '[\r\n]'
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]'
      OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 500
      OR p_reason ~ '[\r\n]' THEN
    RAISE EXCEPTION 'owned password recovery link request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  v_current := console_identity.resolve_browser_session(
    p_token_digest, p_csrf_token_digest, true
  );

  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = (v_current->>'sessionId')::uuid
      AND token_digest = p_token_digest
    FOR SHARE;
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
    WHERE subject_id = v_session.subject_id
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  v_idempotency_digest := 'sha256:' || encode(
    sha256(convert_to(p_idempotency_key, 'UTF8')), 'hex'
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_session.subject_id::text || ':password-recovery-link:' || v_idempotency_digest, 0
  ));

  IF EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE actor_ref = v_session.subject_id::text
      AND action = 'console.identity.password.recovery_link.request'
      AND evidence->>'idempotencyDigest' = v_idempotency_digest
  ) THEN
    RETURN jsonb_build_object(
      'state', 'duplicate',
      'subjectId', v_session.subject_id
    );
  END IF;

  v_event := console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    v_session.subject_id::text,
    'console.identity.password.recovery_link.request',
    'subject:' || v_session.subject_id::text || ':password-recovery-link',
    'accepted',
    btrim(p_reason),
    jsonb_build_object(
      'sessionId', v_session.session_id,
      'idempotencyDigest', v_idempotency_digest,
      'permissionRevision', v_session.permission_revision,
      'revokeEpoch', v_session.revoke_epoch
    )
  );

  RETURN jsonb_build_object(
    'state', 'prepared',
    'sessionId', v_session.session_id,
    'subjectId', v_session.subject_id,
    'accessTokenCiphertext', v_session.access_token_ciphertext,
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.prepare_owned_password_recovery_link(bytea, bytea, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.prepare_owned_password_recovery_link(bytea, bytea, text, text, text) TO console_api;

COMMENT ON FUNCTION console_identity.prepare_owned_password_recovery_link(bytea, bytea, text, text, text)
  IS 'Validates the current subject and records a deduplicated no-secret intent before C_API requests a Supabase recovery link.';
