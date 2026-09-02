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
      'console.git.change',
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
      'console.git.change',
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

DO $$
DECLARE
  v_subject console_identity.subject_authority;
  v_next_revision bigint;
BEGIN
  FOR v_subject IN
    SELECT authority.*
      FROM console_identity.subject_authority AS authority
     WHERE EXISTS (
       SELECT 1
         FROM console_identity.permission_grant AS role_grant
        WHERE role_grant.subject_id = authority.subject_id
          AND role_grant.permission IN ('console.role.admin', 'console.role.operator')
          AND role_grant.grant_revision <= authority.permission_revision
          AND role_grant.revoked_at IS NULL
     )
       AND NOT EXISTS (
       SELECT 1
         FROM console_identity.permission_grant AS change_grant
        WHERE change_grant.subject_id = authority.subject_id
          AND change_grant.permission = 'console.git.change'
          AND change_grant.grant_revision <= authority.permission_revision
          AND change_grant.revoked_at IS NULL
     )
     ORDER BY authority.subject_id
     FOR UPDATE
  LOOP
    v_next_revision := v_subject.permission_revision + 1;
    INSERT INTO console_identity.permission_grant(
      subject_id, permission, grant_revision, granted_by
    ) VALUES (
      v_subject.subject_id, 'console.git.change', v_next_revision, v_subject.subject_id
    );
    UPDATE console_identity.subject_authority
       SET permission_revision = v_next_revision,
           revoke_epoch = revoke_epoch + 1,
           updated_at = statement_timestamp()
     WHERE subject_id = v_subject.subject_id;
    UPDATE console_identity.browser_session
       SET revoked_at = statement_timestamp(),
           revoke_reason = 'platform-change-policy-upgrade'
     WHERE subject_id = v_subject.subject_id
       AND revoked_at IS NULL;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION console_identity.managed_role_permissions(text) FROM PUBLIC;

COMMENT ON FUNCTION console_identity.managed_role_permissions(text)
  IS 'Closed Console role policy including governed Gitea proposal permission for administrators and operators.';
