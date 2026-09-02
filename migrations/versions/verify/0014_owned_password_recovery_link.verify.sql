\set ON_ERROR_STOP on

DO $$
DECLARE
  v_subject uuid := '11111111-1111-4111-8111-111111111111';
  v_session jsonb;
  v_prepared jsonb;
  v_duplicate jsonb;
  v_before_events bigint;
  v_digest text := 'sha256:' || encode(sha256(convert_to('password-recovery-key-0001', 'UTF8')), 'hex');
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.prepare_owned_password_recovery_link(bytea,bytea,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'owned password recovery link preparation function is missing';
  END IF;
  IF has_function_privilege('public', 'console_identity.prepare_owned_password_recovery_link(bytea,bytea,text,text,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.prepare_owned_password_recovery_link(bytea,bytea,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'owned password recovery link grants are not closed to console_api';
  END IF;

  v_session := console_identity.issue_browser_session(
    v_subject,
    sha256(convert_to('password-recovery-handle', 'UTF8')),
    sha256(convert_to('password-recovery-csrf', 'UTF8')),
    'v1.UEFTU1dPUkRSRUNPVkVSWUFDQ0VTUw.UEFTU1dPUkRSRUNPVkVSWUFDQ0VTUw.UEFTU1dPUkRSRUNPVkVSWUFDQ0VTUw',
    'v1.UEFTU1dPUkRSRUNPVkVSWVJFRlJFU0g.UEFTU1dPUkRSRUNPVkVSWVJFRlJFU0g.UEFTU1dPUkRSRUNPVkVSWVJFRlJFU0g',
    'auth-password-recovery-link', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false,
    'password-recovery-issue-0001'
  );

  SELECT count(*) INTO v_before_events FROM console_audit.event;
  v_prepared := console_identity.prepare_owned_password_recovery_link(
    sha256(convert_to('password-recovery-handle', 'UTF8')),
    sha256(convert_to('password-recovery-csrf', 'UTF8')),
    'password-recovery-key-0001',
    'password-recovery-correlation-0001',
    'self-service password change'
  );
  IF v_prepared->>'state' <> 'prepared'
      OR (v_prepared->>'sessionId')::uuid <> (v_session->>'sessionId')::uuid
      OR (v_prepared->>'subjectId')::uuid <> v_subject
      OR v_prepared->>'accessTokenCiphertext' NOT LIKE 'v1.%'
      OR (v_prepared->>'auditEventId') IS NULL
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'owned password recovery link context or intent is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE event_id = (v_prepared->>'auditEventId')::uuid
      AND actor_ref = v_subject::text
      AND action = 'console.identity.password.recovery_link.request'
      AND target_ref = 'subject:' || v_subject::text || ':password-recovery-link'
      AND outcome = 'accepted'
      AND reason = 'self-service password change'
      AND evidence = jsonb_build_object(
        'sessionId', (v_session->>'sessionId')::uuid,
        'idempotencyDigest', v_digest,
        'permissionRevision', 7,
        'revokeEpoch', 2
      )
  ) THEN
    RAISE EXCEPTION 'owned password recovery link intent evidence is incomplete or contains unexpected data';
  END IF;
  IF EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE event_id = (v_prepared->>'auditEventId')::uuid
      AND evidence::text LIKE '%password-recovery-key-0001%'
  ) THEN
    RAISE EXCEPTION 'raw password recovery link idempotency key reached the audit ledger';
  END IF;

  v_duplicate := console_identity.prepare_owned_password_recovery_link(
    sha256(convert_to('password-recovery-handle', 'UTF8')),
    sha256(convert_to('password-recovery-csrf', 'UTF8')),
    'password-recovery-key-0001',
    'password-recovery-correlation-0002',
    'self-service password change'
  );
  IF v_duplicate <> jsonb_build_object('state', 'duplicate', 'subjectId', v_subject)
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'duplicate password recovery link request was not closed without a second intent';
  END IF;

  BEGIN
    PERFORM console_identity.prepare_owned_password_recovery_link(
      sha256(convert_to('password-recovery-handle', 'UTF8')),
      sha256(convert_to('wrong-password-recovery-csrf', 'UTF8')),
      'password-recovery-key-0002',
      'password-recovery-correlation-0003',
      'self-service password change'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'invalid CSRF proof appended a password recovery link intent';
  END IF;

  v_failed := false;
  BEGIN
    PERFORM console_identity.prepare_owned_password_recovery_link(
      sha256(convert_to('password-recovery-handle', 'UTF8')),
      sha256(convert_to('password-recovery-csrf', 'UTF8')),
      'password-recovery-key-0003',
      'password-recovery-correlation-0004',
      'short'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'invalid password recovery reason appended an intent';
  END IF;
END;
$$;
