-- Governed installation and activation of the fixed RCC Fail2ban sshd profile.
--
-- This is maintenance, not incident response: it installs a distribution
-- package, writes one versioned configuration drop-in and starts a service.
-- It therefore requires an enabled maintenance policy/window in addition to
-- AAL2 and a different approving administrator.

INSERT INTO console.host_operation_type
  (operation, risk_level, requires_second_person, requires_maintenance, required_permission,
   max_lease_seconds, description, requires_policy, requires_rollback)
VALUES
  ('ssh.protection.enable', 'high', true, true, 'console.hosts.ssh-ban', 1800,
   'Install the exact reported Fail2ban package version when absent, write the fixed rcc-ssh-baseline-v1 sshd profile with host-protected management addresses, start the service and verify the jail.',
   true, false)
ON CONFLICT (operation) DO UPDATE SET
  risk_level = EXCLUDED.risk_level,
  requires_second_person = EXCLUDED.requires_second_person,
  requires_maintenance = EXCLUDED.requires_maintenance,
  required_permission = EXCLUDED.required_permission,
  max_lease_seconds = EXCLUDED.max_lease_seconds,
  description = EXCLUDED.description,
  requires_policy = EXCLUDED.requires_policy,
  requires_rollback = EXCLUDED.requires_rollback;
