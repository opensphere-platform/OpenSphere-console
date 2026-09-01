CREATE OR REPLACE FUNCTION console_identity.revoke_browser_sessions_after_password_recovery(
  p_subject_id uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_authority console_identity.subject_authority;
  v_previous_revoke_epoch bigint;
  v_revoked_count integer;
  v_event console_audit.event;
BEGIN
  IF p_subject_id IS NULL
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'password recovery session revocation request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_subject_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Console subject authority is unavailable'
      USING ERRCODE = '28000', DETAIL = 'SubjectAuthorityMissing';
  END IF;
  IF v_authority.revoke_epoch = 9223372036854775807 THEN
    RAISE EXCEPTION 'subject revoke epoch is exhausted'
      USING ERRCODE = '54000', DETAIL = 'AuthorityRevisionExhausted';
  END IF;

  v_previous_revoke_epoch := v_authority.revoke_epoch;
  UPDATE console_identity.subject_authority
    SET revoke_epoch = revoke_epoch + 1,
        updated_at = v_now
    WHERE subject_id = p_subject_id
    RETURNING * INTO v_authority;

  UPDATE console_identity.browser_session
    SET revoked_at = v_now,
        revoke_reason = 'password-recovery',
        last_seen_at = v_now
    WHERE subject_id = p_subject_id
      AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked_count = ROW_COUNT;

  v_event := console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    p_subject_id::text,
    'console.identity.password.recovery.sessions_revoked',
    'subject:' || p_subject_id::text || ':browser-sessions',
    'succeeded',
    'password-recovery',
    jsonb_build_object(
      'revokedCount', v_revoked_count,
      'previousRevokeEpoch', v_previous_revoke_epoch,
      'revokeEpoch', v_authority.revoke_epoch,
      'revokedAt', v_now
    )
  );

  RETURN jsonb_build_object(
    'subjectId', p_subject_id,
    'revokedCount', v_revoked_count,
    'revokeEpoch', v_authority.revoke_epoch,
    'revokedAt', v_now,
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.revoke_browser_sessions_after_password_recovery(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.revoke_browser_sessions_after_password_recovery(uuid, text) TO console_api;

COMMENT ON FUNCTION console_identity.revoke_browser_sessions_after_password_recovery(uuid, text)
  IS 'C_API-only revocation of every Console browser session after Supabase verifies and applies a password recovery change.';
