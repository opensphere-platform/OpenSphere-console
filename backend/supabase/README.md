# Console Supabase Data & Identity Backbone

Canonical decision: `_DOCS_/10-의사결정/migration-adr-006-console-supabase-data-identity-backbone.md`.

This directory implements the parallel-install phase of the migration. It does
not delete or mutate the existing Kanidm/PostgreSQL/RustFS installation.

## Components

- `bootstrap/supabase.yaml`: pinned PostgreSQL 17, Supabase Auth, PostgREST and Storage workloads in `opensphere-console-data` by default.
- `migrations/0001_console_backbone.sql`: canonical subject, RBAC, settings, change request, append-only audit and Storage policies.
- `migrations/0002_backend_boundary.sql`: constrained Console Backend database grants.
- `migrations/0003_change_correlation.sql`: atomic audit intent, Gitea commit and Kubernetes reconcile correlation RPCs.
- `migrations/0004_backend_rls.sql`: explicit RLS policy for the server-only Console Backend JWT role.
- `migrations/0005_oaa_governed_agent.sql`: OAA knowledge/capability/retrieval schema, pgvector + FTS indexes, canonical OAA permissions, and the constrained OAA database role.
- `migrations/0007_extension_revocation.sql`: append-only OCI image-digest revocation ledger owned by Supabase Console data.
- `install.ps1`: generate secrets, deploy, wait and apply migrations idempotently.
- `../opensphere-console-oaa-gateway/scripts/migrate-legacy-knowledge-to-supabase.js`: dry-run/apply cutover helper. It re-embeds every legacy chunk with a real provider and never copies hash vectors.
- `verify.mjs`: static contract checks suitable for CI and preflight.

Gitea remains the declarative change authority. This stack stores only the
request, actor, commit SHA and reconciliation result correlation.

## Required boundary

Only the publishable/anon key may reach the browser. `service-role-key`, the
Postgres owner password and the Backend DB password remain Kubernetes Secrets
consumed by server-side workloads. The Console Backend remains the command and
policy enforcement point; RLS is a second defensive layer.
