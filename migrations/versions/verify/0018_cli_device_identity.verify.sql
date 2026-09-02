\set ON_ERROR_STOP on

DO $$
DECLARE
  v_subject uuid := '88888888-8888-4888-8888-888888888888';
  v_browser jsonb;
  v_enrollment jsonb;
  v_projection jsonb;
  v_approval jsonb;
  v_challenge jsonb;
  v_session jsonb;
  v_resolved jsonb;
  v_devices jsonb;
  v_revoked jsonb;
  v_enrollment_id uuid;
  v_device_id uuid;
  v_challenge_id uuid;
  v_fingerprint text := array_to_string(array_fill('aa'::text, ARRAY[32]), ':');
  v_jwk jsonb := jsonb_build_object(
    'kty', 'EC', 'crv', 'P-256', 'x', repeat('A', 43), 'y', repeat('B', 43)
  );
  v_user_digest bytea := sha256(convert_to('CLI2-A1B2-CODE', 'UTF8'));
  v_poll_digest bytea := sha256(convert_to('cli-poll-secret-0018', 'UTF8'));
  v_nonce_digest bytea := sha256(convert_to('cli-challenge-nonce-0018', 'UTF8'));
  v_token_digest bytea := sha256(convert_to('cli-session-token-0018', 'UTF8'));
  v_failed boolean := false;
