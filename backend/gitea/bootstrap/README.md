# Gitea platform-control bootstrap

Run `./control-plane-bootstrap.ps1` after the Gitea workload is Ready and
before deploying the Console Backend with its governed-change environment.

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
branch rejects unsigned commits. Run it before applying `gitea.yaml`:

```powershell
.\configure-signing.ps1
kubectl apply -f .\gitea.yaml
.\control-plane-bootstrap.ps1
```
