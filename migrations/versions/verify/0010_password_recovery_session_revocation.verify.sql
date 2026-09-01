\set ON_ERROR_STOP on

DO $$
DECLARE
  v_subject uuid := '56565656-5656-4565-8565-565656565656';
  v_other uuid := '78787878-7878-4787-8787-787878787878';
  v_session jsonb;
  v_other_session jsonb;
  v_result jsonb;
  v_before_events bigint;
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.revoke_browser_sessions_after_password_recovery(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'password recovery session revocation function is missing';
  END IF;
  IF has_function_privilege('public', 'console_identity.revoke_browser_sessions_after_password_recovery(uuid,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.revoke_browser_sessions_after_password_recovery(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'password recovery session revocation grant is not closed to console_api';
  END IF;

  INSERT INTO auth.users(id) VALUES (v_subject), (v_other) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
    VALUES
      (v_subject, gen_random_uuid(), 4, 7),
      (v_other, gen_random_uuid(), 2, 3)
    ON CONFLICT (subject_id) DO UPDATE
      SET permission_revision = EXCLUDED.permission_revision,
          revoke_epoch = EXCLUDED.revoke_epoch;

  v_session := console_identity.issue_browser_session(
    v_subject,
    sha256('password-recovery-session-handle'::bytea),
    sha256('password-recovery-session-csrf'::bytea),
    'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
    'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB',
    'auth-session-password-recovery', 'aal1', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false,
    'password-recovery-session-issue-0001'
  );
  v_other_session := console_identity.issue_browser_session(
    v_other,
    sha256('password-recovery-other-handle'::bytea),
    sha256('password-recovery-other-csrf'::bytea),
    'v1.CCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC',
    'v1.DDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD',
    'auth-session-password-recovery-other', 'aal1', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false,
    'password-recovery-other-issue-0001'
  );

  SELECT count(*) INTO v_before_events FROM console_audit.event;
  v_result := console_identity.revoke_browser_sessions_after_password_recovery(
    v_subject, 'password-recovery-complete-0001'
  );

  IF (v_result->>'subjectId')::uuid <> v_subject
      OR (v_result->>'revokedCount')::integer <> 1
      OR (v_result->>'revokeEpoch')::bigint <> 8 THEN
    RAISE EXCEPTION 'password recovery returned an invalid revocation receipt';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.browser_session
    WHERE session_id = (v_session->>'sessionId')::uuid
      AND revoked_at IS NOT NULL
      AND revoke_reason = 'password-recovery'
  ) THEN
    RAISE EXCEPTION 'recovered subject browser session was not revoked';
  END IF;
  IF EXISTS (
    SELECT 1 FROM console_identity.browser_session
    WHERE session_id = (v_other_session->>'sessionId')::uuid
      AND revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'password recovery revoked another subject session';
  END IF;
  IF (SELECT revoke_epoch FROM console_identity.subject_authority WHERE subject_id = v_subject) <> 8
      OR (SELECT revoke_epoch FROM console_identity.subject_authority WHERE subject_id = v_other) <> 3 THEN
    RAISE EXCEPTION 'password recovery did not advance only the recovered subject epoch';
  END IF;
  IF (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'password recovery did not append exactly one audit event';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE event_id = (v_result->>'auditEventId')::uuid
      AND actor_ref = v_subject::text
      AND action = 'console.identity.password.recovery.sessions_revoked'
      AND target_ref = 'subject:' || v_subject::text || ':browser-sessions'
      AND outcome = 'succeeded'
      AND reason = 'password-recovery'
      AND evidence = jsonb_build_object(
        'revokedCount', 1,
        'previousRevokeEpoch', 7,
        'revokeEpoch', 8,
        'revokedAt', (v_result->>'revokedAt')::timestamptz
      )
  ) THEN
    RAISE EXCEPTION 'password recovery audit event is missing or contains unexpected data';
  END IF;

  BEGIN
    PERFORM console_identity.revoke_browser_sessions_after_password_recovery(v_subject, 'bad');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_failed := true;
  END;
  IF NOT v_failed
      OR (SELECT revoke_epoch FROM console_identity.subject_authority WHERE subject_id = v_subject) <> 8 THEN
    RAISE EXCEPTION 'invalid recovery request mutated authority state';
  END IF;
END;
$$;
