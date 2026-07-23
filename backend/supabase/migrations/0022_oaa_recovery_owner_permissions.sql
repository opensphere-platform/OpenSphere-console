\set ON_ERROR_STOP on

-- Recovery inspection and restore execution are intentionally separate.
-- OAA currently receives only the read/plan permission. The existing
-- console.backup.restore permission remains reserved for a future signed,
-- two-person-approved recovery executor and is never granted to the Gateway.
INSERT INTO console.permission (code, risk_level) VALUES
  ('console.recovery.read', 'medium')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT role.id, permission.id
FROM console.role role
JOIN console.permission permission ON permission.code = 'console.recovery.read'
WHERE role.code IN ('console-admins', 'console-operators')
ON CONFLICT DO NOTHING;
