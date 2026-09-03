-- CON-FR-007/014/017: execute the credential authority boundary on real PostgreSQL.
DO $$
BEGIN
  IF has_function_privilege('public', 'console_extension.assert_registry_credential_authority(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'console_extension.record_registry_credential_result(uuid,uuid,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('console_api', 'console_extension.assert_registry_credential_authority(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('console_api', 'console_extension.record_registry_credential_result(uuid,uuid,text,uuid,text)', 'EXECUTE')
     OR has_table_privilege('console_api', 'console_identity.browser_session', 'UPDATE') THEN
    RAISE EXCEPTION 'Registry credential SQL privilege boundary is invalid';
  END IF;
END;
$$;

DO $$
DECLARE
  v_actor uuid := '70270000-0000-4000-8000-000000000001';
  v_session jsonb;
  v_sid uuid;
  v_failed boolean;
  v_event uuid := '70270000-0000-4000-8000-000000000002';
  v_generation uuid := '70270000-0000-4000-8000-000000000003';
BEGIN
  INSERT INTO auth.users(id) VALUES (v_actor);
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
    VALUES(v_actor, gen_random_uuid(), 1, 0);
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    VALUES(v_actor, 'console.registry.manage', 1, v_actor);
  v_session := console_identity.issue_browser_session(
    v_actor, sha256('registry-authority-session'::bytea), sha256('registry-authority-csrf'::bytea),
    'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
    'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB',
    'registry-authority-auth-session', 'aal2', statement_timestamp()+interval '1 hour',
    statement_timestamp()+interval '24 hours', '24h', false, 'registry-authority-issue');
  v_sid := (v_session->>'sessionId')::uuid;
  SET LOCAL ROLE console_api;
  v_failed := false;
  BEGIN PERFORM console_extension.assert_registry_credential_authority(v_sid,v_actor);
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'MFA freshness was not required'; END IF;
  RESET ROLE;
  UPDATE console_identity.browser_session SET last_reauthenticated_at=statement_timestamp() WHERE session_id=v_sid;
  SET LOCAL ROLE console_api;
  IF NOT console_extension.assert_registry_credential_authority(v_sid,v_actor) THEN RAISE EXCEPTION 'Fresh registry authority rejected'; END IF;
  v_failed := false;
  BEGIN PERFORM console_extension.assert_registry_credential_authority(v_sid,gen_random_uuid());
  EXCEPTION WHEN SQLSTATE '28000' THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Other actor used registry session'; END IF;
  RESET ROLE;
  UPDATE console_identity.browser_session SET last_reauthenticated_at=statement_timestamp()-interval '6 minutes' WHERE session_id=v_sid;
  SET LOCAL ROLE console_api;
  v_failed := false;
  BEGIN PERFORM console_extension.assert_registry_credential_authority(v_sid,v_actor);
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Expired MFA proof was accepted'; END IF;
  RESET ROLE;
  UPDATE console_identity.browser_session SET last_reauthenticated_at=statement_timestamp() WHERE session_id=v_sid;
  UPDATE console_identity.permission_grant SET revoked_at=statement_timestamp() WHERE subject_id=v_actor;
  SET LOCAL ROLE console_api;
  v_failed := false;
  BEGIN PERFORM console_extension.assert_registry_credential_authority(v_sid,v_actor);
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Revoked registry permission was accepted'; END IF;
  PERFORM console_extension.record_registry_credential_result(NULL,v_event,'accepted',v_generation,'RefreshStarted');
  PERFORM console_extension.record_registry_credential_result(NULL,v_event,'accepted',v_generation,'RefreshStarted');
  v_failed := false;
  BEGIN PERFORM console_extension.record_registry_credential_result(gen_random_uuid(),gen_random_uuid(),'accepted',v_generation,'RefreshStarted');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Unknown operation acquired Registry authority'; END IF;
  v_failed := false;
  BEGIN PERFORM console_extension.record_registry_credential_result(NULL,gen_random_uuid(),'failed',v_generation,'arbitrary-provider-response');
  EXCEPTION WHEN invalid_parameter_value THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Raw provider error accepted as an audit code'; END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM console_audit.event WHERE correlation_id='registry:'||v_event::text||':accepted') <> 1 THEN
    RAISE EXCEPTION 'Credential audit replay duplicated an event';
  END IF;
END;
$$;