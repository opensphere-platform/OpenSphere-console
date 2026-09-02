\set ON_ERROR_STOP on

DO $$
DECLARE
  v_subject uuid := '99999999-9999-4999-8999-999999999999';
  v_device_one uuid;
  v_device_two uuid;
  v_token_digest bytea := sha256(convert_to('cli-bearer-management-0019', 'UTF8'));
  v_devices jsonb;
  v_revoked jsonb;
  v_failed boolean := false;
  v_jwk_one jsonb := jsonb_build_object('kty', 'EC', 'crv', 'P-256', 'x', repeat('C', 43), 'y', repeat('D', 43));
  v_jwk_two jsonb := jsonb_build_object('kty', 'EC', 'crv', 'P-256', 'x', repeat('E', 43), 'y', repeat('F', 43));
BEGIN
  IF NOT has_function_privilege('console_api', 'console_identity.list_owned_cli_devices_with_cli_session(bytea)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.revoke_owned_cli_device_with_cli_session(bytea,uuid,text,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.list_owned_cli_devices_with_cli_session(bytea)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.revoke_owned_cli_device_with_cli_session(bytea,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CLI bearer device management grants are invalid';
  END IF;

  INSERT INTO auth.users(id) VALUES (v_subject) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
    VALUES (v_subject, '99999999-9999-4999-9999-999999999998', 4, 2)
    ON CONFLICT (subject_id) DO UPDATE SET permission_revision = 4, revoke_epoch = 2;
  INSERT INTO console_identity.cli_device(subject_id, label, public_jwk, fingerprint)
    VALUES (v_subject, 'source-cli', v_jwk_one, array_to_string(array_fill('cc'::text, ARRAY[32]), ':'))
    RETURNING device_id INTO v_device_one;
  INSERT INTO console_identity.cli_device(subject_id, label, public_jwk, fingerprint)
    VALUES (v_subject, 'target-cli', v_jwk_two, array_to_string(array_fill('dd'::text, ARRAY[32]), ':'))
    RETURNING device_id INTO v_device_two;
  INSERT INTO console_identity.cli_session(
    subject_id, device_id, token_digest, permission_revision, revoke_epoch, expires_at
  ) VALUES (v_subject, v_device_one, v_token_digest, 4, 2, statement_timestamp() + interval '15 minutes');
  INSERT INTO console_identity.cli_session(
    subject_id, device_id, token_digest, permission_revision, revoke_epoch, expires_at
  ) VALUES (v_subject, v_device_two, sha256(convert_to('target-cli-session-0019', 'UTF8')), 4, 2,
    statement_timestamp() + interval '15 minutes');

  v_devices := console_identity.list_owned_cli_devices_with_cli_session(v_token_digest);
  IF jsonb_array_length(v_devices->'devices') <> 2
      OR v_devices::text ~* 'public.jwk|token.digest|nonce|poll.token|user.code' THEN
    RAISE EXCEPTION 'CLI bearer inventory is invalid: %', v_devices;
  END IF;
  v_revoked := console_identity.revoke_owned_cli_device_with_cli_session(
    v_token_digest, v_device_two, 'operator revoked second CLI device', 'cli-bearer-revoke-0019'
  );
  IF (v_revoked->>'deviceId')::uuid <> v_device_two
      OR (v_revoked->>'revokedSessionCount')::integer <> 1
      OR NOT EXISTS (
        SELECT 1 FROM console_identity.cli_device
         WHERE device_id = v_device_two AND status = 'revoked'
      ) THEN
    RAISE EXCEPTION 'CLI bearer revocation is invalid: %', v_revoked;
  END IF;
  IF jsonb_array_length((console_identity.list_owned_cli_devices_with_cli_session(v_token_digest))->'devices') <> 2 THEN
    RAISE EXCEPTION 'source CLI session was incorrectly revoked';
  END IF;

  UPDATE console_identity.subject_authority SET permission_revision = 5 WHERE subject_id = v_subject;
  BEGIN
    PERFORM console_identity.list_owned_cli_devices_with_cli_session(v_token_digest);
  EXCEPTION WHEN invalid_authorization_specification THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'stale CLI bearer remained usable for device management';
  END IF;
END;
$$;
