DO $$
DECLARE
  v_actor uuid := '10000000-0000-4000-8000-000000000091';
  v_approver uuid := '10000000-0000-4000-8000-000000000092';
  v_actor_session jsonb;
  v_approver_session jsonb;
  v_context jsonb;
  v_operation jsonb;
  v_failed boolean;
BEGIN
  INSERT INTO auth.users(id) VALUES (v_actor), (v_approver) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
    VALUES (v_actor, gen_random_uuid(), 1, 0), (v_approver, gen_random_uuid(), 1, 0)
    ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    VALUES
      (v_actor, 'console.registry.manage', 1, v_actor),
      (v_approver, 'console.operation.approve', 1, v_approver)
    ON CONFLICT DO NOTHING;
  v_actor_session := console_identity.issue_browser_session(
    v_actor, sha256('recent-actor-session'::bytea), sha256('recent-actor-csrf'::bytea),
    'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
    'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB',
    'auth-recent-actor-1', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'verify-recent-actor-issue'
  );
  v_failed := false;
  BEGIN
    PERFORM * FROM console_operation.accept_operation(
      (v_actor_session->>'sessionId')::uuid, v_actor, 1, 0, 'console.registry.manage',
      'console.registry.connection.replace', '1.0', 'registry-connection:opensphere-ghcr',
      'sha256:' || repeat('a', 64), 'R2', 'verify recent aal2 denial',
      'recent-aal2-verifier', true, 'recent-aal2-denied-0001', 'recent-aal2-denied-correlation',
      NULL, 'C_EXT', NULL, NULL
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF SQLERRM <> 'recent aal2 is required' THEN RAISE; END IF;
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'aal2 without recent proof accepted R2 operation'; END IF;

  v_context := console_identity.get_browser_session_step_up_credentials(
    sha256('recent-actor-session'::bytea), sha256('recent-actor-csrf'::bytea)
  );
  PERFORM console_identity.complete_browser_session_step_up(
    (v_context->>'sessionId')::uuid, v_actor, decode(v_context->>'expectedAccessCiphertextDigest', 'hex'),
    'v1.CCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC',
    'v1.DDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD',
    'auth-recent-actor-2', statement_timestamp() + interval '1 hour', 'verify-recent-actor-step-up'
  );
  SELECT operation_record INTO v_operation FROM console_operation.accept_operation(
    (v_actor_session->>'sessionId')::uuid, v_actor, 1, 0, 'console.registry.manage',
    'console.registry.connection.replace', '1.0', 'registry-connection:opensphere-ghcr',
    'sha256:' || repeat('b', 64), 'R2', 'verify recent aal2 success',
    'recent-aal2-verifier', true, 'recent-aal2-accepted-0001', 'recent-aal2-accepted-correlation',
    NULL, 'C_EXT', NULL, NULL
  );
  v_context := console_identity.resolve_browser_session(
    sha256('recent-actor-session'::bytea), sha256('recent-actor-csrf'::bytea), true
  );
  IF v_context->>'aal' <> 'aal2' OR v_context->>'lastReauthenticatedAt' IS NULL THEN
    RAISE EXCEPTION 'fresh AAL2 session projection lost recent proof';
  END IF;

  v_approver_session := console_identity.issue_browser_session(
    v_approver, sha256('recent-approver-session'::bytea), sha256('recent-approver-csrf'::bytea),
    'v1.EEEEEEEEEEEEEEEE.EEEEEEEEEEEEEEEEEEEEEE.EEEEEEEEEEEEEEEEEEEEEE',
    'v1.FFFFFFFFFFFFFFFF.FFFFFFFFFFFFFFFFFFFFFF.FFFFFFFFFFFFFFFFFFFFFFFF',
    'auth-recent-approver-1', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'verify-recent-approver-issue'
  );
  v_failed := false;
  BEGIN
    PERFORM * FROM console_operation.approve_operation(
      (v_approver_session->>'sessionId')::uuid, v_approver, 1, 0,
      (v_operation->>'operation_id')::uuid, 0, 'verify recent approval denial',
      'recent-aal2-verifier', NULL, 'recent-approval-denied-0001', 'recent-approval-denied-correlation'
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF SQLERRM <> 'recent aal2 is required' THEN RAISE; END IF;
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'approval accepted without recent proof'; END IF;

  v_context := console_identity.get_browser_session_step_up_credentials(
    sha256('recent-approver-session'::bytea), sha256('recent-approver-csrf'::bytea)
  );
  PERFORM console_identity.complete_browser_session_step_up(
    (v_context->>'sessionId')::uuid, v_approver, decode(v_context->>'expectedAccessCiphertextDigest', 'hex'),
    'v1.GGGGGGGGGGGGGGGG.GGGGGGGGGGGGGGGGGGGGGG.GGGGGGGGGGGGGGGGGGGGGG',
    'v1.HHHHHHHHHHHHHHHH.HHHHHHHHHHHHHHHHHHHHHH.HHHHHHHHHHHHHHHHHHHHHH',
    'auth-recent-approver-2', statement_timestamp() + interval '1 hour', 'verify-recent-approver-step-up'
  );
  PERFORM * FROM console_operation.approve_operation(
    (v_approver_session->>'sessionId')::uuid, v_approver, 1, 0,
    (v_operation->>'operation_id')::uuid, 0, 'verify recent approval success',
    'recent-aal2-verifier', NULL, 'recent-approval-accepted-0001', 'recent-approval-accepted-correlation'
  );

  UPDATE console_identity.browser_session SET last_reauthenticated_at = statement_timestamp() - interval '6 minutes'
    WHERE session_id = (v_actor_session->>'sessionId')::uuid;
  v_context := console_identity.resolve_browser_session(
    sha256('recent-actor-session'::bytea), sha256('recent-actor-csrf'::bytea), true
  );
  IF v_context->>'aal' <> 'aal1' THEN
    RAISE EXCEPTION 'expired AAL2 session projection remained privileged';
  END IF;
  v_failed := false;
  BEGIN
    PERFORM * FROM console_operation.accept_operation(
      (v_actor_session->>'sessionId')::uuid, v_actor, 1, 0, 'console.registry.manage',
      'console.registry.connection.replace', '1.0', 'registry-connection:opensphere-ghcr',
      'sha256:' || repeat('c', 64), 'R2', 'verify expired aal2 denial',
      'recent-aal2-verifier', false, 'expired-aal2-denied-0001', 'expired-aal2-denied-correlation',
      NULL, 'C_EXT', NULL, NULL
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'expired recent proof accepted R2 operation'; END IF;
END;
$$;
