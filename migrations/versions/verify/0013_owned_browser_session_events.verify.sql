\set ON_ERROR_STOP on

DO $$
DECLARE
  v_subject uuid := '11111111-1111-4111-8111-111111111111';
  v_other_subject uuid := '22222222-2222-4222-8222-222222222222';
  v_session jsonb;
  v_session_id uuid;
  v_events jsonb;
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.list_owned_browser_session_events(bytea,integer)') IS NULL THEN
    RAISE EXCEPTION 'owned browser session event projection is missing';
  END IF;
  IF has_function_privilege('public', 'console_identity.list_owned_browser_session_events(bytea,integer)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.list_owned_browser_session_events(bytea,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'owned browser session event grants are not closed to console_api';
  END IF;

  v_session := console_identity.issue_browser_session(
    v_subject,
    sha256(convert_to('session-event-handle', 'UTF8')),
    sha256(convert_to('session-event-csrf', 'UTF8')),
    'v1.U0VTU0lPTkVWRU5UQUFDQ0VTUw.U0VTU0lPTkVWRU5UQUFDQ0VTUw.U0VTU0lPTkVWRU5UQUFDQ0VTUw',
    'v1.U0VTU0lPTkVWRU5UUkVGUkVTSA.U0VTU0lPTkVWRU5UUkVGUkVTSA.U0VTU0lPTkVWRU5UUkVGUkVTSA',
    'auth-session-events', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false,
    'session-event-issue-0001'
  );
  v_session_id := (v_session->>'sessionId')::uuid;

  PERFORM console_audit.append_event_internal(
    NULL, 'session-event-refresh-0001', v_subject::text,
    'console.identity.session.refresh', 'browser-session:' || v_session_id::text,
    'rejected', 'secret-canary-must-not-project',
    jsonb_build_object('sessionId', v_session_id, 'token', 'secret-canary-must-not-project')
  );
  PERFORM console_audit.append_event_internal(
    NULL, 'session-event-preference-0001', v_subject::text,
    'console.identity.session.preference.update', 'subject:' || v_subject::text || ':session-preference',
    'accepted', '', jsonb_build_object('duration', '7d')
  );
  PERFORM console_audit.append_event_internal(
    NULL, 'session-event-other-subject-0001', v_other_subject::text,
    'console.identity.session.refresh', 'browser-session:22222222-2222-4222-8222-222222222222',
    'succeeded', '', '{}'::jsonb
  );
  PERFORM console_audit.append_event_internal(
    NULL, 'session-event-revoke-all-0001', v_subject::text,
    'console.identity.session.revoke_all', 'subject:' || v_subject::text || ':browser-sessions',
    'succeeded', '', jsonb_build_object('currentSessionId', v_session_id, 'revokedCount', 2)
  );

  v_events := console_identity.list_owned_browser_session_events(
    sha256(convert_to('session-event-handle', 'UTF8')), 2
  );
  IF jsonb_array_length(v_events->'items') <> 2
      OR v_events->'items'->0->>'event' <> 'revoke_all'
      OR v_events->'items'->0->>'result' <> 'ok'
      OR (v_events->'items'->0->>'session_id')::uuid <> v_session_id
      OR v_events->'items'->1->>'event' <> 'refresh_rejected'
      OR v_events->'items'->1->>'result' <> 'rejected'
      OR (v_events->'items'->1->>'session_id')::uuid <> v_session_id THEN
    RAISE EXCEPTION 'owned browser session event projection is incomplete or unordered';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_events->'items'->0)) <> 5
      OR (SELECT count(*) FROM jsonb_object_keys(v_events->'items'->1)) <> 5
      OR v_events::text LIKE '%secret-canary%'
      OR v_events::text LIKE '%correlation%'
      OR v_events::text LIKE '%evidence%'
      OR v_events::text LIKE '%reason%' THEN
    RAISE EXCEPTION 'owned browser session event projection exposed non-contract data';
  END IF;

  BEGIN
    PERFORM console_identity.list_owned_browser_session_events(
      sha256(convert_to('session-event-handle', 'UTF8')), 0
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'invalid browser session event limit was accepted';
  END IF;
END;
$$;
