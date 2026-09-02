\set ON_ERROR_STOP on

DO $$
DECLARE
  v_admin uuid := '21212121-2121-4121-8121-212121212121';
  v_operator uuid := '22212121-2121-4121-8121-212121212121';
  v_viewer uuid := '23212121-2121-4121-8121-212121212121';
BEGIN
  IF console_identity.managed_role_permissions('console-admins') <> ARRAY[
      'console.audit.read', 'console.data_identity.read', 'console.extension.install',
      'console.extension.remove', 'console.extension.revoke', 'console.git.change',
      'console.identity.manage', 'console.operation.approve', 'console.operation.verify',
      'console.registry.manage', 'console.role.admin'
    ]::text[]
      OR console_identity.managed_role_permissions('console-operators') <> ARRAY[
      'console.audit.read', 'console.data_identity.read', 'console.extension.install',
      'console.extension.remove', 'console.extension.revoke', 'console.git.change',
      'console.operation.verify', 'console.registry.manage', 'console.role.operator'
    ]::text[]
      OR 'console.git.change' = ANY(console_identity.managed_role_permissions('console-viewers')) THEN
    RAISE EXCEPTION 'platform change permission is outside the closed managed role policy';
  END IF;

  INSERT INTO auth.users(id) VALUES (v_admin), (v_operator), (v_viewer) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
  VALUES
    (v_admin, '31212121-2121-4121-8121-212121212121', 1, 0),
    (v_operator, '32212121-2121-4121-8121-212121212121', 1, 0),
    (v_viewer, '33212121-2121-4121-8121-212121212121', 1, 0);
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    SELECT v_admin, permission, 1, v_admin
      FROM unnest(console_identity.managed_role_permissions('console-admins')) AS permission;
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    SELECT v_operator, permission, 1, v_admin
      FROM unnest(console_identity.managed_role_permissions('console-operators')) AS permission;
  INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    SELECT v_viewer, permission, 1, v_admin
      FROM unnest(console_identity.managed_role_permissions('console-viewers')) AS permission;

  IF NOT EXISTS (
      SELECT 1 FROM console_identity.permission_grant
       WHERE subject_id = v_admin AND permission = 'console.git.change' AND revoked_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM console_identity.permission_grant
       WHERE subject_id = v_operator AND permission = 'console.git.change' AND revoked_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM console_identity.permission_grant
       WHERE subject_id = v_viewer AND permission = 'console.git.change' AND revoked_at IS NULL
    ) THEN
    RAISE EXCEPTION 'platform change permission grants are invalid';
  END IF;
END;
$$;