BEGIN
  IF to_regclass('console_identity.cli_device') IS NULL
      OR to_regclass('console_identity.cli_enrollment') IS NULL
      OR to_regclass('console_identity.cli_challenge') IS NULL
      OR to_regclass('console_identity.cli_session') IS NULL THEN
    RAISE EXCEPTION 'CLI identity tables are missing';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'console_identity.cli_device'::regclass)
      OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'console_identity.cli_enrollment'::regclass)
      OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'console_identity.cli_challenge'::regclass)
      OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'console_identity.cli_session'::regclass) THEN
    RAISE EXCEPTION 'CLI identity tables do not force RLS';
  END IF;
  IF has_table_privilege('console_api', 'console_identity.cli_device', 'SELECT')
      OR has_table_privilege('console_api', 'console_identity.cli_enrollment', 'INSERT')
      OR has_table_privilege('console_api', 'console_identity.cli_challenge', 'UPDATE')
      OR has_table_privilege('console_api', 'console_identity.cli_session', 'DELETE') THEN
    RAISE EXCEPTION 'console_api has direct CLI identity table access';
  END IF;
  IF NOT has_function_privilege('console_api', 'console_identity.create_cli_device_enrollment(text,jsonb,text,bytea,bytea,timestamptz)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.approve_cli_device_enrollment(uuid,uuid,bigint,bigint,uuid,bytea,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.complete_cli_device_session(uuid,uuid,bytea,bytea,timestamptz,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.resolve_cli_session(bytea)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.resolve_cli_session(bytea)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CLI identity function grants are invalid';
  END IF;

  INSERT INTO auth.users(id) VALUES (v_subject) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
    VALUES (v_subject, '89898989-8989-4989-8989-898989898989', 1, 0)
    ON CONFLICT (subject_id) DO NOTHING;
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    VALUES
      (v_subject, 'console.audit.read', 1, v_subject),
      (v_subject, 'console.operation.read', 1, v_subject)
    ON CONFLICT DO NOTHING;
  v_browser := console_identity.issue_browser_session(
    v_subject,
    sha256(convert_to('cli-browser-handle-0018', 'UTF8')),
    sha256(convert_to('cli-browser-csrf-0018', 'UTF8')),
    'v1.Q0xJQlJPV1NFUkFDQ0VTUw.Q0xJQlJPV1NFUkFDQ0VTUw.Q0xJQlJPV1NFUkFDQ0VTUw',
    'v1.Q0xJQlJPV1NFUlJFRlJFU0g.Q0xJQlJPV1NFUlJFRlJFU0g.Q0xJQlJPV1NFUlJFRlJFU0g',
    'auth-cli-browser-0018', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false, 'cli-browser-issue-0018'
  );
  UPDATE console_identity.browser_session SET last_reauthenticated_at = statement_timestamp() - interval '6 minutes'
   WHERE session_id = (v_browser->>'sessionId')::uuid;

  v_enrollment := console_identity.create_cli_device_enrollment(
    'operator-laptop', v_jwk, v_fingerprint, v_user_digest, v_poll_digest,
    statement_timestamp() + interval '5 minutes'
  );
  v_enrollment_id := (v_enrollment->>'enrollmentId')::uuid;
  v_projection := console_identity.get_cli_device_enrollment(
    (v_browser->>'sessionId')::uuid, v_subject, 1, 0, v_enrollment_id, v_user_digest
  );
  IF v_projection->>'label' <> 'operator-laptop'
      OR v_projection ? 'publicJwk' OR v_projection ? 'userCodeDigest' OR v_projection ? 'pollTokenDigest' THEN
    RAISE EXCEPTION 'CLI enrollment projection is invalid: %', v_projection;
  END IF;
  v_projection := console_identity.poll_cli_device_enrollment(v_enrollment_id, v_poll_digest);
  IF v_projection->>'status' <> 'pending' THEN
    RAISE EXCEPTION 'CLI enrollment does not start pending: %', v_projection;
  END IF;

  BEGIN
    PERFORM console_identity.approve_cli_device_enrollment(
      (v_browser->>'sessionId')::uuid, v_subject, 1, 0, v_enrollment_id,
      v_user_digest, 'cli-enrollment-approve-0018'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed OR EXISTS (
    SELECT 1 FROM console_identity.cli_device WHERE subject_id = v_subject
  ) THEN
    RAISE EXCEPTION 'stale AAL2 CLI approval was not rejected before device creation';
  END IF;
  UPDATE console_identity.browser_session SET last_reauthenticated_at = statement_timestamp()
   WHERE session_id = (v_browser->>'sessionId')::uuid;
  v_approval := console_identity.approve_cli_device_enrollment(
    (v_browser->>'sessionId')::uuid, v_subject, 1, 0, v_enrollment_id,
    v_user_digest, 'cli-enrollment-approve-0018'
  );
  v_device_id := (v_approval->>'deviceId')::uuid;
  IF v_device_id IS NULL OR (v_approval->>'replayed')::boolean THEN
    RAISE EXCEPTION 'CLI enrollment approval is invalid: %', v_approval;
  END IF;
  v_approval := console_identity.approve_cli_device_enrollment(
    (v_browser->>'sessionId')::uuid, v_subject, 1, 0, v_enrollment_id,
    v_user_digest, 'cli-enrollment-approve-replay-0018'
  );
  IF (v_approval->>'deviceId')::uuid <> v_device_id
      OR NOT (v_approval->>'replayed')::boolean
      OR (SELECT count(*) FROM console_identity.cli_device WHERE subject_id = v_subject) <> 1 THEN
    RAISE EXCEPTION 'CLI enrollment replay created another device: %', v_approval;
  END IF;
  v_projection := console_identity.poll_cli_device_enrollment(v_enrollment_id, v_poll_digest);
  IF v_projection->>'status' <> 'approved' OR (v_projection->>'deviceId')::uuid <> v_device_id THEN
    RAISE EXCEPTION 'approved CLI enrollment cannot be polled: %', v_projection;
  END IF;

  v_challenge := console_identity.create_cli_device_challenge(
    v_device_id, v_nonce_digest, statement_timestamp() + interval '1 minute'
  );
  v_challenge_id := (v_challenge->>'challengeId')::uuid;
  v_projection := console_identity.get_cli_device_challenge(v_device_id, v_challenge_id, v_nonce_digest);
  IF v_projection->'publicJwk' <> v_jwk OR v_projection->>'subjectId' <> v_subject::text THEN
    RAISE EXCEPTION 'CLI challenge verification projection is invalid: %', v_projection;
  END IF;
  v_session := console_identity.complete_cli_device_session(
    v_device_id, v_challenge_id, v_nonce_digest, v_token_digest,
    statement_timestamp() + interval '15 minutes', 'cli-session-complete-0018'
  );
  v_resolved := console_identity.resolve_cli_session(v_token_digest);
  IF v_resolved->>'sessionId' <> v_session->>'sessionId'
      OR v_resolved->>'subjectId' <> v_subject::text
      OR v_resolved->>'deviceId' <> v_device_id::text
      OR v_resolved->>'credentialType' <> 'cli-device'
      OR v_resolved->>'aal' <> 'aal1'
      OR NOT (v_resolved->'permissions' @> '["console.operation.read"]'::jsonb)
      OR v_resolved ? 'tokenDigest' OR v_resolved ? 'publicJwk' THEN
    RAISE EXCEPTION 'CLI session projection is invalid: %', v_resolved;
  END IF;
  v_failed := false;
  BEGIN
    PERFORM console_identity.complete_cli_device_session(
      v_device_id, v_challenge_id, v_nonce_digest,
      sha256(convert_to('second-cli-token-0018', 'UTF8')),
      statement_timestamp() + interval '15 minutes', 'cli-session-replay-0018'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_identity.cli_session WHERE device_id = v_device_id) <> 1 THEN
    RAISE EXCEPTION 'one-time CLI challenge was replayable';
  END IF;

  v_devices := console_identity.list_owned_cli_devices(
    (v_browser->>'sessionId')::uuid, v_subject, 1, 0
  );
  IF jsonb_array_length(v_devices->'devices') <> 1
      OR v_devices::text ~* 'public.jwk|token.digest|nonce|poll.token|user.code' THEN
    RAISE EXCEPTION 'CLI device inventory leaks credential material: %', v_devices;
  END IF;
  v_revoked := console_identity.revoke_owned_cli_device(
    (v_browser->>'sessionId')::uuid, v_subject, 1, 0, v_device_id,
    'operator revoked lost CLI device', 'cli-device-revoke-0018'
  );
  IF (v_revoked->>'revokedSessionCount')::integer <> 1 THEN
    RAISE EXCEPTION 'CLI device revocation did not revoke its session: %', v_revoked;
  END IF;
  v_failed := false;
  BEGIN
    PERFORM console_identity.resolve_cli_session(v_token_digest);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'revoked CLI device session remained usable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM console_audit.event
     WHERE action LIKE 'console.identity.cli.%'
       AND (evidence::text ~* 'cli-poll-secret|CLI2-A1B2-CODE|cli-session-token|publicJwk'
         OR actor_ref <> v_subject::text)
  ) THEN
    RAISE EXCEPTION 'CLI audit contains credential material or wrong actor';
  END IF;
END;
$$;
