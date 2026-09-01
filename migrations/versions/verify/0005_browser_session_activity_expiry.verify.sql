\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'console_identity' AND table_name = 'browser_session'
        AND column_name IN ('absolute_expires_at', 'persistence')) <> 2 THEN
    RAISE EXCEPTION 'browser session absolute-expiry columns are incomplete';
  END IF;
  IF to_regprocedure('console_identity.issue_browser_session(uuid,bytea,bytea,text,text,text,text,timestamptz,timestamptz,text,boolean,text)') IS NULL
      OR to_regprocedure('console_identity.activate_browser_session_mfa(uuid,uuid,bytea,text,text,text,timestamptz,text)') IS NULL
      OR to_regprocedure('console_identity.touch_browser_session_activity(bytea,bytea)') IS NULL THEN
    RAISE EXCEPTION 'bounded browser session activity functions are incomplete';
  END IF;
  IF has_function_privilege('public', 'console_identity.touch_browser_session_activity(bytea,bytea)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.touch_browser_session_activity(bytea,bytea)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.issue_browser_session(uuid,bytea,bytea,text,text,text,text,timestamptz,timestamptz,text,boolean,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.activate_browser_session_mfa(uuid,uuid,bytea,text,text,text,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'bounded browser session grants are not closed to console_api';
  END IF;
  IF has_function_privilege('console_api', 'console_identity.issue_browser_session(uuid,bytea,bytea,text,text,text,text,timestamptz,timestamptz,boolean,text)', 'EXECUTE')
      OR has_function_privilege('console_api', 'console_identity.activate_browser_session_mfa(uuid,uuid,bytea,text,text,text,timestamptz,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C_API retained a superseded session lifetime overload';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'console_identity.browser_session'::regclass
        AND conname = 'browser_session_persistence_closed'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'console_identity.browser_session'::regclass
        AND conname = 'browser_session_idle_within_absolute'
    ) THEN
    RAISE EXCEPTION 'browser session lifetime constraints are incomplete';
  END IF;
END;
$$;

SET ROLE console_api;
SELECT set_config(
  'verification.activity_session',
  console_identity.issue_browser_session(
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to('migration-verification-activity-handle', 'UTF8')),
    sha256(convert_to('migration-verification-activity-csrf', 'UTF8')),
    'v1.YWN0aXZpdHlhY2Nlc3Npdl8xMjM0NTY.YWN0aXZpdHlhY2Nlc3N0YWcxMjM0NTY.YWN0aXZpdHlhY2Nlc3NjaXBoZXJ0ZXh0',
    'v1.YWN0aXZpdHlyZWZyZXNoaXYxMjM0NTY.YWN0aXZpdHlyZWZyZXNodGFnMTIzNDU2.YWN0aXZpdHlyZWZyZXNoY2lwaGVydGV4dA',
    'migration-verification-activity-auth-session', 'aal1',
    statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '7 days', '7d', false,
    'migration-session-activity-issue-0001'
  )::text,
  false
);

DO $$
DECLARE
  v_issued jsonb := current_setting('verification.activity_session')::jsonb;
  v_immediate jsonb;
BEGIN
  IF v_issued->>'persistence' <> '7d'
      OR (v_issued->>'idleExpiresAt')::timestamptz < statement_timestamp() + interval '11 hours 59 minutes'
      OR (v_issued->>'idleExpiresAt')::timestamptz > statement_timestamp() + interval '12 hours 1 minute'
      OR (v_issued->>'absoluteExpiresAt')::timestamptz < statement_timestamp() + interval '6 days 23 hours 59 minutes'
      OR (v_issued->>'absoluteExpiresAt')::timestamptz > statement_timestamp() + interval '7 days 1 minute' THEN
    RAISE EXCEPTION 'issued session did not bind idle and absolute lifetime';
  END IF;
  v_immediate := console_identity.touch_browser_session_activity(
    sha256(convert_to('migration-verification-activity-handle', 'UTF8')),
    sha256(convert_to('migration-verification-activity-csrf', 'UTF8'))
  );
  IF v_immediate->>'lastSeenAt' <> v_issued->>'lastSeenAt'
      OR v_immediate->>'idleExpiresAt' <> v_issued->>'idleExpiresAt' THEN
    RAISE EXCEPTION 'activity touch bypassed the one-write-per-minute bound';
  END IF;
  BEGIN
    PERFORM console_identity.touch_browser_session_activity(
      sha256(convert_to('migration-verification-activity-handle', 'UTF8')),
      sha256(convert_to('migration-verification-wrong-csrf', 'UTF8'))
    );
    RAISE EXCEPTION 'activity touch accepted an invalid CSRF proof';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
END;
$$;
RESET ROLE;

UPDATE console_identity.browser_session
SET last_seen_at = statement_timestamp() - interval '2 minutes',
    expires_at = statement_timestamp() + interval '1 hour'
WHERE session_id = (current_setting('verification.activity_session')::jsonb->>'sessionId')::uuid;

SET ROLE console_api;
SELECT set_config(
  'verification.activity_touched',
  console_identity.touch_browser_session_activity(
    sha256(convert_to('migration-verification-activity-handle', 'UTF8')),
    sha256(convert_to('migration-verification-activity-csrf', 'UTF8'))
  )::text,
  false
);
RESET ROLE;

DO $$
DECLARE
  v_issued jsonb := current_setting('verification.activity_session')::jsonb;
  v_touched jsonb := current_setting('verification.activity_touched')::jsonb;
BEGIN
  IF (v_touched->>'lastSeenAt')::timestamptz <= statement_timestamp() - interval '1 minute'
      OR (v_touched->>'idleExpiresAt')::timestamptz < statement_timestamp() + interval '11 hours 59 minutes'
      OR (v_touched->>'idleExpiresAt')::timestamptz > statement_timestamp() + interval '12 hours 1 minute'
      OR v_touched->>'absoluteExpiresAt' <> v_issued->>'absoluteExpiresAt'
      OR (v_touched->>'idleExpiresAt')::timestamptz > (v_touched->>'absoluteExpiresAt')::timestamptz THEN
    RAISE EXCEPTION 'activity touch did not extend idle expiry within the immutable absolute bound';
  END IF;
  IF (SELECT count(*) FROM console_audit.event
      WHERE correlation_id = 'migration-session-activity-issue-0001') <> 1
      OR EXISTS (
        SELECT 1 FROM console_audit.event
        WHERE correlation_id = 'migration-session-activity-issue-0001'
          AND evidence::text ~ '(migration-verification-activity-handle|migration-verification-activity-csrf|YWN0aXZpdHlhY2Nlc3M|YWN0aXZpdHlyZWZyZXNo)'
      ) THEN
    RAISE EXCEPTION 'activity session audit evidence is missing or contains credential material';
  END IF;
END;
$$;
