\set ON_ERROR_STOP on

-- The isolated recovery drill reuses the canonical module_operation ledger.
-- No archive coordinate, S3 credential, command, URL, or arbitrary Job spec is
-- accepted by this schema: the action resolves to one of two release-owned
-- CronJob templates and completes only after operation-correlated evidence.
ALTER TABLE console.module_operation DROP CONSTRAINT IF EXISTS module_operation_action_check;
ALTER TABLE console.module_operation ADD CONSTRAINT module_operation_action_check CHECK (action IN (
  'install','verify','upgrade','rollback','delete-runtime','reinstall','purge',
  'restart-workload','scale-workload','rollback-image','run-cronjob','run-recovery-drill',
  'owner-recover','retry-delivery','create-postgres-cluster','engineering-remediation'
));

COMMENT ON TABLE console.module_operation IS
  'Canonical durable module and OSAA operation ledger, including fixed isolated recovery drills; secrets and archive coordinates are never stored here.';
