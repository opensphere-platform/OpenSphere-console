\set ON_ERROR_STOP on

DO $$
DECLARE
  v_function text;
BEGIN
  IF to_regprocedure('console_operation.record_gitea_merge(uuid,text,text,integer,text)') IS NULL
      OR to_regprocedure('console_operation.get_gitea_operation_for_approval(uuid,uuid,bigint,bigint,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Gitea merge receipt function is missing';
  END IF;
  IF has_function_privilege('public', 'console_operation.record_gitea_merge(uuid,text,text,integer,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_operation.get_gitea_operation_for_approval(uuid,uuid,bigint,bigint,uuid)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_operation.record_gitea_merge(uuid,text,text,integer,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_operation.get_gitea_operation_for_approval(uuid,uuid,bigint,bigint,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Gitea merge receipt grant boundary is invalid';
  END IF;
  v_function := pg_get_functiondef(
    'console_operation.record_gitea_merge(uuid,text,text,integer,text)'::regprocedure
  );
  IF position('FOR UPDATE' IN v_function) = 0
      OR position('console.platform.change.propose' IN v_function) = 0
      OR position('API_GIT' IN v_function) = 0
      OR position('state = ''Submitted''' IN v_function) = 0
      OR position('source_revision = p_source_revision' IN v_function) = 0 THEN
    RAISE EXCEPTION 'Gitea merge receipt does not bind operation, revision and state atomically';
  END IF;
END;
$$;

DO $$
DECLARE
  v_initiator uuid := '61222222-2222-4222-8222-222222222222';
  v_approver uuid := '62222222-2222-4222-8222-222222222222';
  v_operation uuid := '63222222-2222-4222-8222-222222222222';
  v_session jsonb;
  v_projection jsonb;
  v_merge record;
  v_failed boolean := false;
BEGIN
  INSERT INTO auth.users(id) VALUES (v_initiator), (v_approver) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
  VALUES
    (v_initiator, '64222222-2222-4222-8222-222222222222', 1, 0),
    (v_approver, '65222222-2222-4222-8222-222222222222', 1, 0);
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
  VALUES
    (v_initiator, 'console.git.change', 1, v_initiator),
    (v_approver, 'console.operation.approve', 1, v_approver);
  v_session := console_identity.issue_browser_session(
    v_approver,
    sha256(convert_to('gitea-merge-approver-handle', 'UTF8')),
    sha256(convert_to('gitea-merge-approver-csrf', 'UTF8')),
    'v1.R0lURUFBQVBQUk9WRVJBQ0NFU1M.R0lURUFBQVBQUk9WRVJBQ0NFU1M.R0lURUFBQVBQUk9WRVJBQ0NFU1M',
    'v1.R0lURUFBQVBQUk9WRVJSRUZSRVNI.R0lURUFBQVBQUk9WRVJSRUZSRVNI.R0lURUFBQVBQUk9WRVJSRUZSRVNI',
    'gitea-merge-approver-auth-session', 'aal2',
    statement_timestamp() + interval '1 hour', statement_timestamp() + interval '24 hours',
    '24h', false, 'gitea-merge-session-0001'
  );
  UPDATE console_identity.browser_session SET last_reauthenticated_at = statement_timestamp()
   WHERE session_id = (v_session->>'sessionId')::uuid;

  INSERT INTO console_operation.operation(
    operation_id, action_id, action_version, actor_ref, target_ref, required_permission,
    payload_digest, request_digest, risk, reason, aal, permission_revision, plan_revision,
    approval_required, approval_revision, idempotency_key, correlation_id, source_revision,
    owner_ref, execution_plan, state, state_version
  ) VALUES (
    v_operation, 'console.platform.change.propose', '1.0', v_initiator,
    'gitea-change:opensphere-console:console/settings', 'console.git.change',
    'sha256:' || repeat('a', 64), 'sha256:' || repeat('b', 64), 'R2',
    'apply reviewed Console declaration', 'aal2', 1, 'console-operation-policy-2026-09-02.1',
    true, 'console-operation-policy-2026-09-02.1', 'gitea-merge-operation-0001',
    'gitea-merge-correlation-0001', NULL, 'API_GIT',
    jsonb_build_object(
      'schemaVersion', '1.0', 'authority', 'Gitea',
      'repository', 'opensphere/platform-declarations', 'defaultBranch', 'main',
      'consumerId', 'opensphere-console', 'action', 'configure',
      'target', 'console/settings', 'desiredState', jsonb_build_object('replicas', 2),
      'templateId', NULL, 'submittedAt', '2026-09-02T00:00:00.000Z'
    ), 'Authorized', 1
  );

  v_projection := console_operation.get_gitea_operation_for_approval(
    (v_session->>'sessionId')::uuid, v_approver, 1, 0, v_operation
  );
  IF (v_projection->>'operation_id')::uuid <> v_operation
      OR v_projection->>'state' <> 'Authorized' THEN
    RAISE EXCEPTION 'Gitea approval projection is invalid';
  END IF;

  SELECT * INTO v_merge FROM console_operation.record_gitea_merge(
    v_operation, repeat('c', 40), 'control/' || v_operation::text, 17,
    'gitea-merge-receipt-0001'
  );
  IF v_merge.replayed OR v_merge.operation_record->>'state' <> 'Submitted'
      OR v_merge.operation_record->>'source_revision' <> repeat('c', 40)
      OR (v_merge.operation_record->>'state_version')::bigint <> 2 THEN
    RAISE EXCEPTION 'Gitea merge receipt did not bind the protected revision: %', v_merge.operation_record;
  END IF;
  SELECT * INTO v_merge FROM console_operation.record_gitea_merge(
    v_operation, repeat('c', 40), 'control/' || v_operation::text, 17,
    'gitea-merge-receipt-replay-0001'
  );
  IF NOT v_merge.replayed THEN
    RAISE EXCEPTION 'same Gitea merge receipt was not idempotent';
  END IF;

  BEGIN
    PERFORM console_operation.record_gitea_merge(
      v_operation, repeat('d', 40), 'control/' || v_operation::text, 17,
      'gitea-merge-receipt-conflict-0001'
    );
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'conflicting Gitea merge revision was accepted';
  END IF;
END;
$$;
