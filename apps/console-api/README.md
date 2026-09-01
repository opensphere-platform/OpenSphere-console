# Console API

`C_API` is the Console policy enforcement point. This first target slice accepts durable operations through a constrained PostgreSQL function after checking the current opaque session, permission revision, revoke epoch, risk, reason, AAL, and action policy.

The application role has no direct table write permission. `console_operation.accept_operation` atomically writes the intent, audit-chain event, and outbox event. `console_operation.approve_operation` records one independent AAL2 approver and atomically advances an approval-required operation from `Planned` to `Authorized` using the caller's expected state version. Registry credential material is used only to calculate the canonical payload digest and is never passed to the store. Extension install intake stores only the C_REG-resolved descriptor ID, catalog revision, and exact image as its non-secret execution plan.

This package does not yet replace the complete legacy Backend. Its current HTTP boundary implements the foundational operation endpoint and the first Registry mutation consumers while the remaining legacy routes stay under controlled migration.

## Runtime

The process requires `CONSOLE_DATABASE_URL` for a login role that inherits only the `console_api` role. `CONSOLE_REGISTRY_URL` selects the fixed internal C_REG origin and defaults to `http://opensphere-registry.opensphere-console.svc.cluster.local:8080`. Optional bounded settings are `CONSOLE_REGISTRY_TIMEOUT_MS` and `CONSOLE_REGISTRY_MAX_RESPONSE_BYTES`, plus `PORT`, `CONSOLE_DATABASE_POOL_SIZE`, `CONSOLE_DATABASE_CONNECT_TIMEOUT_MS`, and `CONSOLE_DATABASE_IDLE_TIMEOUT_MS`.

```powershell
npm ci --prefix apps/console-api --no-audit --no-fund
$env:CONSOLE_DATABASE_URL = 'postgresql://<limited-runtime-role>@<supabase-postgres>/postgres'
npm start --prefix apps/console-api
```

Implemented routes are `GET/DELETE /api/identity/session`, `GET /api/identity/me`, fail-closed `GET /api/identity/supabase/status`, bounded `GET /api/identity/audit`, `POST /api/platform/operations`, `GET /api/platform/operations/{operationId}`, `POST /api/platform/operations/{operationId}/approvals`, `POST /api/platform/operations/{operationId}/verification`, Registry credential replace/remove, no-secret Registry connection metadata, exact-digest revocation acceptance/read projection, C_REG-backed `POST /api/admin/extensions/inspect`, C_REG-resolved Extension install intent, and `GET /healthz`. Inspect and install accept only `descriptorId` plus exact `catalogRevision`; image and supply-chain evidence come from C_REG. C_EXT revalidates approved installs, applies the Kubernetes Registration, and records an exact ready observation. The verification route accepts only `expectedStateVersion`; its DB RPC derives install or revocation postconditions from matching C_EXT evidence before moving `Applied` to `Verified`. Registry credential owner dispatch and legacy Backend cutover remain later slices. An operation-intake `202` proves durable intent and an approval `202` proves durable authorization; neither proves installation.
