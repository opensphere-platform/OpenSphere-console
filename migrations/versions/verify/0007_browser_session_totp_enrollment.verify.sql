DO $$
DECLARE
  v_subject uuid := '10000000-0000-4000-8000-000000000007';
  v_session jsonb;
  v_context jsonb;
  v_completed jsonb;
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.get_browser_session_totp_enrollment_credentials(bytea,bytea)') IS NULL
      OR to_regprocedure('console_identity.complete_browser_session_totp_enrollment(uuid,uuid,bytea,text,text,text,text,timestamptz,text)') IS NOT NULL
      OR to_regprocedure('console_identity.complete_browser_session_totp_enrollment(uuid,uuid,bytea,text,text,text,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'TOTP enrollment authority functions are missing or have an unexpected signature';
  END IF;
  IF has_function_privilege('public', 'console_identity.get_browser_session_totp_enrollment_credentials(bytea,bytea)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.complete_browser_session_totp_enrollment(uuid,uuid,bytea,text,text,text,timestamptz,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.get_browser_session_totp_enrollment_credentials(bytea,bytea)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.complete_browser_session_totp_enrollment(uuid,uuid,bytea,text,text,text,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'TOTP enrollment authority function privileges are not closed';
  END IF;

  INSERT INTO auth.users(id) VALUES (v_subject)
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
    VALUES (v_subject, gen_random_uuid(), 1, 0)
    ON CONFLICT (subject_id) DO UPDATE SET permission_revision = 1, revoke_epoch = 0;
  v_session := console_identity.issue_browser_session(
    v_subject, sha256('totp-session-handle'::bytea), sha256('totp-csrf-proof'::bytea),
    'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
    'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB',
    'auth-session-totp-1', 'aal1', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'verify-totp-enrollment-issue'
  );
  v_context := console_identity.get_browser_session_totp_enrollment_credentials(
    sha256('totp-session-handle'::bytea), sha256('totp-csrf-proof'::bytea)
  );
  IF v_context->>'sessionId' <> v_session->>'sessionId'
      OR v_context->>'subjectId' <> v_subject::text
      OR length(v_context->>'expectedAccessCiphertextDigest') <> 64 THEN
    RAISE EXCEPTION 'TOTP enrollment credential context lost its session binding';
  END IF;
  v_completed := console_identity.complete_browser_session_totp_enrollment(
    (v_context->>'sessionId')::uuid, v_subject,
    decode(v_context->>'expectedAccessCiphertextDigest', 'hex'),
    'v1.CCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC',
    'v1.DDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD',
    'auth-session-totp-2', statement_timestamp() + interval '1 hour',
    'verify-totp-enrollment-complete'
  );
  IF v_completed->>'sessionId' <> v_session->>'sessionId'
      OR v_completed->>'subjectId' <> v_subject::text
      OR v_completed->>'aal' <> 'aal2' THEN
    RAISE EXCEPTION 'TOTP enrollment completion did not promote the same session';
  END IF;
  BEGIN
    PERFORM console_identity.complete_browser_session_totp_enrollment(
      (v_context->>'sessionId')::uuid, v_subject,
      decode(v_context->>'expectedAccessCiphertextDigest', 'hex'),
      'v1.EEEEEEEEEEEEEEEE.EEEEEEEEEEEEEEEEEEEEEE.EEEEEEEEEEEEEEEEEEEEEE',
      'v1.FFFFFFFFFFFFFFFF.FFFFFFFFFFFFFFFFFFFFFF.FFFFFFFFFFFFFFFFFFFFFFFF',
      'auth-session-totp-3', statement_timestamp() + interval '1 hour',
      'verify-totp-enrollment-replay'
    );
  EXCEPTION WHEN SQLSTATE '28000' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'TOTP enrollment completion replay was not rejected';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE action = 'console.identity.factor.totp.enroll'
      AND actor_ref = v_subject::text AND outcome = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'TOTP enrollment completion audit event is missing';
  END IF;
END;
$$;
