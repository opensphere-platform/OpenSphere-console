# Console data migrations

`baseline/0001_console_authority.sql` establishes the first reconstructed fresh-install authority slice: opaque sessions, permission grants, durable operations, transactional outbox, and append-only audit records. Its verification scripts under `baseline/verify/` exercise RLS and audit immutability against a disposable PostgreSQL instance.

`versions/` is reserved for append-only successors with globally unique IDs, predecessor, semantic key, file digest, and migration-set digest. The legacy `backend/supabase/migrations/0001..0073` history remains evidence; new migrations must not extend that sequence. The baseline is still incomplete until the remaining domain tables, complete role/RLS matrix, upgrade fixture, and isolated restore assertions are added.
