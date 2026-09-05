# Git-reviewed native module installation

`/manage/state-changes?template=console-cluster-manager-install` resolves the
current Cluster Manager package through the Console Registry. The only supported
new declaration is the closed `console-modules` install template. Foundation and
Ceph consumers remain `NotConfigured`; this is not a general GitOps executor.

The Console stores one native `console.extension.install` operation, its exact
Registry plan and a separate immutable Git declaration binding. Gitea proposal
and independent Console approval do not permit execution by themselves. The API
validates the exact PR head, its sole added declaration file and canonical content,
performs protected merge with the head precondition, verifies the merged content,
then records the merge revision. Migration 0039 makes the existing C_EXT claim
function exclude bound operations until this merge record exists.

C_EXT retains its original admission, lease fencing, revocation, registration
writer and Ready observation. `Applied` is not `Verified`: the state-change page
offers the existing evidence verification action after the `InstallReady` owner
receipt. No new controller, queue, service, table or Kubernetes privilege is added.

The current-session permission and independent natural-person approval checks
remain mandatory. Recent MFA is required except for the already authorized exact
Cluster Manager operation in HTTPS localhost / edge / development / docker-desktop.
Both API and database inspect the stored operation and current installation policy;
the actual AAL1 session is retained. Another account of the same person cannot approve.

A failed proposal can be resumed by its requester using the page's resume action
(`POST /api/platform/changes` with only `operationId`). An authorized operation can
resume protected merge through the existing approval endpoint. Neither creates a
second native operation. Reads do not dispatch work.

Verification commands:

```sh
npm run test:console-api
npm run verify:contracts
npm run verify:migrations
npm run test:gitea-module-db
```

The database scenario needs Docker and `pgvector/pgvector:0.8.2-pg17`; it creates
a uniquely named test container with no network or host mounts and tmpfs storage,
applies the manifest and checks approval/merge/fencing boundaries, then deletes
only that labelled disposable container. It never uses the installation database.
These tests do not constitute a real user's independent approval, a production
installation or whole-Console clean-install acceptance.
