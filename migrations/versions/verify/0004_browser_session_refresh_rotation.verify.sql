\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'console_identity' AND table_name = 'browser_session'
      AND column_name = 'access_token_expires_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'browser session access credential expiry column is missing';
  END IF;
  IF to_regprocedure('console_identity.get_browser_session_refresh_credentials(bytea,bytea,boolean)') IS NULL
      OR to_regprocedure('console_identity.rotate_browser_session_credentials(uuid,uuid,bytea,text,text,text,text,timestamptz,text)') IS NULL
      OR to_regprocedure('console_identity.reject_browser_session_refresh(uuid,uuid,bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'browser session refresh authority functions are incomplete';
  END IF;
  IF has_function_privilege('public', 'console_identity.get_browser_session_refresh_credentials(bytea,bytea,boolean)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.rotate_browser_session_credentials(uuid,uuid,bytea,text,text,text,text,timestamptz,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.reject_browser_session_refresh(uuid,uuid,bytea,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.get_browser_session_refresh_credentials(bytea,bytea,boolean)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.rotate_browser_session_credentials(uuid,uuid,bytea,text,text,text,text,timestamptz,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.reject_browser_session_refresh(uuid,uuid,bytea,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'browser session refresh grants are not closed to console_api';
  END IF;
  IF has_function_privilege('console_api', 'console_identity.issue_browser_session(uuid,bytea,bytea,text,text,text,text,timestamptz,timestamptz,boolean,text)', 'EXECUTE')
      OR has_function_privilege('console_api', 'console_identity.activate_browser_session_mfa(uuid,uuid,bytea,text,text,text,timestamptz,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C_API retained a pre-expiry credential mutation overload';
  END IF;
END;
$$;

SET ROLE console_api;
SELECT set_config(
  'verification.refresh_session',
  console_identity.issue_browser_session(
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to('migration-verification-refresh-handle', 'UTF8')),
    sha256(convert_to('migration-verification-refresh-csrf', 'UTF8')),
    'v1.b2xkYWNjZXNzaXYxMjM0NTY.b2xkYWNjZXNzdGFnMTIzNDU2.b2xkYWNjZXNzY2lwaGVydGV4dA',
    'v1.b2xkcmVmcmVzaGl2MTIzNDU2.b2xkcmVmcmVzaHRhZzEyMzQ1Ng.b2xkcmVmcmVzaGNpcGhlcnRleHQ',
    'migration-verification-refresh-auth-session', 'aal1',
    statement_timestamp() + interval '10 seconds',
    statement_timestamp() + interval '24 hours', '24h', false,
    'migration-session-refresh-issue-0001'
  )::text,
  false
);

DO $$
DECLARE
  v_session jsonb := current_setting('verification.refresh_session')::jsonb;
  v_credentials jsonb;
  v_rotated jsonb;
  v_peer jsonb;
  v_rejected jsonb;
  v_old_refresh text;
  v_new_refresh text := 'v1.bmV3cmVmcmVzaGl2MTIzNDU2.bmV3cmVmcmVzaHRhZzEyMzQ1Ng.bmV3cmVmcmVzaGNpcGhlcnRleHQ';
BEGIN
  v_credentials := console_identity.get_browser_session_refresh_credentials(
    sha256(convert_to('migration-verification-refresh-handle', 'UTF8')),
    sha256(convert_to('migration-verification-refresh-csrf', 'UTF8')),
    true
  );
  v_old_refresh := v_credentials->>'refreshTokenCiphertext';
  IF v_credentials->>'sessionId' <> v_session->>'sessionId'
      OR v_credentials->>'subjectId' <> '11111111-1111-4111-8111-111111111111'
      OR v_old_refresh IS NULL THEN
    RAISE EXCEPTION 'refresh credential projection lost its session binding';
  END IF;

  v_rotated := console_identity.rotate_browser_session_credentials(
    (v_session->>'sessionId')::uuid,
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to(v_old_refresh, 'UTF8')),
    'v1.bmV3YWNjZXNzaXYxMjM0NTY.bmV3YWNjZXNzdGFnMTIzNDU2.bmV3YWNjZXNzY2lwaGVydGV4dA',
    v_new_refresh,
    'migration-verification-refresh-auth-session-rotated', 'aal2',
    statement_timestamp() + interval '1 hour',
    'migration-session-refresh-rotate-0001'
  );
  IF v_rotated->>'outcome' <> 'rotated' THEN
    RAISE EXCEPTION 'current refresh credential was not rotated';
  END IF;

  v_peer := console_identity.rotate_browser_session_credentials(
    (v_session->>'sessionId')::uuid,
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to(v_old_refresh, 'UTF8')),
    'v1.cGVlcmFjY2Vzc2l2MTIzNDU2.cGVlcmFjY2Vzc3RhZzEyMzQ1Ng.cGVlcmFjY2Vzc2NpcGhlcnRleHQ',
    'v1.cGVlcnJlZnJlc2hpdjEyMzQ1Ng.cGVlcnJlZnJlc2h0YWcxMjM0NTY.cGVlcnJlZnJlc2hjaXBoZXJ0ZXh0',
    'migration-verification-refresh-peer', 'aal1',
    statement_timestamp() + interval '1 hour',
    'migration-session-refresh-peer-0001'
  );
  IF v_peer->>'outcome' <> 'peer_rotated' THEN
    RAISE EXCEPTION 'stale refresh rotation did not adopt peer result';
  END IF;

  v_peer := console_identity.reject_browser_session_refresh(
    (v_session->>'sessionId')::uuid,
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to(v_old_refresh, 'UTF8')),
    'migration-session-refresh-stale-reject-0001'
  );
  IF v_peer->>'outcome' <> 'peer_rotated' THEN
    RAISE EXCEPTION 'stale refresh rejection revoked a peer rotation';
  END IF;

  v_rejected := console_identity.reject_browser_session_refresh(
    (v_session->>'sessionId')::uuid,
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to(v_new_refresh, 'UTF8')),
    'migration-session-refresh-rejected-0001'
  );
  IF v_rejected->>'outcome' <> 'rejected' THEN
    RAISE EXCEPTION 'current explicit refresh rejection was not persisted';
  END IF;
END;
$$;
RESET ROLE;

DO $$
DECLARE
  v_session_id uuid := (current_setting('verification.refresh_session')::jsonb->>'sessionId')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.browser_session
    WHERE session_id = v_session_id AND aal = 'aal2'
      AND auth_session_ref = 'migration-verification-refresh-auth-session-rotated'
      AND revoked_at IS NOT NULL AND revoke_reason = 'refresh-rejected'
  ) THEN
    RAISE EXCEPTION 'refresh rotation or explicit rejection state is incomplete';
  END IF;
  IF (SELECT count(*) FROM console_audit.event
      WHERE correlation_id IN ('migration-session-refresh-rotate-0001', 'migration-session-refresh-rejected-0001')) <> 2
      OR EXISTS (
        SELECT 1 FROM console_audit.event
        WHERE correlation_id IN ('migration-session-refresh-rotate-0001', 'migration-session-refresh-rejected-0001')
          AND evidence::text ~ '(bmV3YWNjZXNz|bmV3cmVmcmVzaA|migration-verification-refresh-auth-session)'
      ) THEN
    RAISE EXCEPTION 'refresh audit evidence is missing or contains credential material';
  END IF;
END;
$$;
