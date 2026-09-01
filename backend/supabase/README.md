# Console Supabase Data & Identity Backbone

Current design authority:
`../../../DESIGN/20-MODULE/OpenSphere-Console/CONSOLE-DESIGN-INDEX.md` and its
Backbone, security, deployment, and migration specifications.

This directory owns the OpenSphere Console data and identity deployment input.
The fresh target sequence is Supabase PostgreSQL/Auth/Storage initialization,
the repository-root migration manifest, PostgREST readiness, and then C_API.

## Components

- `target/deploy.yaml`: current fresh target manifest for exactly PostgreSQL,
  Auth, PostgREST and Storage. It contains no Namespace, Secret, mutable image,
  or legacy migration input. `scripts/Install-ConsoleApiRuntime.ps1` renders its
  six closed placeholders from exact release inputs.
- `bootstrap/supabase.yaml`: PostgreSQL, Supabase Auth, PostgREST and Storage
  legacy bootstrap evidence. It is not an input to the fresh target installer.
- `images/*/Dockerfile`: digest-pinned wrappers published as governed OpenSphere
  multi-architecture images.
- `install.ps1`: Secret creation/reuse, workload rollout, Supabase Storage
  migration and every sorted legacy Console SQL migration. It remains a
  migration reference and is not called by the fresh target installer.
- `migrations/0001...0073` (72 files): legacy accumulated lineage retained as
  implementation evidence; it is not a fresh target input.
- `verify.mjs`: legacy static contract verifier.

The current fresh schema is `../../migrations/manifest.json` plus its exact SQL
inventory. The target installer renders only the manifest-bound migration named
by `latestGlobalId`; it never scans this directory's legacy numeric migrations.

## Authority boundary

- `auth.users.id` is the canonical human subject.
- PostgreSQL owns Console state, RBAC, audit and OSAA ledger data.
- Supabase Storage owns Console object data and metadata.
- Gitea remains a separate declarative desired-state and signed-history
  authority; Supabase stores change correlation, not Git history.
- Console Backend is the command/policy enforcement point; RLS is the second
  defensive layer.

Only the publishable anonymous key may reach browser code. The service-role
key, PostgreSQL passwords and constrained Backend/OSAA database credentials
remain server-side Kubernetes Secrets.

## Fresh target installation

The installation owner first creates `opensphere-console` and
`opensphere-console-data`, an `opensphere-ghcr-pull` Secret in each namespace,
and the exact six-key `opensphere-supabase-secrets` in the data namespace. The
server Secret is an input and is never generated or copied by Console runtime
code.

`scripts/Install-ConsoleApiRuntime.ps1` then receives the exact C_API and four
Supabase wrapper digests from one reviewed release input. It refuses extra
server Secret keys, partial target resources, mutable images, the legacy ledger,
and a live fresh ledger that differs from the repository manifest. It does not
create namespaces, pull credentials, or server credentials.

## Legacy reference

`bootstrap/supabase.yaml`, `install.ps1`, `migrations/`, and `verify.mjs` explain
the previous runtime and remain under regression coverage while target owners
are extracted. They are not current install instructions and must not be mixed
with `target/deploy.yaml` or the fresh migration ledger.
