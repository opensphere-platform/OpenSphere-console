\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'console_identity'
        AND table_name = 'browser_session'
        AND column_name IN ('auth_session_ref', 'access_token_ciphertext', 'refresh_token_ciphertext')) <> 3 THEN
    RAISE EXCEPTION 'browser session credential-envelope columns are incomplete';
  END IF;
  IF (SELECT count(*) FROM console_migration.applied_migration) <> 5
      OR (SELECT global_id FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1)
         <> 'opensphere-console/20260902/0005' THEN
    RAISE EXCEPTION 'browser session credential migration lineage is incomplete';
  END IF;
END;
$$;

SET ROLE console_api;
SELECT set_config(
  'verification.issued_browser_session',
  console_identity.issue_browser_session(
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to('migration-verification-session-handle', 'UTF8')),
    sha256(convert_to('migration-verification-csrf-token', 'UTF8')),
    'v1.aW50ZWdyYXRpb24.aW50ZWdyYXRpb24.aW50ZWdyYXRpb24',
    'v1.cmVmcmVzaA.cmVmcmVzaA.cmVmcmVzaA',
    'migration-verification-auth-session',
    'aal1',
    statement_timestamp() + interval '5 minutes',
    statement_timestamp() + interval '24 hours',
    '24h',
    false,
    'migration-session-issue-verification-0001'
  )::text,
  false
);
RESET ROLE;

DO $$
DECLARE
  v_session jsonb := current_setting('verification.issued_browser_session')::jsonb;
BEGIN
  IF v_session->>'subjectId' <> '11111111-1111-4111-8111-111111111111'
      OR v_session->>'state' <> 'active'
      OR v_session->>'aal' <> 'aal1' THEN
    RAISE EXCEPTION 'issued browser session lost its authority projection';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.browser_session
    WHERE session_id = (v_session->>'sessionId')::uuid
      AND octet_length(token_digest) = 32
      AND octet_length(csrf_token_digest) = 32
      AND access_token_ciphertext LIKE 'v1.%'
      AND refresh_token_ciphertext LIKE 'v1.%'
      AND auth_session_ref = 'migration-verification-auth-session'
  ) THEN
    RAISE EXCEPTION 'issued browser session did not retain the closed credential envelope';
  END IF;
  IF EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE correlation_id = 'migration-session-issue-verification-0001'
      AND evidence::text ~ '(migration-verification-session-handle|migration-verification-csrf-token|aW50ZWdyYXRpb24|cmVmcmVzaA)'
  ) THEN
    RAISE EXCEPTION 'browser session credential material leaked into audit evidence';
  END IF;
END;
$$;
