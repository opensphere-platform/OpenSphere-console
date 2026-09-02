CREATE OR REPLACE FUNCTION console_identity.prepare_managed_identity_lifecycle(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_target_subject_id uuid,
  p_action text,
  p_request_digest text,
  p_idempotency_key text,
  p_roles text[],
  p_enabled boolean,
  p_reason text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_actor console_identity.subject_authority;
  v_target console_identity.subject_authority;
  v_roles text[];
  v_idempotency_digest text;
  v_target_ref text;
  v_existing console_audit.event;
  v_event console_audit.event;
  v_self_profile boolean;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT role_name ORDER BY role_name), ARRAY[]::text[])
    INTO v_roles FROM unnest(COALESCE(p_roles, ARRAY[]::text[])) AS role_name;
  IF p_session_id IS NULL OR p_actor_ref IS NULL
      OR p_expected_permission_revision IS NULL OR p_expected_permission_revision < 0
      OR p_expected_revoke_epoch IS NULL OR p_expected_revoke_epoch < 0
      OR p_action IS NULL
      OR p_action NOT IN ('identity.create', 'profile.update', 'enabled.change', 'onboarding.link', 'mfa.reset')
      OR p_request_digest IS NULL OR p_request_digest !~ '^sha256:[a-f0-9]{64}$'
      OR length(COALESCE(p_idempotency_key, '')) NOT BETWEEN 8 AND 256
      OR p_idempotency_key ~ '[\r\n]'
      OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 500
      OR p_reason ~ '[\r\n]'
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]'
      OR (p_action = 'identity.create') <> (p_target_subject_id IS NULL)
      OR (p_action = 'enabled.change') <> (p_enabled IS NOT NULL)
      OR (p_action = 'identity.create' AND cardinality(v_roles) <> cardinality(COALESCE(p_roles, ARRAY[]::text[])))
      OR (p_action <> 'identity.create' AND cardinality(v_roles) <> 0)
      OR EXISTS (SELECT 1 FROM unnest(v_roles) role_name
                  WHERE role_name NOT IN ('console-admins', 'console-operators', 'console-viewers')) THEN
    RAISE EXCEPTION 'managed identity lifecycle request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  -- All managed identity lifecycle changes share the role-policy lock. Acquire
  -- it before row locks so role, disable and create continuity checks cannot
  -- form a cross-subject lock cycle.
  PERFORM pg_advisory_xact_lock(471920260903);
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_session.absolute_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_actor FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref FOR UPDATE;
  IF NOT FOUND OR v_actor.permission_revision <> v_session.permission_revision
      OR v_actor.permission_revision <> p_expected_permission_revision
      OR v_actor.revoke_epoch <> v_session.revoke_epoch
      OR v_actor.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  v_self_profile := p_action = 'profile.update' AND p_target_subject_id = p_actor_ref;
  IF NOT v_self_profile AND (
    v_session.aal <> 'aal2' OR v_session.last_reauthenticated_at IS NULL
      OR v_session.last_reauthenticated_at < statement_timestamp() - interval '5 minutes'
      OR v_session.last_reauthenticated_at > statement_timestamp() + interval '30 seconds'
  ) THEN
    RAISE EXCEPTION 'recent aal2 is required'
      USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;
  IF NOT v_self_profile AND NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
     WHERE subject_id = p_actor_ref AND permission = 'console.identity.manage'
       AND grant_revision <= v_actor.permission_revision AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'identity management permission is required'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  IF p_action <> 'identity.create' THEN
    SELECT * INTO v_target FROM console_identity.subject_authority
      WHERE subject_id = p_target_subject_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'managed identity was not found'
        USING ERRCODE = 'P0002', DETAIL = 'NotFound';
    END IF;
  END IF;
  IF p_action IN ('onboarding.link', 'mfa.reset') AND p_target_subject_id = p_actor_ref THEN
    RAISE EXCEPTION 'a separate administrator is required for this identity action'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF p_action = 'enabled.change' AND p_enabled = false AND EXISTS (
    SELECT 1 FROM console_identity.permission_grant
     WHERE subject_id = p_target_subject_id AND permission = 'console.role.admin'
       AND grant_revision <= v_target.permission_revision AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'an administrator must be demoted before the account is disabled'
      USING ERRCODE = '23514', DETAIL = 'RoleContinuityRequired';
  END IF;

  v_idempotency_digest := 'sha256:' || encode(sha256(convert_to(p_idempotency_key, 'UTF8')), 'hex');
  v_target_ref := CASE WHEN p_action = 'identity.create'
    THEN 'managed-identity:new' ELSE 'subject:' || p_target_subject_id::text END;
  SELECT * INTO v_existing FROM console_audit.event
   WHERE actor_ref = p_actor_ref::text
     AND action = 'console.identity.lifecycle.' || replace(p_action, '.', '_') || '.accepted'
     AND evidence->>'idempotencyDigest' = v_idempotency_digest
   ORDER BY sequence_id DESC LIMIT 1;
  IF FOUND THEN
    IF v_existing.evidence->>'requestDigest' <> p_request_digest THEN
      RAISE EXCEPTION 'idempotency key belongs to a different managed identity request'
        USING ERRCODE = '23505', DETAIL = 'IdempotencyMismatch';
    END IF;
    RAISE EXCEPTION 'managed identity response material is not replayable'
      USING ERRCODE = '23505', DETAIL = 'IdempotencyReplayUnavailable';
  END IF;

  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, p_actor_ref::text,
    'console.identity.lifecycle.' || replace(p_action, '.', '_') || '.accepted',
    v_target_ref, 'accepted', btrim(p_reason),
    jsonb_strip_nulls(jsonb_build_object(
      'action', p_action,
      'requestDigest', p_request_digest,
      'idempotencyDigest', v_idempotency_digest,
      'roles', CASE WHEN p_action = 'identity.create' THEN to_jsonb(v_roles) ELSE NULL END,
      'enabled', CASE WHEN p_action = 'enabled.change' THEN p_enabled ELSE NULL END,
      'actorPermissionRevision', v_actor.permission_revision,
      'actorRevokeEpoch', v_actor.revoke_epoch
    ))
  );
  RETURN jsonb_build_object(
    'acceptedEventId', v_event.event_id,
    'actorSubjectId', p_actor_ref,
    'targetSubjectId', p_target_subject_id,
    'selfProfile', v_self_profile,
    'requestDigest', p_request_digest
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.complete_managed_identity_lifecycle(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_target_subject_id uuid,
  p_action text,
  p_request_digest text,
  p_idempotency_key text,
  p_roles text[],
  p_enabled boolean,
  p_revoke_sessions boolean,
  p_effect_count integer,
  p_reason text,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_actor console_identity.subject_authority;
  v_target console_identity.subject_authority;
  v_roles text[];
  v_permissions text[];
  v_idempotency_digest text;
  v_target_ref text;
  v_accepted console_audit.event;
  v_event console_audit.event;
  v_self_profile boolean;
  v_revoked_sessions integer := 0;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT role_name ORDER BY role_name), ARRAY[]::text[])
    INTO v_roles FROM unnest(COALESCE(p_roles, ARRAY[]::text[])) AS role_name;
  IF p_session_id IS NULL OR p_actor_ref IS NULL OR p_target_subject_id IS NULL
      OR p_expected_permission_revision IS NULL OR p_expected_permission_revision < 0
      OR p_expected_revoke_epoch IS NULL OR p_expected_revoke_epoch < 0
      OR p_action IS NULL
      OR p_action NOT IN ('identity.create', 'profile.update', 'enabled.change', 'onboarding.link', 'mfa.reset')
      OR p_request_digest IS NULL OR p_request_digest !~ '^sha256:[a-f0-9]{64}$'
      OR length(COALESCE(p_idempotency_key, '')) NOT BETWEEN 8 AND 256
      OR p_idempotency_key ~ '[\r\n]'
      OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 500
      OR p_reason ~ '[\r\n]'
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]'
      OR (p_action = 'enabled.change') <> (p_enabled IS NOT NULL)
      OR (p_action = 'identity.create' AND cardinality(v_roles) <> cardinality(COALESCE(p_roles, ARRAY[]::text[])))
      OR (p_action <> 'identity.create' AND cardinality(v_roles) <> 0)
      OR EXISTS (SELECT 1 FROM unnest(v_roles) role_name
                  WHERE role_name NOT IN ('console-admins', 'console-operators', 'console-viewers'))
      OR p_revoke_sessions IS NULL
      OR p_effect_count IS NULL OR p_effect_count NOT BETWEEN 0 AND 100
      OR (p_action <> 'mfa.reset' AND p_effect_count <> 0)
      OR (p_action IN ('identity.create', 'profile.update', 'onboarding.link') AND p_revoke_sessions)
      OR (p_action IN ('enabled.change', 'mfa.reset') AND NOT p_revoke_sessions) THEN
    RAISE EXCEPTION 'managed identity lifecycle completion is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  PERFORM pg_advisory_xact_lock(471920260903);
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_session.absolute_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_actor FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref FOR UPDATE;
  IF NOT FOUND OR v_actor.permission_revision <> v_session.permission_revision
      OR v_actor.permission_revision <> p_expected_permission_revision
      OR v_actor.revoke_epoch <> v_session.revoke_epoch
      OR v_actor.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  v_self_profile := p_action = 'profile.update' AND p_target_subject_id = p_actor_ref;
  IF NOT v_self_profile AND (
    v_session.aal <> 'aal2' OR v_session.last_reauthenticated_at IS NULL
      OR v_session.last_reauthenticated_at < statement_timestamp() - interval '5 minutes'
      OR v_session.last_reauthenticated_at > statement_timestamp() + interval '30 seconds'
  ) THEN
    RAISE EXCEPTION 'recent aal2 is required'
      USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;
  IF NOT v_self_profile AND NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
     WHERE subject_id = p_actor_ref AND permission = 'console.identity.manage'
       AND grant_revision <= v_actor.permission_revision AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'identity management permission is required'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  v_idempotency_digest := 'sha256:' || encode(sha256(convert_to(p_idempotency_key, 'UTF8')), 'hex');
  v_target_ref := CASE WHEN p_action = 'identity.create'
    THEN 'managed-identity:new' ELSE 'subject:' || p_target_subject_id::text END;
  SELECT * INTO v_accepted FROM console_audit.event
   WHERE actor_ref = p_actor_ref::text
     AND action = 'console.identity.lifecycle.' || replace(p_action, '.', '_') || '.accepted'
     AND target_ref = v_target_ref
     AND evidence->>'idempotencyDigest' = v_idempotency_digest
     AND evidence->>'requestDigest' = p_request_digest
   ORDER BY sequence_id DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'managed identity accepted intent was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;

  IF p_action = 'identity.create' THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_subject_id)
        OR EXISTS (SELECT 1 FROM console_identity.subject_authority WHERE subject_id = p_target_subject_id) THEN
      RAISE EXCEPTION 'created Auth subject is absent or already managed'
        USING ERRCODE = '23505', DETAIL = 'Conflict';
    END IF;
    INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
      VALUES (p_target_subject_id, gen_random_uuid(), 1, 0)
      RETURNING * INTO v_target;
    SELECT COALESCE(array_agg(DISTINCT permission ORDER BY permission), ARRAY[]::text[])
      INTO v_permissions
      FROM unnest(v_roles) role_name
      CROSS JOIN LATERAL unnest(console_identity.managed_role_permissions(role_name)) permission;
    INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
      SELECT p_target_subject_id, permission, 1, p_actor_ref FROM unnest(v_permissions) permission;
  ELSE
    SELECT * INTO v_target FROM console_identity.subject_authority
      WHERE subject_id = p_target_subject_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'managed identity was not found'
        USING ERRCODE = 'P0002', DETAIL = 'NotFound';
    END IF;
    IF p_action IN ('onboarding.link', 'mfa.reset') AND p_target_subject_id = p_actor_ref THEN
      RAISE EXCEPTION 'a separate administrator is required for this identity action'
        USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
    END IF;
    IF p_action = 'enabled.change' AND p_enabled = false AND EXISTS (
      SELECT 1 FROM console_identity.permission_grant
       WHERE subject_id = p_target_subject_id AND permission = 'console.role.admin'
         AND grant_revision <= v_target.permission_revision AND revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'an administrator must be demoted before the account is disabled'
        USING ERRCODE = '23514', DETAIL = 'RoleContinuityRequired';
    END IF;
    IF p_revoke_sessions THEN
      UPDATE console_identity.subject_authority
         SET revoke_epoch = revoke_epoch + 1, updated_at = statement_timestamp()
       WHERE subject_id = p_target_subject_id RETURNING * INTO v_target;
      UPDATE console_identity.browser_session
         SET revoked_at = statement_timestamp(),
             revoke_reason = 'managed-identity-' || replace(p_action, '.', '-')
       WHERE subject_id = p_target_subject_id AND revoked_at IS NULL;
      GET DIAGNOSTICS v_revoked_sessions = ROW_COUNT;
    END IF;
  END IF;

  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, p_actor_ref::text,
    'console.identity.lifecycle.' || replace(p_action, '.', '_') || '.succeeded',
    'subject:' || p_target_subject_id::text, 'succeeded', btrim(p_reason),
    jsonb_strip_nulls(jsonb_build_object(
      'action', p_action,
      'requestDigest', p_request_digest,
      'acceptedEventId', v_accepted.event_id,
      'roles', CASE WHEN p_action = 'identity.create' THEN to_jsonb(v_roles) ELSE NULL END,
      'enabled', CASE WHEN p_action = 'enabled.change' THEN p_enabled ELSE NULL END,
      'effectCount', CASE WHEN p_action = 'mfa.reset' THEN p_effect_count ELSE NULL END,
      'permissionRevision', v_target.permission_revision,
      'revokeEpoch', v_target.revoke_epoch,
      'revokedSessionCount', v_revoked_sessions
    ))
  );
  RETURN jsonb_build_object(
    'targetSubjectId', p_target_subject_id,
    'action', p_action,
    'roles', to_jsonb(v_roles),
    'permissionRevision', v_target.permission_revision,
    'revokeEpoch', v_target.revoke_epoch,
    'revokedSessionCount', v_revoked_sessions,
    'effectCount', p_effect_count,
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.prepare_managed_identity_lifecycle(uuid, uuid, bigint, bigint, uuid, text, text, text, text[], boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.complete_managed_identity_lifecycle(uuid, uuid, bigint, bigint, uuid, text, text, text, text[], boolean, boolean, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.prepare_managed_identity_lifecycle(uuid, uuid, bigint, bigint, uuid, text, text, text, text[], boolean, text, text) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.complete_managed_identity_lifecycle(uuid, uuid, bigint, bigint, uuid, text, text, text, text[], boolean, boolean, integer, text, text) TO console_api;

COMMENT ON FUNCTION console_identity.prepare_managed_identity_lifecycle(uuid, uuid, bigint, bigint, uuid, text, text, text, text[], boolean, text, text)
  IS 'Closed C_API-only preflight for the five current managed identity lifecycle actions; not an extensible workflow engine.';
COMMENT ON FUNCTION console_identity.complete_managed_identity_lifecycle(uuid, uuid, bigint, bigint, uuid, text, text, text, text[], boolean, boolean, integer, text, text)
  IS 'Completes one accepted managed identity Auth action with current authority recheck, optional session revocation and append-only audit.';
