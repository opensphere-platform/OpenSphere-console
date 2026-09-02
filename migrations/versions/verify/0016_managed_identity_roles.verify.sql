\set ON_ERROR_STOP on

DO $$
DECLARE
  v_admin uuid := '33333333-3333-4333-8333-333333333333';
  v_target uuid := '44444444-4444-4444-8444-444444444444';
  v_admin_session jsonb;
  v_target_session jsonb;
  v_admin_inventory jsonb;
  v_self_inventory jsonb;
  v_change jsonb;
  v_replay jsonb;
  v_before_events bigint;
  v_function_definition text;
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.list_managed_identities(uuid,uuid,bigint,bigint,text)') IS NULL
      OR to_regprocedure('console_identity.change_managed_identity_role(uuid,uuid,bigint,bigint,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'managed identity functions are missing';
  END IF;
  v_function_definition := pg_get_functiondef(
    'console_identity.change_managed_identity_role(uuid,uuid,bigint,bigint,uuid,text,text,text,text)'::regprocedure
  );
  IF position('pg_advisory_xact_lock(471920260903' IN v_function_definition) = 0
      OR position('pg_advisory_xact_lock(471920260903' IN v_function_definition)
         > position('SELECT * INTO v_session' IN v_function_definition) THEN
    RAISE EXCEPTION 'managed role mutation does not serialize before subject row locks';
  END IF;
  IF has_function_privilege('public', 'console_identity.list_managed_identities(uuid,uuid,bigint,bigint,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.change_managed_identity_role(uuid,uuid,bigint,bigint,uuid,text,text,text,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.list_managed_identities(uuid,uuid,bigint,bigint,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.change_managed_identity_role(uuid,uuid,bigint,bigint,uuid,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'managed identity function grants are not closed to console_api';
  END IF;
  IF console_identity.managed_role_permissions('console-admins') <> ARRAY[
      'console.audit.read', 'console.data_identity.read', 'console.extension.install',
      'console.extension.remove', 'console.extension.revoke', 'console.identity.manage',
      'console.operation.approve', 'console.operation.verify', 'console.registry.manage',
      'console.role.admin'
    ]::text[]
      OR console_identity.managed_role_permissions('unknown') <> ARRAY[]::text[]
      OR jsonb_array_length(console_identity.managed_role_catalog()) <> 3 THEN
    RAISE EXCEPTION 'managed role policy is not the closed catalog';
  END IF;

  INSERT INTO auth.users(id) VALUES (v_admin), (v_target) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
  VALUES
    (v_admin, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1, 0),
    (v_target, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1, 0);
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    SELECT v_admin, permission, 1, v_admin
      FROM unnest(console_identity.managed_role_permissions('console-admins')) AS permission;
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    SELECT v_target, permission, 1, v_admin
      FROM unnest(console_identity.managed_role_permissions('console-viewers')) AS permission;

  v_admin_session := console_identity.issue_browser_session(
    v_admin, sha256(convert_to('managed-admin-handle', 'UTF8')), sha256(convert_to('managed-admin-csrf', 'UTF8')),
    'v1.TUFOQUdFREFETUlOQUNDRVNT.TUFOQUdFREFETUlOQUNDRVNT.TUFOQUdFREFETUlOQUNDRVNT',
    'v1.TUFOQUdFREFETUlOUkVGUkVTSA.TUFOQUdFREFETUlOUkVGUkVTSA.TUFOQUdFREFETUlOUkVGUkVTSA',
    'auth-managed-admin', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'managed-admin-issue-0001'
  );
  UPDATE console_identity.browser_session SET last_reauthenticated_at = statement_timestamp()
    WHERE session_id = (v_admin_session->>'sessionId')::uuid;
  v_target_session := console_identity.issue_browser_session(
    v_target, sha256(convert_to('managed-target-handle', 'UTF8')), sha256(convert_to('managed-target-csrf', 'UTF8')),
    'v1.TUFOQUdFRFRBUkdFVEFDQ0VTUw.TUFOQUdFRFRBUkdFVEFDQ0VTUw.TUFOQUdFRFRBUkdFVEFDQ0VTUw',
    'v1.TUFOQUdFRFRBUkdFVFJFRlJFU0g.TUFOQUdFRFRBUkdFVFJFRlJFU0g.TUFOQUdFRFRBUkdFVFJFRlJFU0g',
    'auth-managed-target', 'aal1', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'managed-target-issue-0001'
  );

  v_admin_inventory := console_identity.list_managed_identities(
    (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, 'managed-admin-list-0001'
  );
  v_self_inventory := console_identity.list_managed_identities(
    (v_target_session->>'sessionId')::uuid, v_target, 1, 0, 'managed-self-list-0001'
  );
  IF v_admin_inventory->>'scope' <> 'managed'
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_admin_inventory->'items') item
         WHERE (item->>'subjectId')::uuid = v_target AND item->'roles' @> '["console-viewers"]'::jsonb
      )
      OR v_self_inventory->>'scope' <> 'self'
      OR jsonb_array_length(v_self_inventory->'items') <> 1
      OR (v_self_inventory->'items'->0->>'subjectId')::uuid <> v_target THEN
    RAISE EXCEPTION 'managed/self identity projection is invalid';
  END IF;

  SELECT count(*) INTO v_before_events FROM console_audit.event;
  v_change := console_identity.change_managed_identity_role(
    (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, v_target,
    'add', 'console-operators', 'grant operations access', 'managed-role-add-0001'
  );
  IF NOT (v_change->'roles' @> '["console-operators","console-viewers"]'::jsonb)
      OR (v_change->>'permissionRevision')::bigint <> 2
      OR (v_change->>'revokeEpoch')::bigint <> 1
      OR (v_change->>'revokedSessionCount')::integer <> 1
      OR (v_change->>'replayed')::boolean THEN
    RAISE EXCEPTION 'managed role mutation result is invalid: %', v_change;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.browser_session
     WHERE session_id = (v_target_session->>'sessionId')::uuid
       AND revoked_at IS NOT NULL AND revoke_reason = 'managed-role-changed'
  ) OR NOT EXISTS (
    SELECT 1 FROM console_audit.event
     WHERE action = 'console.identity.role.add'
       AND actor_ref = v_admin::text
       AND target_ref = 'subject:' || v_target::text || ':role:console-operators'
       AND outcome = 'succeeded'
       AND reason = 'grant operations access'
       AND evidence->>'role' = 'console-operators'
  ) OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'role mutation session revocation or audit evidence is invalid';
  END IF;
  v_replay := console_identity.change_managed_identity_role(
    (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, v_target,
    'add', 'console-operators', 'grant operations access', 'managed-role-replay-0001'
  );
  IF NOT (v_replay->>'replayed')::boolean
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'same role state was not a no-write replay';
  END IF;

  BEGIN
    PERFORM console_identity.change_managed_identity_role(
      (v_admin_session->>'sessionId')::uuid, v_admin, 1, 0, v_admin,
      'remove', 'console-admins', 'attempt self removal', 'managed-role-self-0001'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'administrator self-removal was not rejected before mutation and audit';
  END IF;
END;
$$;
