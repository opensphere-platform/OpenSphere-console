\set ON_ERROR_STOP on

DO $$
DECLARE
  v_function text;
BEGIN
  IF to_regprocedure('console_operation.record_gitea_proposal(uuid,text,text,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'Gitea proposal receipt function is missing';
  END IF;
  IF has_function_privilege('public', 'console_operation.record_gitea_proposal(uuid,text,text,integer,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_operation.record_gitea_proposal(uuid,text,text,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Gitea proposal receipt grant boundary is invalid';
  END IF;
  v_function := pg_get_functiondef(
    'console_operation.record_gitea_proposal(uuid,text,text,integer,text)'::regprocedure
  );
  IF position('FOR UPDATE' IN v_function) = 0
      OR position('console.platform.change.propose' IN v_function) = 0
      OR position('opensphere/platform-declarations' IN v_function) = 0
      OR position('console.platform.change.proposal' IN v_function) = 0 THEN
    RAISE EXCEPTION 'Gitea proposal receipt does not bind operation, repository and immutable audit evidence';
  END IF;
END;
$$;

DO $$
DECLARE
  v_actor uuid := '66222222-2222-4222-8222-222222222222';
  v_operation uuid := '67222222-2222-4222-8222-222222222222';
  v_receipt record;
  v_before_events bigint;
  v_failed boolean := false;
BEGIN
  INSERT INTO auth.users(id) VALUES (v_actor) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
  VALUES (v_actor, '68222222-2222-4222-8222-222222222222', 1, 0);

  INSERT INTO console_operation.operation(
    operation_id, action_id, action_version, actor_ref, target_ref, required_permission,
    payload_digest, request_digest, risk, reason, aal, permission_revision, plan_revision,
    approval_required, approval_revision, idempotency_key, correlation_id, source_revision,
    owner_ref, execution_plan, state, state_version
  ) VALUES (
    v_operation, 'console.platform.change.propose', '1.0', v_actor,
    'gitea-change:opensphere-console:console/settings', 'console.git.change',
    'sha256:' || repeat('a', 64), 'sha256:' || repeat('b', 64), 'R2',
    'record reviewed proposal coordinates', 'aal2', 1, 'console-operation-policy-2026-09-02.1',
    true, 'console-operation-policy-2026-09-02.1', 'gitea-proposal-operation-0001',
    'gitea-proposal-correlation-0001', NULL, 'API_GIT',
    jsonb_build_object(
      'schemaVersion', '1.0', 'authority', 'Gitea',
      'repository', 'opensphere/platform-declarations', 'defaultBranch', 'main',
      'consumerId', 'opensphere-console', 'action', 'configure',
      'target', 'console/settings', 'desiredState', jsonb_build_object('replicas', 2),
      'templateId', NULL, 'submittedAt', '2026-09-02T00:00:00.000Z'
    ), 'Planned', 0
  );

  SELECT count(*) INTO v_before_events FROM console_audit.event;
  SELECT * INTO v_receipt FROM console_operation.record_gitea_proposal(
    v_operation, repeat('c', 40), 'control/' || v_operation::text, 17,
    'gitea-proposal-receipt-0001'
  );
  IF v_receipt.replayed
      OR v_receipt.proposal_record->>'desiredRevision' <> repeat('c', 40)
      OR (v_receipt.proposal_record->>'pullNumber')::integer <> 17
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'Gitea proposal receipt was not appended exactly once: %', v_receipt.proposal_record;
  END IF;

  SELECT * INTO v_receipt FROM console_operation.record_gitea_proposal(
    v_operation, repeat('c', 40), 'control/' || v_operation::text, 17,
    'gitea-proposal-receipt-replay-0001'
  );
  IF NOT v_receipt.replayed
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'same Gitea proposal receipt was not a no-write replay';
  END IF;

  BEGIN
    PERFORM console_operation.record_gitea_proposal(
      v_operation, repeat('d', 40), 'control/' || v_operation::text, 17,
      'gitea-proposal-receipt-conflict-0001'
    );
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'conflicting Gitea proposal receipt was not rejected without another event';
  END IF;
END;
$$;
