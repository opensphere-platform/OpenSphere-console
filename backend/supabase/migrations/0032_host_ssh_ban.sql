-- Governed SSH ban management for the fixed Fail2ban sshd jail.
--
-- These operations are intentionally outside maintenance windows: blocking an
-- attacking address is an incident response, not scheduled maintenance. They
-- remain high risk, AAL2-gated and two-person approved because banning the
-- wrong management address can lock an operator out.

INSERT INTO console.permission (code, risk_level) VALUES
  ('console.hosts.ssh-ban', 'high')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
WHERE r.code = 'console-admins'
  AND p.code = 'console.hosts.ssh-ban'
ON CONFLICT DO NOTHING;

INSERT INTO console.host_operation_type
  (operation, risk_level, requires_second_person, requires_maintenance, required_permission,
   max_lease_seconds, description, requires_policy, requires_rollback)
VALUES
  ('ssh.ban', 'high', true, false, 'console.hosts.ssh-ban', 120,
   'Ban one exact IP address in the fixed Fail2ban sshd jail after rechecking the reviewed live state. CIDR ranges, arbitrary jails and protected management addresses are refused.',
   false, false),
  ('ssh.unban', 'high', true, false, 'console.hosts.ssh-ban', 120,
   'Remove one exact IP address from the fixed Fail2ban sshd jail after rechecking the reviewed live state.',
   false, false)
ON CONFLICT (operation) DO UPDATE SET
  risk_level = EXCLUDED.risk_level,
  requires_second_person = EXCLUDED.requires_second_person,
  requires_maintenance = EXCLUDED.requires_maintenance,
  required_permission = EXCLUDED.required_permission,
  max_lease_seconds = EXCLUDED.max_lease_seconds,
  description = EXCLUDED.description,
  requires_policy = EXCLUDED.requires_policy,
  requires_rollback = EXCLUDED.requires_rollback;
