\set ON_ERROR_STOP on

DO $$
DECLARE
  v_function text;
BEGIN
  IF to_regprocedure('console_operation.list_gitea_changes(uuid,uuid,bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'Gitea change inventory function is missing';
  END IF;
  IF has_function_privilege('public', 'console_operation.list_gitea_changes(uuid,uuid,bigint,bigint)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_operation.list_gitea_changes(uuid,uuid,bigint,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Gitea change inventory grant boundary is invalid';
  END IF;
  v_function := pg_get_functiondef(
    'console_operation.list_gitea_changes(uuid,uuid,bigint,bigint)'::regprocedure
  );
  IF position('console.git.change' IN v_function) = 0
      OR position('LIMIT 100' IN v_function) = 0
      OR position('console.platform.change.proposal' IN v_function) = 0
      OR position('desiredState' IN v_function) <> 0 THEN
    RAISE EXCEPTION 'Gitea change inventory is not bounded or exposes the desired-state payload';
  END IF;
END;
$$;

DO $$
DECLARE
  v_actor uuid := '69222222-2222-4222-8222-222222222222';
  v_operation uuid := '6a222222-2222-4222-8222-222222222222';
  v_session jsonb;
  v_inventory jsonb;
  v_failed boolean := false;
BEGIN
  INSERT INTO auth.users(id) VALUES (v_actor) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
  VALUES (v_actor, '6b222222-2222-4222-8222-222222222222', 1, 0);
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
  VALUES (v_actor, 'console.git.change', 1, v_actor);
  v_session := console_identity.issue_browser_session(
    v_actor,
    sha256(convert_to('gitea-inventory-session-handle', 'UTF8')),
    sha256(convert_to('gitea-inventory-session-csrf', 'UTF8')),
    'v1.R0lURUFBSU5WRU5UT1JZQUNDRVNT.R0lURUFBSU5WRU5UT1JZQUNDRVNT.R0lURUFBSU5WRU5UT1JZQUNDRVNT',
    'v1.R0lURUFBSU5WRU5UT1JZUkVGUkVTSA.R0lURUFBSU5WRU5UT1JZUkVGUkVTSA.R0lURUFBSU5WRU5UT1JZUkVGUkVTSA',
    'gitea-inventory-auth-session', 'aal2',
    statement_timestamp() + interval '1 hour', statement_timestamp() + interval '24 hours',
    '24h', false, 'gitea-inventory-session-0001'
  );

  INSERT INTO console_operation.operation(
    operation_id, action_id, action_version, actor_ref, target_ref, required_permission,
    payload_digest, request_digest, risk, reason, aal, permission_revision, plan_revision,
    approval_required, approval_revision, idempotency_key, correlation_id, source_revision,
    owner_ref, execution_plan, state, state_version
  ) VALUES (
    v_operation, 'console.platform.change.propose', '1.0', v_actor,
    'gitea-change:opensphere-console:console/settings', 'console.git.change',
    'sha256:' || repeat('a', 64), 'sha256:' || repeat('b', 64), 'R2',
    'project bounded change inventory', 'aal2', 1, 'console-operation-policy-2026-09-02.1',
    true, 'console-operation-policy-2026-09-02.1', 'gitea-inventory-operation-0001',
    'gitea-inventory-correlation-0001', NULL, 'API_GIT',
    jsonb_build_object(
      'schemaVersion', '1.0', 'authority', 'Gitea',
      'repository', 'opensphere/platform-declarations', 'defaultBranch', 'main',
      'consumerId', 'opensphere-console', 'action', 'configure',
      'target', 'console/settings', 'desiredState', jsonb_build_object('privateValue', 'must-not-project'),
      'templateId', NULL, 'submittedAt', '2026-09-02T00:00:00.000Z'
    ), 'Planned', 0
  );
  PERFORM console_operation.record_gitea_proposal(
    v_operation, repeat('c', 40), 'control/' || v_operation::text, 23,
    'gitea-inventory-proposal-0001'
  );

  v_inventory := console_operation.list_gitea_changes(
    (v_session->>'sessionId')::uuid, v_actor, 1, 0
  );
  IF jsonb_array_length(v_inventory->'items') < 1
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_inventory->'items') item
         WHERE item->>'operationId' = v_operation::text
           AND item->>'state' = 'Planned'
           AND item->'proposal'->>'desiredRevision' = repeat('c', 40)
           AND (item->'proposal'->>'pullNumber')::integer = 23
      )
      OR v_inventory::text LIKE '%must-not-project%' THEN
    RAISE EXCEPTION 'Gitea change inventory projection is invalid: %', v_inventory;
  END IF;

  UPDATE console_identity.permission_grant
     SET revoked_at = statement_timestamp()
   WHERE subject_id = v_actor AND permission = 'console.git.change';
  BEGIN
    PERFORM console_operation.list_gitea_changes(
      (v_session->>'sessionId')::uuid, v_actor, 1, 0
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'Gitea change inventory remained readable without permission';
  END IF;
END;
$$;
