# Console Supabase Data & Identity Backbone

Canonical decision:
`_DOCS_/10-의사결정/migration-adr-006-console-supabase-data-identity-backbone.md`.

This directory is the active OpenSphere Console data and identity authority.
It is installed by `OpenSphere-Setup-CLI` before Gitea, Backend, OAA and the
Main Shell.

## Components

- `bootstrap/supabase.yaml`: PostgreSQL, Supabase Auth, PostgREST and Storage
  workloads in `opensphere-console-data`.
- `images/*/Dockerfile`: digest-pinned wrappers published as governed OpenSphere
  multi-architecture images.
- `install.ps1`: Secret creation/reuse, workload rollout, Supabase Storage
  migration and every sorted Console SQL migration.
- `migrations/0001...0023`: canonical subject, RBAC, settings, audit, change
  correlation, notification delivery, OAA control/evidence and recovery owner
  contracts.
- `verify.mjs`: static manifest, migration, security-boundary and proxy checks.

The installer discovers `migrations/*.sql`, sorts them by filename, and applies
all of them with `ON_ERROR_STOP=1`. A new migration therefore cannot be silently
omitted by a hand-maintained filename list.

## Authority boundary

- `auth.users.id` is the canonical human subject.
- PostgreSQL owns Console state, RBAC, audit and OAA ledger data.
- Supabase Storage owns Console object data and metadata.
- Gitea remains a separate declarative desired-state and signed-history
  authority; Supabase stores change correlation, not Git history.
- Console Backend is the command/policy enforcement point; RLS is the second
  defensive layer.

Only the publishable anonymous key may reach browser code. The service-role
key, PostgreSQL passwords and constrained Backend/OAA database credentials
remain server-side Kubernetes Secrets.

## Normal installation

Use `OpenSphere-Setup-CLI`. It replaces every upstream image with the exact
signed Release BOM digest and downloads this installer plus migrations from the
same source revision.

Manual development execution:

```powershell
.\install.ps1 `
  -ConsoleUrl https://localhost:8090 `
  -Namespace opensphere-console-data `
  -KubeContext docker-desktop
```

The source manifest contains release placeholders and upstream version anchors;
it is not the production trust decision. Setup-rendered manifests must contain
only `ghcr.io/opensphere-platform/...@sha256:...` image references.

## Static verification

```powershell
node .\verify.mjs
```

This verifies image version anchors, Secret boundaries, all migration contracts,
dynamic ordered migration application and the Auth/Storage reverse-proxy routes.
