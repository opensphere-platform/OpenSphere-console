# Console API

`C_API` is the Console policy enforcement point. This first target slice accepts durable operations through a constrained PostgreSQL function after checking the current opaque session, permission revision, revoke epoch, risk, reason, AAL, and action policy.

The application role has no direct table write permission. `console_operation.accept_operation` atomically writes the intent, audit-chain event, and outbox event. Registry credential material is used only to calculate the canonical payload digest and is never passed to the store.

This package does not yet replace the complete legacy Backend. Its current HTTP boundary implements the foundational operation endpoint and the first Registry mutation consumers while the remaining legacy routes stay under controlled migration.

## Runtime

The process requires `CONSOLE_DATABASE_URL` for a login role that inherits only the `console_api` role. Optional settings are `PORT`, `CONSOLE_DATABASE_POOL_SIZE`, `CONSOLE_DATABASE_CONNECT_TIMEOUT_MS`, and `CONSOLE_DATABASE_IDLE_TIMEOUT_MS`.

```powershell
npm ci --prefix apps/console-api --no-audit --no-fund
$env:CONSOLE_DATABASE_URL = 'postgresql://<limited-runtime-role>@<supabase-postgres>/postgres'
npm start --prefix apps/console-api
```

Implemented routes are `GET /healthz`, `POST /api/platform/operations`, `GET /api/platform/operations/{operationId}`, Registry credential replace/remove, and exact-digest revocation acceptance. Registry owner dispatch, approval execution, and legacy Backend cutover remain separate later slices; a `202` response currently proves durable intent only.
