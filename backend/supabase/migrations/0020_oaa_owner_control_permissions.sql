\set ON_ERROR_STOP on

-- Conversational owner controls are separate from generic Console-admin
-- membership.  The Gateway and the owning service both evaluate these
-- permissions, so adding a capability never turns an Admin REST surface into
-- an implicit LLM proxy.
INSERT INTO console.permission (code, risk_level) VALUES
  ('console.extension.security.read', 'medium'),
  ('console.extension.security.manage', 'high'),
  ('console.notification.read', 'medium'),
  ('console.notification.manage', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT role.id, permission.id
FROM console.role role
JOIN console.permission permission ON permission.code IN (
  'console.extension.security.read',
  'console.extension.security.manage',
  'console.notification.read',
  'console.notification.manage'
)
WHERE role.code = 'console-admins'
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT role.id, permission.id
FROM console.role role
JOIN console.permission permission ON permission.code IN (
  'console.extension.security.read',
  'console.notification.read'
)
WHERE role.code = 'console-operators'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE console.permission IS
  'Canonical Console permissions, including independently reviewed OAA owner-facade read and mutation capabilities.';
