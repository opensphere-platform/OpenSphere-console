\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regprocedure('console_identity.get_pending_browser_session_mfa(bytea,bytea)') IS NULL
      OR to_regprocedure('console_identity.activate_browser_session_mfa(uuid,uuid,bytea,text,text,text,timestamptz,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'browser session MFA functions are incomplete';
  END IF;
  IF has_function_privilege('public', 'console_identity.get_pending_browser_session_mfa(bytea,bytea)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.activate_browser_session_mfa(uuid,uuid,bytea,text,text,text,timestamptz,timestamptz,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.get_pending_browser_session_mfa(bytea,bytea)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.activate_browser_session_mfa(uuid,uuid,bytea,text,text,text,timestamptz,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'browser session MFA function grants are not closed to console_api';
  END IF;
END;
$$;

SET ROLE console_api;
SELECT set_config(
  'verification.pending_mfa_session',
  console_identity.issue_browser_session(
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to('migration-verification-pending-mfa-handle', 'UTF8')),
    sha256(convert_to('migration-verification-pending-mfa-csrf', 'UTF8')),
    'v1.cGVuZGluZ2FjY2Vzc2l2MTIz.cGVuZGluZ2FjY2Vzc3RhZw.cGVuZGluZ2FjY2Vzcw',
    'v1.cGVuZGluZ3JlZnJlc2hpdjEyMw.cGVuZGluZ3JlZnJlc2h0YWc.cGVuZGluZ3JlZnJlc2g',
    'migration-verification-pending-auth-session',
    'aal1', statement_timestamp() + interval '3 minutes', statement_timestamp() + interval '4 minutes', true,
    'migration-session-pending-mfa-0001'
  )::text,
  false
);

DO $$
DECLARE
  v_pending jsonb;
  v_active jsonb;
BEGIN
  v_pending := console_identity.get_pending_browser_session_mfa(
    sha256(convert_to('migration-verification-pending-mfa-handle', 'UTF8')),
    sha256(convert_to('migration-verification-pending-mfa-csrf', 'UTF8'))
  );
  IF v_pending->>'sessionId' <> current_setting('verification.pending_mfa_session')::jsonb->>'sessionId'
      OR v_pending->>'aal' <> 'aal1'
      OR v_pending->>'accessTokenCiphertext' IS NULL THEN
    RAISE EXCEPTION 'pending MFA projection lost its proof-bound credential envelope';
  END IF;

  v_active := console_identity.activate_browser_session_mfa(
    (v_pending->>'sessionId')::uuid,
    (v_pending->>'subjectId')::uuid,
    sha256(convert_to(v_pending->>'accessTokenCiphertext', 'UTF8')),
    'v1.YWFsMmFjY2Vzc2l2MTIzNDU2.YWFsMmFjY2Vzc3RhZzEyMzQ1Ng.YWFsMmFjY2Vzc2NpcGhlcnRleHQ',
    'v1.YWFsMnJlZnJlc2hpdjEyMzQ1Ng.YWFsMnJlZnJlc2h0YWcxMjM0NTY.YWFsMnJlZnJlc2hjaXBoZXJ0ZXh0',
    'migration-verification-aal2-auth-session',
    statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours',
    'migration-session-mfa-activation-0001'
  );
  IF v_active->>'state' <> 'active' OR v_active->>'aal' <> 'aal2' THEN
    RAISE EXCEPTION 'pending browser session was not promoted to aal2';
  END IF;

  BEGIN
    PERFORM console_identity.activate_browser_session_mfa(
      (v_pending->>'sessionId')::uuid, (v_pending->>'subjectId')::uuid,
      sha256(convert_to(v_pending->>'accessTokenCiphertext', 'UTF8')),
      'v1.YWFsMmFjY2Vzc2l2MTIzNDU2.YWFsMmFjY2Vzc3RhZzEyMzQ1Ng.YWFsMmFjY2Vzc2NpcGhlcnRleHQ',
      'v1.YWFsMnJlZnJlc2hpdjEyMzQ1Ng.YWFsMnJlZnJlc2h0YWcxMjM0NTY.YWFsMnJlZnJlc2hjaXBoZXJ0ZXh0',
      'migration-verification-aal2-auth-session', statement_timestamp() + interval '1 hour', statement_timestamp() + interval '24 hours',
      'migration-session-mfa-activation-replay-0001'
    );
    RAISE EXCEPTION 'MFA activation replay was accepted';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
DECLARE
  v_session_id uuid := (current_setting('verification.pending_mfa_session')::jsonb->>'sessionId')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.browser_session
    WHERE session_id = v_session_id AND aal = 'aal2' AND revoked_at IS NULL AND revoke_reason IS NULL
      AND auth_session_ref = 'migration-verification-aal2-auth-session'
  ) THEN
    RAISE EXCEPTION 'activated MFA session authority state is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE correlation_id = 'migration-session-mfa-activation-0001'
      AND action = 'console.identity.session.mfa' AND outcome = 'succeeded'
  ) OR EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE correlation_id = 'migration-session-mfa-activation-0001'
      AND evidence::text ~ '(YWFsMmFjY2Vzcw|YWFsMnJlZnJlc2g|migration-verification-aal2-auth-session)'
  ) THEN
    RAISE EXCEPTION 'MFA audit evidence is missing or contains credential material';
  END IF;
END;
$$;
