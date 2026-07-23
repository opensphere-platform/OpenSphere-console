-- Console migration provenance is operational evidence, not a best-effort
-- installer log.  `install.ps1` creates this table before it applies 0001 so
-- the ledger covers the entire ordered release set; this migration makes the
-- invariant explicit for any alternate reviewed migration runner.
CREATE SCHEMA IF NOT EXISTS console AUTHORIZATION supabase_admin;

CREATE TABLE IF NOT EXISTS console.schema_migration (
  migration_id text PRIMARY KEY CHECK (migration_id ~ '^[0-9]{4}_[a-z0-9_]+$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  executor text NOT NULL DEFAULT current_user,
  result text NOT NULL DEFAULT 'applied' CHECK (result = 'applied')
);

CREATE OR REPLACE FUNCTION console.reject_schema_migration_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, console
AS $$
BEGIN
  RAISE EXCEPTION 'console.schema_migration is append-only';
END;
$$;

DROP TRIGGER IF EXISTS schema_migration_append_only ON console.schema_migration;
CREATE TRIGGER schema_migration_append_only
  BEFORE UPDATE OR DELETE ON console.schema_migration
  FOR EACH ROW EXECUTE FUNCTION console.reject_schema_migration_mutation();
ALTER TABLE console.schema_migration ENABLE ALWAYS TRIGGER schema_migration_append_only;

REVOKE ALL ON TABLE console.schema_migration FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE console.schema_migration TO opensphere_console_backend;

COMMENT ON TABLE console.schema_migration IS
  'Append-only Console migration ID, SHA-256 and immutable release source revision; checksum drift fails closed in the installer.';
