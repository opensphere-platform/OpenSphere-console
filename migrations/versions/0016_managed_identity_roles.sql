CREATE OR REPLACE FUNCTION console_identity.managed_role_permissions(p_role text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE p_role
    WHEN 'console-admins' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.extension.install',
      'console.extension.remove',
      'console.extension.revoke',
      'console.identity.manage',
      'console.operation.approve',
      'console.operation.verify',
      'console.registry.manage',
      'console.role.admin'
    ]::text[]
    WHEN 'console-operators' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.extension.install',
      'console.extension.remove',
      'console.extension.revoke',
      'console.operation.verify',
      'console.registry.manage',
      'console.role.operator'
    ]::text[]
    WHEN 'console-viewers' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.role.viewer'
    ]::text[]
    ELSE ARRAY[]::text[]
  END;
$$;

CREATE OR REPLACE FUNCTION console_identity.managed_role_catalog()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('name', 'console-admins', 'description', 'Console administrators'),
    jsonb_build_object('name', 'console-operators', 'description', 'Console operations without identity administration or approval'),
    jsonb_build_object('name', 'console-viewers', 'description', 'Console data and audit read access')
  );
$$;

DO $$
DECLARE
  v_subject console_identity.subject_authority;
  v_original_admin_permissions constant text[] := ARRAY[
    'console.audit.read',
    'console.data_identity.read',
    'console.extension.install',
    'console.extension.remove',
    'console.extension.revoke',
    'console.operation.approve',
    'console.operation.verify',
    'console.registry.manage'
  ];
  v_next_revision bigint;
