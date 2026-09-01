CREATE OR REPLACE FUNCTION console_identity.list_owned_browser_session_events(
  p_token_digest bytea,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_current jsonb;
  v_items jsonb;
BEGIN
  IF octet_length(p_token_digest) <> 32 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'browser session event request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  v_current := console_identity.resolve_browser_session(p_token_digest, NULL, false);

  SELECT COALESCE(jsonb_agg(projected.item ORDER BY projected.sequence_id DESC), '[]'::jsonb)
    INTO v_items
  FROM (
    SELECT event_record.sequence_id,
      jsonb_build_object(
        'id', event_record.sequence_id,
        'session_id', CASE
          WHEN event_record.target_ref ~* '^browser-session:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            THEN substring(event_record.target_ref FROM 17)
          WHEN COALESCE(event_record.evidence->>'currentSessionId', '')
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            THEN event_record.evidence->>'currentSessionId'
          ELSE NULL
        END,
        'event', CASE
          WHEN event_record.action = 'console.identity.session.login' THEN 'login'
          WHEN event_record.action = 'console.identity.session.refresh'
              AND event_record.outcome = 'rejected' THEN 'refresh_rejected'
          WHEN event_record.action = 'console.identity.session.refresh' THEN 'refresh'
          WHEN event_record.action IN (
            'console.identity.session.mfa',
            'console.identity.session.step_up',
            'console.identity.factor.totp.enroll'
          ) THEN 'step_up'
          WHEN event_record.action = 'console.identity.session.revoke' THEN 'revoke'
          ELSE 'revoke_all'
        END,
        'result', CASE
          WHEN event_record.outcome = 'succeeded' THEN 'ok'
          WHEN event_record.outcome = 'accepted' THEN 'pending'
          WHEN event_record.outcome = 'rejected' THEN 'rejected'
          ELSE 'error'
        END,
        'occurred_at', event_record.occurred_at
      ) AS item
    FROM console_audit.event AS event_record
    WHERE event_record.actor_ref = v_current->>'subjectId'
      AND event_record.action IN (
        'console.identity.session.login',
        'console.identity.session.refresh',
        'console.identity.session.mfa',
        'console.identity.session.step_up',
        'console.identity.factor.totp.enroll',
        'console.identity.session.revoke',
        'console.identity.session.revoke_all',
        'console.identity.password.recovery.sessions_revoked'
      )
    ORDER BY event_record.sequence_id DESC
    LIMIT p_limit
  ) AS projected;

  RETURN jsonb_build_object('items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION console_identity.list_owned_browser_session_events(bytea, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.list_owned_browser_session_events(bytea, integer) TO console_api;

COMMENT ON FUNCTION console_identity.list_owned_browser_session_events(bytea, integer)
  IS 'Returns a bounded no-secret session-security projection for the current browser-session subject.';
