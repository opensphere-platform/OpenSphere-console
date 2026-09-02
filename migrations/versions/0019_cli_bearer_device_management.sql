CREATE OR REPLACE FUNCTION console_identity.list_owned_cli_devices_with_cli_session(
  p_token_digest bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.cli_session;
  v_device console_identity.cli_device;
  v_authority console_identity.subject_authority;
  v_items jsonb;
BEGIN
  IF octet_length(COALESCE(p_token_digest, ''::bytea)) <> 32 THEN
    RAISE EXCEPTION 'CLI session token is invalid'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_session FROM console_identity.cli_session
   WHERE token_digest = p_token_digest FOR UPDATE;
  SELECT * INTO v_device FROM console_identity.cli_device
   WHERE device_id = v_session.device_id;
  SELECT * INTO v_authority FROM console_identity.subject_authority
   WHERE subject_id = v_session.subject_id;
  IF v_session.session_id IS NULL OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_device.device_id IS NULL OR v_device.status <> 'active'
      OR v_authority.subject_id IS NULL
      OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'CLI session is inactive or stale'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', d.device_id, 'label', d.label, 'fingerprint', d.fingerprint,
    'status', d.status, 'createdAt', d.created_at, 'lastUsedAt', d.last_used_at,
    'revokedAt', d.revoked_at, 'lastSessionExpiresAt', s.last_session_expires_at,
    'user', d.subject_id
  ) ORDER BY d.created_at DESC), '[]'::jsonb) INTO v_items
  FROM console_identity.cli_device d
  LEFT JOIN LATERAL (
    SELECT max(expires_at) AS last_session_expires_at
    FROM console_identity.cli_session cs WHERE cs.device_id = d.device_id
  ) s ON true
  WHERE d.subject_id = v_session.subject_id;
  RETURN jsonb_build_object('devices', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.revoke_owned_cli_device_with_cli_session(
  p_token_digest bytea,
  p_device_id uuid,
  p_reason text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_session console_identity.cli_session;
  v_source_device console_identity.cli_device;
  v_authority console_identity.subject_authority;
  v_target_device console_identity.cli_device;
  v_revoked integer := 0;
  v_event console_audit.event;
BEGIN
  IF octet_length(COALESCE(p_token_digest, ''::bytea)) <> 32
      OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 500 OR p_reason ~ '[\r\n]'
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'CLI device revocation is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.cli_session
   WHERE token_digest = p_token_digest FOR UPDATE;
  SELECT * INTO v_source_device FROM console_identity.cli_device
   WHERE device_id = v_session.device_id FOR UPDATE;
  SELECT * INTO v_authority FROM console_identity.subject_authority
   WHERE subject_id = v_session.subject_id FOR UPDATE;
  IF v_session.session_id IS NULL OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_source_device.device_id IS NULL OR v_source_device.status <> 'active'
      OR v_authority.subject_id IS NULL
      OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'CLI session is inactive or stale'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_target_device FROM console_identity.cli_device
   WHERE device_id = p_device_id AND subject_id = v_session.subject_id
     AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active CLI device was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  UPDATE console_identity.cli_device
     SET status = 'revoked', revoked_at = statement_timestamp(), revoke_reason = btrim(p_reason)
   WHERE device_id = v_target_device.device_id;
  UPDATE console_identity.cli_session
     SET revoked_at = statement_timestamp(), revoke_reason = 'device-revoked'
   WHERE device_id = v_target_device.device_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, v_session.subject_id::text, 'console.identity.cli.device.revoked',
    'cli-device:' || v_target_device.device_id::text, 'succeeded', btrim(p_reason),
    jsonb_build_object('revokedSessionCount', v_revoked, 'sourceCredential', 'cli-device')
  );
  RETURN jsonb_build_object('deviceId', v_target_device.device_id,
    'revokedSessionCount', v_revoked, 'auditEventId', v_event.event_id);
END;
$$;

REVOKE ALL ON FUNCTION console_identity.list_owned_cli_devices_with_cli_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.revoke_owned_cli_device_with_cli_session(bytea, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.list_owned_cli_devices_with_cli_session(bytea) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.revoke_owned_cli_device_with_cli_session(bytea, uuid, text, text) TO console_api;

COMMENT ON FUNCTION console_identity.list_owned_cli_devices_with_cli_session(bytea)
  IS 'Lists the current subject CLI devices after validating a digest-only CLI bearer session.';
COMMENT ON FUNCTION console_identity.revoke_owned_cli_device_with_cli_session(bytea, uuid, text, text)
  IS 'Revokes an owned CLI device and all of its sessions using a current CLI bearer session.';
