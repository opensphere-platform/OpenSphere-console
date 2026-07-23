# Gitea platform-control bootstrap

Fresh installs are owned by `install.ps1`. It creates or reuses the private
runtime/config/signing Secrets, renders the digest-pinned Gitea and PostgreSQL
images plus StorageClass, waits for both databases and Gitea, and then invokes
the control-plane bootstrap:

```powershell
.\install.ps1 `
  -GiteaImage ghcr.io/opensphere-platform/opensphere-console-gitea@sha256:<digest> `
  -PostgresImage ghcr.io/opensphere-platform/opensphere-console-gitea-postgres@sha256:<digest> `
  -StorageClass hostpath
```

`OpenSphere-Setup-CLI` downloads this script and its companion files from the
same immutable source revision as the signed Release BOM. Direct execution is
for development and recovery diagnostics; normal installation uses Setup.

`control-plane-bootstrap.ps1` runs after the Gitea workload is Ready and before
the Console Backend uses its governed-change environment.

The script is idempotent. It creates non-human `opensphere-control` and
`opensphere-review` identities, issues separate repository/organization and
review-scoped tokens, creates the private `opensphere/platform-declarations`
repository, and registers the signed pull-request webhook. Generated token,
webhook and reconciler credentials are only written to
`opensphere-console/opensphere-gitea-control-plane`; they are never printed.

The Console Backend consumes that Secret. Browser clients, OAA, and the Gitea
repository never receive the values.

`configure-signing.ps1` provisions the server-only SSH signing key used by
Gitea. The key is copied at pod start to an in-memory owner-only volume; it
never reaches the Console browser, Supabase, a repository, or a ConfigMap.
Gitea signs API CRUD commits and approved merges, while the protected `main`
branch rejects unsigned commits. For a manual development install:

```powershell
.\configure-signing.ps1
kubectl apply -f .\gitea.yaml
kubectl -n opensphere-console-change scale deployment/opensphere-gitea --replicas=1
.\control-plane-bootstrap.ps1
```

The committed manifest intentionally keeps the Gitea Deployment at zero
replicas so an uncoordinated restore cannot start it against an incomplete
database. `install.ps1` is the fresh-install path that scales it to one after
the PostgreSQL boundary is ready.
