\set ON_ERROR_STOP on

DO $$
DECLARE
  v_subject uuid := '11111111-1111-4111-8111-111111111111';
  v_session jsonb;
  v_read jsonb;
  v_update jsonb;
  v_before_events bigint;
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.get_browser_session_preference_credentials(bytea)') IS NULL
      OR to_regprocedure('console_identity.prepare_browser_session_preference_update(bytea,bytea,text,text)') IS NULL THEN
    RAISE EXCEPTION 'browser session preference functions are missing';
  END IF;
  IF has_function_privilege('public', 'console_identity.get_browser_session_preference_credentials(bytea)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.prepare_browser_session_preference_update(bytea,bytea,text,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.get_browser_session_preference_credentials(bytea)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.prepare_browser_session_preference_update(bytea,bytea,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'browser session preference grants are not closed to console_api';
  END IF;

  v_session := console_identity.issue_browser_session(
    v_subject,
    sha256(convert_to('session-preference-handle', 'UTF8')),
    sha256(convert_to('session-preference-csrf', 'UTF8')),
    'v1.U0VTU0lPTlBSRUZFUkVOQ0U.U0VTU0lPTlBSRUZFUkVOQ0U.U0VTU0lPTlBSRUZFUkVOQ0U',
    'v1.U0VTU0lPTlBSRUZFUkVOQ0VS.U0VTU0lPTlBSRUZFUkVOQ0VS.U0VTU0lPTlBSRUZFUkVOQ0VS',
    'auth-session-preference', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false,
    'session-preference-issue-0001'
  );

  v_read := console_identity.get_browser_session_preference_credentials(
    sha256(convert_to('session-preference-handle', 'UTF8'))
  );
  IF (v_read->>'sessionId')::uuid <> (v_session->>'sessionId')::uuid
      OR (v_read->>'subjectId')::uuid <> v_subject
      OR v_read->>'accessTokenCiphertext' NOT LIKE 'v1.%' THEN
    RAISE EXCEPTION 'session preference read context is invalid';
  END IF;

  SELECT count(*) INTO v_before_events FROM console_audit.event;
  v_update := console_identity.prepare_browser_session_preference_update(
    sha256(convert_to('session-preference-handle', 'UTF8')),
    sha256(convert_to('session-preference-csrf', 'UTF8')),
    '7d', 'session-preference-update-0001'
  );
  IF (v_update->>'sessionId')::uuid <> (v_session->>'sessionId')::uuid
      OR (v_update->>'subjectId')::uuid <> v_subject
      OR v_update->>'accessTokenCiphertext' NOT LIKE 'v1.%'
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'session preference update context or durable intent is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE event_id = (v_update->>'auditEventId')::uuid
      AND actor_ref = v_subject::text
      AND action = 'console.identity.session.preference.update'
      AND target_ref = 'subject:' || v_subject::text || ':session-preference'
      AND outcome = 'accepted'
      AND reason = 'self-service-session-preference'
      AND evidence = jsonb_build_object(
        'sessionId', (v_session->>'sessionId')::uuid,
        'duration', '7d', 'appliesTo', 'next-login',
        'permissionRevision', 7, 'revokeEpoch', 2
      )
  ) THEN
    RAISE EXCEPTION 'session preference intent evidence is missing or contains unexpected data';
  END IF;

  BEGIN
    PERFORM console_identity.prepare_browser_session_preference_update(
      sha256(convert_to('session-preference-handle', 'UTF8')),
      sha256(convert_to('wrong-session-preference-csrf', 'UTF8')),
      '30d', 'session-preference-update-0002'
    );
  EXCEPTION WHEN invalid_authorization_specification THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'invalid CSRF proof appended session preference intent';
  END IF;

  v_failed := false;
  BEGIN
    PERFORM console_identity.prepare_browser_session_preference_update(
      sha256(convert_to('session-preference-handle', 'UTF8')),
      sha256(convert_to('session-preference-csrf', 'UTF8')),
      'forever', 'session-preference-update-0003'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'invalid persistence appended session preference intent';
  END IF;
END;
$$;
