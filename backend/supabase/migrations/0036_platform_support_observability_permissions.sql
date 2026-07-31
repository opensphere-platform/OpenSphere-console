\set ON_ERROR_STOP on

-- Shared Observability is an SRL-L4 Platform Support capability. Keep the
-- existing console.his.* permissions for true SRL-L1 HIS lifecycle actions,
-- but do not reuse them for Prometheus/Grafana/Loki/Tempo/OTLP management.
INSERT INTO console.permission (code, risk_level) VALUES
  ('console.platform.support.read', 'medium'),
  ('console.platform.support.manage', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT role.id, permission.id
FROM console.role role
JOIN console.permission permission ON permission.code IN (
  'console.platform.support.read',
  'console.platform.support.manage'
)
WHERE role.code = 'console-admins'
ON CONFLICT DO NOTHING;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT role.id, permission.id
FROM console.role role
JOIN console.permission permission ON permission.code = 'console.platform.support.read'
WHERE role.code = 'console-operators'
ON CONFLICT DO NOTHING;
