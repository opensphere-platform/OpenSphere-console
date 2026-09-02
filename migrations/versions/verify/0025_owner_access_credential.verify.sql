\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regprocedure('console_identity.prepare_owner_access_credential(bytea,bytea,boolean)') IS NULL
      OR to_regprocedure('console_identity.resolve_owner_access_authority(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'owner access credential functions are missing';
  END IF;
  IF has_function_privilege('public', 'console_identity.prepare_owner_access_credential(bytea,bytea,boolean)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.resolve_owner_access_authority(uuid,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.prepare_owner_access_credential(bytea,bytea,boolean)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.resolve_owner_access_authority(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'owner access credential grant boundary is invalid';
  END IF;
END;
$$;

DO $$
DECLARE
  v_subject uuid := '70250000-0000-4000-8000-000000000001';
  v_session jsonb;
  v_credential jsonb;
  v_authority jsonb;
  v_failed boolean := false;
BEGIN
  INSERT INTO auth.users(id) VALUES (v_subject) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
  VALUES (v_subject, '70250000-0000-4000-8000-000000000002', 1, 0);
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
  VALUES (v_subject, 'console.role.admin', 1, v_subject);
  v_session := console_identity.issue_browser_session(
    v_subject,
    sha256(convert_to('owner-access-session-handle', 'UTF8')),
    sha256(convert_to('owner-access-session-csrf', 'UTF8')),
    'v1.T1dORVJBQ0NFU1NDUkVERU5USUFM.T1dORVJBQ0NFU1NDUkVERU5USUFM.T1dORVJBQ0NFU1NDUkVERU5USUFM',
    'v1.T1dORVJSRUZSRVNIRFJFRENT.T1dORVJSRUZSRVNIRFJFRENT.T1dORVJSRUZSRVNIRFJFRENT',
    'owner-access-auth-session', 'aal2',
    statement_timestamp() + interval '1 hour', statement_timestamp() + interval '24 hours',
    '24h', false, 'owner-access-correlation-0001'
  );
  v_credential := console_identity.prepare_owner_access_credential(
    sha256(convert_to('owner-access-session-handle', 'UTF8')),
    sha256(convert_to('owner-access-session-csrf', 'UTF8')), true
  );
  IF v_credential->>'subjectId' <> v_subject::text
      OR v_credential->>'accessTokenCiphertext' NOT LIKE 'v1.%' THEN
    RAISE EXCEPTION 'owner credential projection is invalid: %', v_credential;
  END IF;
  v_authority := console_identity.resolve_owner_access_authority(v_subject, 'owner-access-auth-session');
  IF v_authority->>'sessionId' <> v_session->>'sessionId'
      OR v_authority->'permissions' <> '["console.role.admin"]'::jsonb
      OR v_authority->>'authorityFresh' <> 'true' THEN
    RAISE EXCEPTION 'owner authority projection is invalid: %', v_authority;
  END IF;

  BEGIN
    PERFORM console_identity.prepare_owner_access_credential(
      sha256(convert_to('owner-access-session-handle', 'UTF8')),
      sha256(convert_to('wrong-csrf', 'UTF8')), true
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'owner credential accepted wrong CSRF'; END IF;

  UPDATE console_identity.browser_session SET revoked_at = statement_timestamp(), revoke_reason = 'verification'
   WHERE session_id = (v_session->>'sessionId')::uuid;
  v_failed := false;
  BEGIN
    PERFORM console_identity.resolve_owner_access_authority(v_subject, 'owner-access-auth-session');
  EXCEPTION WHEN invalid_authorization_specification THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'revoked browser session retained owner bearer authority'; END IF;
END;
$$;
