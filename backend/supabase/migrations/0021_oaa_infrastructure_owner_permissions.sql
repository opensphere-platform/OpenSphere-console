\set ON_ERROR_STOP on

-- Infrastructure owner APIs use capabilities that are narrower than generic
-- Console administration.  Both the OAA Gateway and each owning service
-- evaluate these permissions; mutations additionally require AAL2.
INSERT INTO console.permission (code, risk_level) VALUES
  ('console.his.read', 'medium'),
  ('console.his.manage', 'high'),
  ('console.ceph.read', 'medium'),
  ('console.ceph.manage', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT role.id, permission.id
FROM console.role role
JOIN console.permission permission ON permission.code IN (
  'console.his.read',
  'console.his.manage',
  'console.ceph.read',
  'console.ceph.manage'
)
WHERE role.code = 'console-admins'
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT role.id, permission.id
FROM console.role role
JOIN console.permission permission ON permission.code IN (
  'console.his.read',
  'console.ceph.read'
)
WHERE role.code = 'console-operators'
ON CONFLICT DO NOTHING;
