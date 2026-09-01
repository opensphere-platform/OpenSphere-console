# Console API

`C_API` is the Console policy enforcement point. This first target slice accepts durable operations through a constrained PostgreSQL function after checking the current opaque session, permission revision, revoke epoch, risk, reason, AAL, and action policy.

The application role has no direct table write permission. `console_operation.accept_operation` atomically writes the intent, audit-chain event, and outbox event. `console_operation.approve_operation` records one independent AAL2 approver and atomically advances an approval-required operation from `Planned` to `Authorized` using the caller's expected state version. Registry credential material is used only to calculate the canonical payload digest and is never passed to the store.

This package does not yet replace the complete legacy Backend. Its current HTTP boundary implements the foundational operation endpoint and the first Registry mutation consumers while the remaining legacy routes stay under controlled migration.

## Runtime

The process requires `CONSOLE_DATABASE_URL` for a login role that inherits only the `console_api` role. Optional settings are `PORT`, `CONSOLE_DATABASE_POOL_SIZE`, `CONSOLE_DATABASE_CONNECT_TIMEOUT_MS`, and `CONSOLE_DATABASE_IDLE_TIMEOUT_MS`.

```powershell
npm ci --prefix apps/console-api --no-audit --no-fund
$env:CONSOLE_DATABASE_URL = 'postgresql://<limited-runtime-role>@<supabase-postgres>/postgres'
npm start --prefix apps/console-api
```

Implemented routes are `GET/DELETE /api/identity/session`, `GET /api/identity/me`, bounded `GET /api/identity/audit`, `POST /api/platform/operations`, `GET /api/platform/operations/{operationId}`, `POST /api/platform/operations/{operationId}/approvals`, `POST /api/platform/operations/{operationId}/verification`, Registry credential replace/remove, no-secret Registry connection metadata, exact-digest revocation acceptance/read projection, and `GET /healthz`. Identity reads return no opaque handle/token/CSRF value; session delete rechecks CSRF and current revisions, then atomically revokes only that session and appends audit evidence. Registry credential owner dispatch and legacy Backend cutover remain separate later slices. An operation-intake `202` proves durable intent and an approval `202` proves durable authorization. Verification returns `200` only after the database matches the current C_EXT revocation row to its fenced `Applied` receipt; the caller cannot supply observation evidence. Audit reads require current `console.audit.read` and expose newest-first cursor pages without granting ledger mutation.
