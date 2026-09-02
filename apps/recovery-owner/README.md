# OpenSphere Platform Recovery Evidence

`opensphere-platform-recovery-evidence` is the Console's recovery evidence
contract. It contains checksums, verification times, opaque owner-staged
manifest keys and operation correlation. The Console/OSAA projection removes
the manifest keys and checksum values; S3 credentials, archive contents and the
AES-GCM encryption key never enter the Console API, Git or operation ledger.

The contract is authoritative for the Console readiness view only when all of
the following are true:

1. the Supabase PostgreSQL dump and Storage archive are checksum-verified;
2. the Gitea archive is checksum-verified;
3. a non-destructive restore drill has restored every data authority and
   recorded its assertions; and
4. a named operator has separately approved legacy decommission.

The release manifest begins entirely `AttentionRequired`. A completed,
digest-pinned recovery Job may write structured evidence through a Role scoped
to this one ConfigMap. A healthy workload, a CronJob object, or an uploaded
file alone can never create recovery evidence. `decommission.approved` stays
false until an independent human approval is recorded. The Console must show
every gap as a gate.

Schema `v3` declares an evidence freshness policy. The OSAA recovery owner
returns only checksum-present/verified flags, structured restore assertions and
freshness; it never returns the vault location or checksum values. Its
capability set is `status-read`, `plan-read`, `drill-request` and
`evidence-promote`. A drill request is accepted only through the durable OSCE
operation ledger and maps to one of the two release-owned CronJobs. OSAA cannot
supply a command, URL, archive, Secret, environment variable or Job manifest.

## Executor boundary

The `opensphere-console-recovery` image provides four modes:

- `backup-supabase` creates a custom PostgreSQL dump and Storage archive.
- `backup-gitea` creates a Gitea database dump plus repository and private
  configuration archive.
- `drill-supabase` restores both Supabase artifacts to an `emptyDir` PostgreSQL
  target and verifies Auth, operator, audit and Storage assertions.
- `drill-gitea` restores Gitea to a separate `emptyDir` PostgreSQL target and
  verifies database, repository Git-head and private configuration assertions.

Artifacts are AES-256-GCM encrypted before they leave the cluster. The run
manifest has both plaintext and ciphertext SHA-256 values; the drill verifies
both values and the GCM authentication tag before it restores anything.

The two source CronJobs are shipped `suspend: true`. Change Control must first
quiesce `opensphere-supabase-storage` or `opensphere-gitea` respectively, and
provide a valid external target Secret; then an approved operator may unsuspend
and run them. The Job has only `get` access to that exact writer Deployment and
fails if desired, current, or ready replicas is non-zero. This prevents a
default installation or a live-PVC copy from being misrepresented as an
application-consistent backup.

The target Secret is an existing operator-owned Secret supplied to Setup as
`--recovery-target-secret namespace/name`. It must contain `endpoint`,
`bucket`, `region`, `access_key`, `secret_key`, `encryption_key` (at least 32
bytes) and `ca.crt`. Setup copies only those keys to the data, change and
isolated-drill namespaces. It never puts them into a release lock, a ConfigMap,
an environment report or an OSAA response.

The two drill CronJobs are also shipped `suspend: true`; they are templates,
not schedules. After a verified backup exists, the durable `run-recovery-drill`
operation resolves the live template UID and revision, requires AAL2 exact
confirmation plus its R2 approval, and lets the reviewed reconciler create one
Job. Admission rejects any other recovery Job shape. Success requires both the
Job terminal condition and `RECOVERY_OPERATION_ID`-matched structured restore
evidence; an old successful drill cannot satisfy a new operation.