BEGIN
  FOR v_subject IN
    SELECT authority.*
      FROM console_identity.subject_authority AS authority
     WHERE NOT EXISTS (
       SELECT 1 FROM console_identity.permission_grant AS marker
        WHERE marker.subject_id = authority.subject_id
          AND marker.permission IN ('console.role.admin', 'console.role.operator', 'console.role.viewer')
          AND marker.revoked_at IS NULL
     )
       AND (
         SELECT count(DISTINCT grant_row.permission)
           FROM console_identity.permission_grant AS grant_row
          WHERE grant_row.subject_id = authority.subject_id
            AND grant_row.permission = ANY(v_original_admin_permissions)
            AND grant_row.grant_revision <= authority.permission_revision
            AND grant_row.revoked_at IS NULL
       ) = cardinality(v_original_admin_permissions)
  LOOP
    v_next_revision := v_subject.permission_revision + 1;
    INSERT INTO console_identity.permission_grant(
      subject_id, permission, grant_revision, granted_by
    ) VALUES
      (v_subject.subject_id, 'console.identity.manage', v_next_revision, v_subject.subject_id),
      (v_subject.subject_id, 'console.role.admin', v_next_revision, v_subject.subject_id);
    UPDATE console_identity.subject_authority
       SET permission_revision = v_next_revision,
           revoke_epoch = revoke_epoch + 1,
           updated_at = statement_timestamp()
     WHERE subject_id = v_subject.subject_id;
    UPDATE console_identity.browser_session
       SET revoked_at = statement_timestamp(),
           revoke_reason = 'managed-role-policy-upgrade'
     WHERE subject_id = v_subject.subject_id AND revoked_at IS NULL;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.list_managed_identities(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_can_manage boolean;
  v_items jsonb;
BEGIN
  IF p_session_id IS NULL OR p_actor_ref IS NULL
      OR p_expected_permission_revision < 0 OR p_expected_revoke_epoch < 0
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'managed identity read request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_session.absolute_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
     WHERE subject_id = p_actor_ref
       AND permission = 'console.identity.manage'
       AND grant_revision <= v_authority.permission_revision
       AND revoked_at IS NULL
  ) INTO v_can_manage;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'subjectId', authority.subject_id,
    'personRef', authority.person_ref,
    'permissionRevision', authority.permission_revision,
    'revokeEpoch', authority.revoke_epoch,
    'roles', COALESCE((
      SELECT jsonb_agg(role_name ORDER BY role_name)
        FROM (
          SELECT CASE grant_row.permission
            WHEN 'console.role.admin' THEN 'console-admins'
            WHEN 'console.role.operator' THEN 'console-operators'
            WHEN 'console.role.viewer' THEN 'console-viewers'
          END AS role_name
            FROM console_identity.permission_grant AS grant_row
           WHERE grant_row.subject_id = authority.subject_id
             AND grant_row.permission IN ('console.role.admin', 'console.role.operator', 'console.role.viewer')
             AND grant_row.grant_revision <= authority.permission_revision
             AND grant_row.revoked_at IS NULL
        ) AS current_roles
       WHERE role_name IS NOT NULL
    ), '[]'::jsonb)
  ) ORDER BY authority.subject_id), '[]'::jsonb)
    INTO v_items
    FROM console_identity.subject_authority AS authority
   WHERE v_can_manage OR authority.subject_id = p_actor_ref;

  IF jsonb_array_length(v_items) > 200 THEN
    RAISE EXCEPTION 'managed identity inventory exceeds the bounded Console view'
      USING ERRCODE = '54000', DETAIL = 'InventoryLimitExceeded';
  END IF;
  RETURN jsonb_build_object(
    'scope', CASE WHEN v_can_manage THEN 'managed' ELSE 'self' END,
    'groups', console_identity.managed_role_catalog(),
    'items', v_items
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.change_managed_identity_role(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_target_subject_id uuid,
  p_operation text,
  p_role text,
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
  v_actor_authority console_identity.subject_authority;
  v_target_authority console_identity.subject_authority;
  v_current_roles text[];
  v_desired_roles text[];
  v_desired_permissions text[];
  v_managed_permissions text[];
  v_next_revision bigint;
  v_revoked_sessions integer;
  v_event console_audit.event;
BEGIN
  IF p_session_id IS NULL OR p_actor_ref IS NULL OR p_target_subject_id IS NULL
      OR p_expected_permission_revision < 0 OR p_expected_revoke_epoch < 0
      OR p_operation NOT IN ('add', 'remove')
      OR p_role NOT IN ('console-admins', 'console-operators', 'console-viewers')
      OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 500
      OR p_reason ~ '[\r\n]'
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'managed identity role request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  -- Serialize before taking any subject/session row lock. This keeps two
  -- administrators changing one another from forming a lock-order cycle.
  PERFORM pg_advisory_xact_lock(471920260903);
  SELECT * INTO v_session FROM console_identity.browser_session
    WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp()
      OR v_session.absolute_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_actor_authority FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref FOR UPDATE;
  IF NOT FOUND OR v_actor_authority.permission_revision <> v_session.permission_revision
      OR v_actor_authority.permission_revision <> p_expected_permission_revision
      OR v_actor_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_actor_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
     WHERE subject_id = p_actor_ref
       AND permission = 'console.identity.manage'
       AND grant_revision <= v_actor_authority.permission_revision
       AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'identity management permission is required'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF v_session.aal <> 'aal2'
      OR v_session.last_reauthenticated_at IS NULL
      OR v_session.last_reauthenticated_at < statement_timestamp() - interval '5 minutes'
      OR v_session.last_reauthenticated_at > statement_timestamp() + interval '30 seconds' THEN
    RAISE EXCEPTION 'recent aal2 is required'
      USING ERRCODE = '42501', DETAIL = 'StepUpRequired';
  END IF;
  IF p_target_subject_id = p_actor_ref THEN
    v_target_authority := v_actor_authority;
  ELSE
    SELECT * INTO v_target_authority FROM console_identity.subject_authority
      WHERE subject_id = p_target_subject_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'managed identity was not found'
        USING ERRCODE = 'P0002', DETAIL = 'NotFound';
    END IF;
  END IF;

  SELECT COALESCE(array_agg(role_name ORDER BY role_name), ARRAY[]::text[])
    INTO v_current_roles
    FROM (
      SELECT CASE permission
        WHEN 'console.role.admin' THEN 'console-admins'
        WHEN 'console.role.operator' THEN 'console-operators'
        WHEN 'console.role.viewer' THEN 'console-viewers'
      END AS role_name
        FROM console_identity.permission_grant
       WHERE subject_id = p_target_subject_id
         AND permission IN ('console.role.admin', 'console.role.operator', 'console.role.viewer')
         AND grant_revision <= v_target_authority.permission_revision
         AND revoked_at IS NULL
    ) AS roles
   WHERE role_name IS NOT NULL;

  IF p_operation = 'add' AND p_role = ANY(v_current_roles)
      OR p_operation = 'remove' AND NOT p_role = ANY(v_current_roles) THEN
    RETURN jsonb_build_object(
      'targetSubjectId', p_target_subject_id,
      'roles', to_jsonb(v_current_roles),
      'permissionRevision', v_target_authority.permission_revision,
      'revokeEpoch', v_target_authority.revoke_epoch,
      'revokedSessionCount', 0,
      'replayed', true
    );
  END IF;
  IF p_operation = 'remove' AND p_role = 'console-admins' AND p_target_subject_id = p_actor_ref THEN
    RAISE EXCEPTION 'administrator self-removal is blocked'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF p_operation = 'remove' AND p_role = 'console-admins' AND (
    SELECT count(DISTINCT subject_id)
      FROM console_identity.permission_grant
     WHERE permission = 'console.role.admin' AND revoked_at IS NULL
  ) <= 1 THEN
    RAISE EXCEPTION 'last Console administrator cannot be removed'
      USING ERRCODE = '23514', DETAIL = 'RoleContinuityRequired';
  END IF;

  SELECT COALESCE(array_agg(role_name ORDER BY role_name), ARRAY[]::text[])
    INTO v_desired_roles
    FROM (
      SELECT DISTINCT role_name
        FROM unnest(v_current_roles || CASE WHEN p_operation = 'add' THEN ARRAY[p_role] ELSE ARRAY[]::text[] END) AS role_name
       WHERE NOT (p_operation = 'remove' AND role_name = p_role)
    ) AS desired;
  SELECT COALESCE(array_agg(DISTINCT permission ORDER BY permission), ARRAY[]::text[])
    INTO v_desired_permissions
    FROM unnest(v_desired_roles) AS role_name
    CROSS JOIN LATERAL unnest(console_identity.managed_role_permissions(role_name)) AS permission;
  SELECT array_agg(DISTINCT permission ORDER BY permission)
    INTO v_managed_permissions
    FROM unnest(ARRAY['console-admins', 'console-operators', 'console-viewers']) AS role_name
    CROSS JOIN LATERAL unnest(console_identity.managed_role_permissions(role_name)) AS permission;

  v_next_revision := v_target_authority.permission_revision + 1;
  UPDATE console_identity.permission_grant
     SET revoked_at = statement_timestamp()
   WHERE subject_id = p_target_subject_id
     AND permission = ANY(v_managed_permissions)
     AND revoked_at IS NULL;
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    SELECT p_target_subject_id, permission, v_next_revision, p_actor_ref
      FROM unnest(v_desired_permissions) AS permission;
  UPDATE console_identity.subject_authority
     SET permission_revision = v_next_revision,
         revoke_epoch = revoke_epoch + 1,
         updated_at = statement_timestamp()
   WHERE subject_id = p_target_subject_id
   RETURNING * INTO v_target_authority;
  UPDATE console_identity.browser_session
     SET revoked_at = statement_timestamp(), revoke_reason = 'managed-role-changed'
   WHERE subject_id = p_target_subject_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked_sessions = ROW_COUNT;
  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, p_actor_ref::text,
    'console.identity.role.' || p_operation,
    'subject:' || p_target_subject_id::text || ':role:' || p_role,
    'succeeded', btrim(p_reason),
    jsonb_build_object(
      'targetSubjectId', p_target_subject_id,
      'role', p_role,
      'operation', p_operation,
      'roles', to_jsonb(v_desired_roles),
      'permissionRevision', v_target_authority.permission_revision,
      'revokeEpoch', v_target_authority.revoke_epoch,
      'revokedSessionCount', v_revoked_sessions
    )
  );
  RETURN jsonb_build_object(
    'targetSubjectId', p_target_subject_id,
    'roles', to_jsonb(v_desired_roles),
    'permissionRevision', v_target_authority.permission_revision,
    'revokeEpoch', v_target_authority.revoke_epoch,
    'revokedSessionCount', v_revoked_sessions,
    'auditEventId', v_event.event_id,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.claim_initial_administrator(
  p_subject_id uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_permissions constant text[] := console_identity.managed_role_permissions('console-admins');
  v_event console_audit.event;
BEGIN
  IF p_subject_id IS NULL
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'initial administrator bootstrap request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  PERFORM pg_advisory_xact_lock(471920260902);
  IF EXISTS (SELECT 1 FROM console_identity.subject_authority) THEN
    RAISE EXCEPTION 'initial administrator already exists'
      USING ERRCODE = '23505', DETAIL = 'BootstrapComplete';
  END IF;
  INSERT INTO console_identity.subject_authority(
    subject_id, person_ref, permission_revision, revoke_epoch
  ) VALUES (p_subject_id, gen_random_uuid(), 1, 0);
  INSERT INTO console_identity.permission_grant(
    subject_id, permission, grant_revision, granted_by
  ) SELECT p_subject_id, permission, 1, p_subject_id FROM unnest(v_permissions) AS permission;
  v_event := console_audit.append_event_internal(
    NULL, p_correlation_id, p_subject_id::text,
    'console.identity.bootstrap.initial_administrator',
    'subject:' || p_subject_id::text, 'succeeded',
    'initial-administrator-bootstrap',
    jsonb_build_object('permissionRevision', 1, 'permissionCount', cardinality(v_permissions))
  );
  RETURN jsonb_build_object(
    'state', 'complete', 'subjectId', p_subject_id,
    'permissionRevision', 1, 'permissionCount', cardinality(v_permissions),
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.managed_role_permissions(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.managed_role_catalog() FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.list_managed_identities(uuid, uuid, bigint, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.change_managed_identity_role(uuid, uuid, bigint, bigint, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.claim_initial_administrator(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.list_managed_identities(uuid, uuid, bigint, bigint, text) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.change_managed_identity_role(uuid, uuid, bigint, bigint, uuid, text, text, text, text) TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.claim_initial_administrator(uuid, text) TO console_api;

COMMENT ON FUNCTION console_identity.managed_role_permissions(text)
  IS 'Closed Console role-to-permission policy stored in the existing permission_grant authority.';
COMMENT ON FUNCTION console_identity.list_managed_identities(uuid, uuid, bigint, bigint, text)
  IS 'C_API-only bounded identity authority projection; non-managers receive only their own subject.';
COMMENT ON FUNCTION console_identity.change_managed_identity_role(uuid, uuid, bigint, bigint, uuid, text, text, text, text)
  IS 'C_API-only recent-AAL2 role mutation that atomically revises permissions and revokes target sessions.';
