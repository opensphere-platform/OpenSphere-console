DO $$
DECLARE
  v_subject uuid := '10000000-0000-4000-8000-000000000008';
  v_session jsonb;
  v_context jsonb;
  v_completed jsonb;
BEGIN
  IF to_regprocedure('console_identity.get_browser_session_step_up_credentials(bytea,bytea)') IS NULL
      OR to_regprocedure('console_identity.complete_browser_session_step_up(uuid,uuid,bytea,text,text,text,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'step-up authority functions are missing';
  END IF;
  IF has_function_privilege('public', 'console_identity.get_browser_session_step_up_credentials(bytea,bytea)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.complete_browser_session_step_up(uuid,uuid,bytea,text,text,text,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'step-up authority functions are public';
  END IF;
  INSERT INTO auth.users(id) VALUES (v_subject) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
    VALUES (v_subject, gen_random_uuid(), 1, 0) ON CONFLICT DO NOTHING;
  v_session := console_identity.issue_browser_session(
    v_subject, sha256('step-up-session'::bytea), sha256('step-up-csrf'::bytea),
    'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
    'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB',
    'auth-step-up-1', 'aal1', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'verify-step-up-issue-0001'
  );
  v_context := console_identity.get_browser_session_step_up_credentials(
    sha256('step-up-session'::bytea), sha256('step-up-csrf'::bytea)
  );
  v_completed := console_identity.complete_browser_session_step_up(
    (v_context->>'sessionId')::uuid, v_subject,
    decode(v_context->>'expectedAccessCiphertextDigest', 'hex'),
    'v1.CCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC',
    'v1.DDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD',
    'auth-step-up-2', statement_timestamp() + interval '1 hour', 'verify-step-up-complete-0001'
  );
  IF v_completed->>'aal' <> 'aal2' OR v_completed->>'reauthenticatedAt' IS NULL THEN
    RAISE EXCEPTION 'step-up did not record recent aal2';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_audit.event WHERE action = 'console.identity.session.step_up'
      AND correlation_id = 'verify-step-up-complete-0001'
  ) THEN RAISE EXCEPTION 'step-up audit is missing'; END IF;
END;
$$;
