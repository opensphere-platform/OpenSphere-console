\set ON_ERROR_STOP on

-- The installer creates opensphere_console_backend as a NO-BYPASSRLS login
-- with an independently generated password before applying this migration.
GRANT CONNECT ON DATABASE postgres TO opensphere_console_backend;
GRANT USAGE ON SCHEMA console, audit, internal TO opensphere_console_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA console TO opensphere_console_backend;
GRANT SELECT, INSERT ON audit.event TO opensphere_console_backend;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA console, audit TO opensphere_console_backend;
REVOKE UPDATE, DELETE, TRUNCATE ON audit.event FROM opensphere_console_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA console
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opensphere_console_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO opensphere_console_backend;

-- The audit trigger remains enabled even for table owners and privileged
-- maintenance paths. Recovery must use a separately audited restore procedure.
ALTER TABLE audit.event ENABLE ALWAYS TRIGGER audit_event_append_only;
