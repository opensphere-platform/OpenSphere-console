# Data & Identity regression fixture

`data-identity-sql.json` is the real output of migration 0038's status function in a disposable PostgreSQL database. It contains only fixed test users from `0001_console_authority.verify.sql` and aggregate/catalog metadata; no production rows, credentials or session handles. The UI test passes this DTO through C_API aggregation and JSON Schema validation before parsing it.

Reproduce on the Windows Docker Desktop development host:

1. Build `apps/recovery-owner/Dockerfile` with context `apps/recovery-owner` as `opensphere-data-identity-recovery-test:local`.
2. Start that image as `opensphere-data-identity-db-test`, label `opensphere.task=data-identity-20260905`, `--network none`, no host mounts/ports, entrypoint `sh`. Initialize PostgreSQL with `initdb -D /work/pg -U postgres --auth=trust`, then `pg_ctl -D /work/pg -o "-c listen_addresses= -c unix_socket_directories=/work" -w start` and keep this isolated container running.
3. Run `node scripts/verify-data-identity-postgres.mjs --update-fixture`. The script checks the exact test container and network label, replaces only its test database and roles, verifies the complete source-bound manifest and exercises missing/disabled protection and revoked authorization. Omit `--update-fixture` for verification only.
4. Run the API evidence tests and `admin-data-identity.layout.spec.ts`, then remove only the test container after confirming its label. Never point this harness at a Kubernetes or production DB.

Backup evidence in unit tests is synthetic and is never published to a runtime ConfigMap. Passing these tests does not claim an operational backup or restore drill succeeded.
