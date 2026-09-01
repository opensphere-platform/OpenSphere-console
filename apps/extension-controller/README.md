# Extension Controller

`C_EXT` is a separate Console-native process and service identity. This first vertical slice claims only `console.extension.revocation.create@1.0` operations through a fenced PostgreSQL RPC, renews the lease, and records the revocation plus execution receipt atomically. It cannot claim Registry credential replacement or any unknown action.

The runtime login inherits only `console_extension_controller`; it has no direct table mutation grant. Required configuration is `CONSOLE_EXTENSION_DATABASE_URL`. Optional settings are `CONSOLE_EXTENSION_WORKER_ID`, `CONSOLE_EXTENSION_LEASE_SECONDS`, `CONSOLE_EXTENSION_POLL_MS`, database pool/connect settings, and `PORT`.

This slice proves the Supabase authority and idempotent revocation path. Package/Registration Kubernetes reconciliation, Registry projection verification, and the write-only credential broker remain later slices; `Applied` is not yet `Verified`.
