\set ON_ERROR_STOP on

DO $$
DECLARE
  v_admin uuid := '55171717-1717-4171-8171-171717171717';
  v_target uuid := '66666666-6666-4666-8666-666666666666';
  v_created uuid := '77171717-1717-4171-8171-171717171717';
  v_admin_session jsonb;
  v_target_session jsonb;
  v_result jsonb;
  v_definition text;
  v_before_events bigint;
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.prepare_managed_identity_lifecycle(uuid,uuid,bigint,bigint,uuid,text,text,text,text[],boolean,text,text)') IS NULL
      OR to_regprocedure('console_identity.complete_managed_identity_lifecycle(uuid,uuid,bigint,bigint,uuid,text,text,text,text[],boolean,boolean,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'managed identity lifecycle functions are missing';
  END IF;
  v_definition := pg_get_functiondef(
    'console_identity.prepare_managed_identity_lifecycle(uuid,uuid,bigint,bigint,uuid,text,text,text,text[],boolean,text,text)'::regprocedure
  );
  IF position('pg_advisory_xact_lock(471920260903' IN v_definition) = 0
      OR position('pg_advisory_xact_lock(471920260903' IN v_definition)
         > position('SELECT * INTO v_session' IN v_definition) THEN
    RAISE EXCEPTION 'managed identity lifecycle does not serialize before row locks';
  END IF;
  IF has_function_privilege('public', 'console_identity.prepare_managed_identity_lifecycle(uuid,uuid,bigint,bigint,uuid,text,text,text,text[],boolean,text,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.complete_managed_identity_lifecycle(uuid,uuid,bigint,bigint,uuid,text,text,text,text[],boolean,boolean,integer,text,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.prepare_managed_identity_lifecycle(uuid,uuid,bigint,bigint,uuid,text,text,text,text[],boolean,text,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.complete_managed_identity_lifecycle(uuid,uuid,bigint,bigint,uuid,text,text,text,text[],boolean,boolean,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'managed identity lifecycle grants are not closed to console_api';
  END IF;

  INSERT INTO auth.users(id) VALUES (v_admin), (v_target) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
  VALUES
    (v_admin, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 1, 0),
    (v_target, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 1, 0);
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    SELECT v_admin, permission, 1, v_admin
      FROM unnest(console_identity.managed_role_permissions('console-admins')) AS permission;
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    SELECT v_target, permission, 1, v_admin
      FROM unnest(console_identity.managed_role_permissions('console-viewers')) AS permission;

  v_admin_session := console_identity.issue_browser_session(
    v_admin, sha256(convert_to('lifecycle-admin-handle', 'UTF8')), sha256(convert_to('lifecycle-admin-csrf', 'UTF8')),
    'v1.TElGRUNZQ0xFQURNSU5BQ0NFU1M.TElGRUNZQ0xFQURNSU5BQ0NFU1M.TElGRUNZQ0xFQURNSU5BQ0NFU1M',
    'v1.TElGRUNZQ0xFQURNSU5SRUZSRVNI.TElGRUNZQ0xFQURNSU5SRUZSRVNI.TElGRUNZQ0xFQURNSU5SRUZSRVNI',
    'auth-lifecycle-admin', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'lifecycle-admin-issue-0001'
  );
  UPDATE console_identity.browser_session SET last_reauthenticated_at = statement_timestamp()
    WHERE session_id = (v_admin_session->>'sessionId')::uuid;

  SELECT count(*) INTO v_before_events FROM console_audit.event;
  PERFORM console_identity.prepare_managed_identity_lifecycle(
    (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, NULL,
    'identity.create', 'sha256:' || repeat('1', 64), 'lifecycle-create-key-0001',
    ARRAY['console-viewers'], NULL, 'create bounded viewer identity', 'lifecycle-create-correlation-0001'
  );
  INSERT INTO auth.users(id) VALUES (v_created);
  v_result := console_identity.complete_managed_identity_lifecycle(
    (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, v_created,
    'identity.create', 'sha256:' || repeat('1', 64), 'lifecycle-create-key-0001',
    ARRAY['console-viewers'], NULL, false, 0, 'create bounded viewer identity', 'lifecycle-create-correlation-0001'
  );
  IF (v_result->>'targetSubjectId')::uuid <> v_created
      OR NOT (v_result->'roles' @> '["console-viewers"]'::jsonb)
      OR NOT EXISTS (
        SELECT 1 FROM console_identity.permission_grant
         WHERE subject_id = v_created AND permission = 'console.audit.read'
           AND grant_revision = 1 AND revoked_at IS NULL
      )
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 2 THEN
    RAISE EXCEPTION 'managed identity creation completion is invalid: %', v_result;
  END IF;

  v_target_session := console_identity.issue_browser_session(
    v_target, sha256(convert_to('lifecycle-target-handle', 'UTF8')), sha256(convert_to('lifecycle-target-csrf', 'UTF8')),
    'v1.TElGRUNZQ0xFVEFSR0VUQUNDRVNT.TElGRUNZQ0xFVEFSR0VUQUNDRVNT.TElGRUNZQ0xFVEFSR0VUQUNDRVNT',
    'v1.TElGRUNZQ0xFVEFSR0VUUkVGUkVTSA.TElGRUNZQ0xFVEFSR0VUUkVGUkVTSA.TElGRUNZQ0xFVEFSR0VUUkVGUkVTSA',
    'auth-lifecycle-target', 'aal1', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'lifecycle-target-issue-0001'
  );
  PERFORM console_identity.prepare_managed_identity_lifecycle(
    (v_target_session->>'sessionId')::uuid, v_target, 1, 0, v_target,
    'profile.update', 'sha256:' || repeat('5', 64), 'lifecycle-self-profile-key-0001',
    ARRAY[]::text[], NULL, 'update own managed profile values', 'lifecycle-self-profile-correlation-0001'
  );
  v_result := console_identity.complete_managed_identity_lifecycle(
    (v_target_session->>'sessionId')::uuid, v_target, 1, 0, v_target,
    'profile.update', 'sha256:' || repeat('5', 64), 'lifecycle-self-profile-key-0001',
    ARRAY[]::text[], NULL, false, 0, 'update own managed profile values', 'lifecycle-self-profile-correlation-0001'
  );
  IF (v_result->>'targetSubjectId')::uuid <> v_target
      OR (v_result->>'revokedSessionCount')::integer <> 0 THEN
    RAISE EXCEPTION 'AAL1 self-profile completion is invalid: %', v_result;
  END IF;
  PERFORM console_identity.prepare_managed_identity_lifecycle(
    (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, v_target,
    'enabled.change', 'sha256:' || repeat('2', 64), 'lifecycle-disable-key-0001',
    ARRAY[]::text[], false, 'disable bounded viewer identity', 'lifecycle-disable-correlation-0001'
  );
  v_result := console_identity.complete_managed_identity_lifecycle(
    (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, v_target,
    'enabled.change', 'sha256:' || repeat('2', 64), 'lifecycle-disable-key-0001',
    ARRAY[]::text[], false, true, 0, 'disable bounded viewer identity', 'lifecycle-disable-correlation-0001'
  );
  IF (v_result->>'revokeEpoch')::bigint <> 1
      OR (v_result->>'revokedSessionCount')::integer <> 1
      OR NOT EXISTS (
        SELECT 1 FROM console_identity.browser_session
         WHERE session_id = (v_target_session->>'sessionId')::uuid
           AND revoked_at IS NOT NULL AND revoke_reason = 'managed-identity-enabled-change'
      ) THEN
    RAISE EXCEPTION 'managed identity disable did not revoke current sessions: %', v_result;
  END IF;

  BEGIN
    PERFORM console_identity.prepare_managed_identity_lifecycle(
      (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, v_admin,
      'mfa.reset', 'sha256:' || repeat('3', 64), 'lifecycle-self-mfa-key-0001',
      ARRAY[]::text[], NULL, 'reject administrator self reset', 'lifecycle-self-mfa-correlation-0001'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'administrator self MFA reset was not rejected';
  END IF;

  v_failed := false;
  BEGIN
    PERFORM console_identity.prepare_managed_identity_lifecycle(
      (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, v_admin,
      'enabled.change', 'sha256:' || repeat('4', 64), 'lifecycle-disable-admin-key-0001',
      ARRAY[]::text[], false, 'reject administrator disable request', 'lifecycle-disable-admin-correlation-0001'
    );
  EXCEPTION WHEN check_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'administrator disable was not rejected';
  END IF;

  v_failed := false;
  BEGIN
    PERFORM console_identity.prepare_managed_identity_lifecycle(
      (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, NULL,
      'identity.create', 'sha256:' || repeat('1', 64), 'lifecycle-create-key-0001',
      ARRAY['console-viewers'], NULL, 'create bounded viewer identity', 'lifecycle-replay-correlation-0001'
    );
  EXCEPTION WHEN unique_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (
    SELECT count(*) FROM console_audit.event
     WHERE action LIKE 'console.identity.lifecycle.%'
  ) <> 6 THEN
    RAISE EXCEPTION 'idempotency replay was not rejected without a new audit event';
  END IF;
  IF EXISTS (
    SELECT 1 FROM console_audit.event
     WHERE action LIKE 'console.identity.lifecycle.%'
       AND (evidence::text ~* '(password|token|email|display.?name|secret)')
  ) THEN
    RAISE EXCEPTION 'managed identity lifecycle audit contains forbidden identity or credential material';
  END IF;
END;
$$;
