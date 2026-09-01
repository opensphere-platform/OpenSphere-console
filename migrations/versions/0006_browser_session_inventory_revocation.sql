CREATE OR REPLACE FUNCTION console_identity.list_owned_browser_sessions(
  p_token_digest bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_current jsonb;
  v_now timestamptz := statement_timestamp();
  v_items jsonb;
BEGIN
  v_current := console_identity.resolve_browser_session(p_token_digest, NULL, false);
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', candidate.session_id,
      'current', candidate.session_id = (v_current->>'sessionId')::uuid,
      'status', CASE WHEN candidate.revoke_reason = 'pending-mfa' THEN 'pending_mfa' ELSE 'active' END,
      'assurance', candidate.aal,
      'persistence', candidate.persistence,
      'createdAt', candidate.created_at,
      'lastSeenAt', candidate.last_seen_at,
      'idleExpiresAt', candidate.expires_at,
      'absoluteExpiresAt', candidate.absolute_expires_at,
      'userAgentDigest', NULL
    ) ORDER BY candidate.last_seen_at DESC, candidate.session_id
  ), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT session.*
    FROM console_identity.browser_session AS session
    WHERE session.subject_id = (v_current->>'subjectId')::uuid
      AND session.expires_at > v_now
      AND session.absolute_expires_at > v_now
      AND session.revoked_at IS NULL
    ORDER BY
      (session.session_id = (v_current->>'sessionId')::uuid) DESC,
      session.last_seen_at DESC,
      session.session_id
    LIMIT 100
  ) AS candidate;
  RETURN jsonb_build_object('items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION console_identity.list_owned_browser_sessions(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.list_owned_browser_sessions(bytea) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.revoke_owned_browser_session(
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_target_session_id uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_current jsonb;
  v_target console_identity.browser_session;
  v_now timestamptz := statement_timestamp();
  v_is_current boolean;
  v_event console_audit.event;
BEGIN
  IF p_target_session_id IS NULL
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'owned browser session revocation request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  v_current := console_identity.resolve_browser_session(
    p_token_digest, p_csrf_token_digest, true
  );
  SELECT * INTO v_target
  FROM console_identity.browser_session
  WHERE session_id = p_target_session_id
    AND subject_id = (v_current->>'subjectId')::uuid
    AND expires_at > v_now
    AND absolute_expires_at > v_now
    AND revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owned browser session was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  v_is_current := v_target.session_id = (v_current->>'sessionId')::uuid;
  UPDATE console_identity.browser_session
  SET revoked_at = v_now,
      revoke_reason = 'user-revoked-session',
      last_seen_at = v_now
  WHERE session_id = v_target.session_id;
  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, v_target.subject_id::text,
    'console.identity.session.revoke',
    'browser-session:' || v_target.session_id::text,
    'succeeded', 'user-revoked-session',
    jsonb_build_object(
      'sessionId', v_target.session_id,
      'current', v_is_current,
      'permissionRevision', v_current->>'permissionRevision',
      'revokeEpoch', v_current->>'revokeEpoch',
      'revokedAt', v_now
    )
  );
  RETURN jsonb_build_object(
    'sessionId', v_target.session_id,
    'current', v_is_current,
    'revokedAt', v_now,
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.revoke_owned_browser_session(bytea, bytea, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.revoke_owned_browser_session(bytea, bytea, uuid, text) TO console_api;

CREATE OR REPLACE FUNCTION console_identity.revoke_all_owned_browser_sessions(
  p_token_digest bytea,
  p_csrf_token_digest bytea,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_current jsonb;
  v_now timestamptz := statement_timestamp();
  v_revoked_count integer;
  v_event console_audit.event;
BEGIN
  IF length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'all browser session revocation request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  v_current := console_identity.resolve_browser_session(
    p_token_digest, p_csrf_token_digest, true
  );
  UPDATE console_identity.browser_session
  SET revoked_at = v_now,
      revoke_reason = 'user-revoked-all-sessions',
      last_seen_at = v_now
  WHERE subject_id = (v_current->>'subjectId')::uuid
    AND expires_at > v_now
    AND absolute_expires_at > v_now
    AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked_count = ROW_COUNT;
  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, v_current->>'subjectId',
    'console.identity.session.revoke_all',
    'subject:' || (v_current->>'subjectId') || ':browser-sessions',
    'succeeded', 'user-revoked-all-sessions',
    jsonb_build_object(
      'currentSessionId', v_current->>'sessionId',
      'revokedCount', v_revoked_count,
      'permissionRevision', v_current->>'permissionRevision',
      'revokeEpoch', v_current->>'revokeEpoch',
      'revokedAt', v_now
    )
  );
  RETURN jsonb_build_object(
    'current', true,
    'revokedCount', v_revoked_count,
    'revokedAt', v_now,
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.revoke_all_owned_browser_sessions(bytea, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.revoke_all_owned_browser_sessions(bytea, bytea, text) TO console_api;

COMMENT ON FUNCTION console_identity.list_owned_browser_sessions(bytea)
  IS 'C_API-only no-secret inventory of live browser sessions owned by the current opaque-session subject.';
COMMENT ON FUNCTION console_identity.revoke_owned_browser_session(bytea, bytea, uuid, text)
  IS 'C_API-only CSRF-bound revocation of one live browser session owned by the current subject.';
COMMENT ON FUNCTION console_identity.revoke_all_owned_browser_sessions(bytea, bytea, text)
  IS 'C_API-only CSRF-bound revocation of every live browser session owned by the current subject.';
