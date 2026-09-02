\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_subject uuid := '91919191-9191-4919-8919-919191919191';
  v_other uuid := '92929292-9292-4929-8929-929292929292';
  v_result jsonb;
  v_before_events bigint;
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.get_initial_administrator_bootstrap_status()') IS NULL
      OR to_regprocedure('console_identity.claim_initial_administrator(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'initial administrator bootstrap functions are missing';
  END IF;
  IF has_function_privilege('public', 'console_identity.get_initial_administrator_bootstrap_status()', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.claim_initial_administrator(uuid,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.get_initial_administrator_bootstrap_status()', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.claim_initial_administrator(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'initial administrator bootstrap grants are not closed to console_api';
  END IF;
  IF EXISTS (SELECT 1 FROM console_identity.subject_authority) THEN
    RAISE EXCEPTION 'initial administrator verifier requires an empty fresh authority database';
  END IF;
  IF console_identity.get_initial_administrator_bootstrap_status() <> '{"state":"required"}'::jsonb THEN
    RAISE EXCEPTION 'fresh bootstrap status is not required';
  END IF;

  INSERT INTO auth.users(id) VALUES (v_subject), (v_other);
  SELECT count(*) INTO v_before_events FROM console_audit.event;
  v_result := console_identity.claim_initial_administrator(
    v_subject, 'initial-administrator-bootstrap-0001'
  );

  IF v_result->>'state' <> 'complete'
      OR (v_result->>'subjectId')::uuid <> v_subject
      OR (v_result->>'permissionRevision')::bigint <> 1
      OR (v_result->>'permissionCount')::integer <> 11
      OR console_identity.get_initial_administrator_bootstrap_status() <> '{"state":"complete"}'::jsonb THEN
    RAISE EXCEPTION 'initial administrator bootstrap receipt or status is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.subject_authority
    WHERE subject_id = v_subject AND permission_revision = 1 AND revoke_epoch = 0
  ) OR EXISTS (
    SELECT 1 FROM console_identity.subject_authority WHERE subject_id = v_other
  ) OR (SELECT count(*) FROM console_identity.permission_grant WHERE subject_id = v_subject) <> 11 THEN
    RAISE EXCEPTION 'initial administrator authority set is incomplete or overbroad';
  END IF;
  IF (SELECT array_agg(permission ORDER BY permission) FROM console_identity.permission_grant WHERE subject_id = v_subject)
      <> ARRAY[
        'console.audit.read', 'console.data_identity.read', 'console.extension.install',
        'console.extension.remove', 'console.extension.revoke', 'console.git.change',
        'console.identity.manage', 'console.operation.approve', 'console.operation.verify',
        'console.registry.manage', 'console.role.admin'
      ]::text[] THEN
    RAISE EXCEPTION 'initial administrator permission set drifted';
  END IF;
  IF (SELECT count(*) FROM console_audit.event) <> v_before_events + 1
      OR NOT EXISTS (
        SELECT 1 FROM console_audit.event
        WHERE event_id = (v_result->>'auditEventId')::uuid
          AND actor_ref = v_subject::text
          AND action = 'console.identity.bootstrap.initial_administrator'
          AND target_ref = 'subject:' || v_subject::text
          AND outcome = 'succeeded'
          AND reason = 'initial-administrator-bootstrap'
          AND evidence = '{"permissionCount":11,"permissionRevision":1}'::jsonb
      ) THEN
    RAISE EXCEPTION 'initial administrator audit evidence is missing or contains unexpected data';
  END IF;

  BEGIN
    PERFORM console_identity.claim_initial_administrator(
      v_other, 'initial-administrator-bootstrap-0002'
    );
  EXCEPTION WHEN unique_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed
      OR EXISTS (SELECT 1 FROM console_identity.subject_authority WHERE subject_id = v_other)
      OR (SELECT count(*) FROM console_identity.permission_grant) <> 11
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'second bootstrap claimant mutated authority state';
  END IF;
END;
$$;

ROLLBACK;
