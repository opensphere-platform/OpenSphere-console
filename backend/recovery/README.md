# OpenSphere Platform Recovery Evidence

`opensphere-platform-recovery-evidence` is the Console's read-only recovery
evidence contract.  It intentionally contains checksums, verification times
and approval state only; backup locations, credentials and archive contents
stay outside Kubernetes and out of Git.

The contract is authoritative for the Console readiness view only when all of
the following are true:

1. the Supabase PostgreSQL dump and Storage archive are checksum-verified;
2. the Gitea archive is checksum-verified;
3. a non-destructive restore drill has restored every data authority and
   recorded its assertions; and
4. a named operator has separately approved legacy decommission.

The current manifest records verified backup checksums and a verified
Supabase database restore.  Storage and Gitea restore assertions remain
`AttentionRequired` until an isolated drill with a Storage canary object and
reviewed Gitea counts is promoted through Change Control.  A completed live
Job or a healthy target is not allowed to rewrite this evidence implicitly.
`decommission.approved` also remains false until an independent human approval
is recorded.  The Console must show both gaps as gates, never infer approval or
restore success from workload presence.

Schema `v2` also declares an evidence freshness policy. The OAA recovery owner
returns only checksum-present/verified flags, structured restore assertions and
freshness; it never returns the vault location or checksum values. Its current
capability set is deliberately limited to `status-read` and `plan-read`.
`drill-request` and `evidence-promote` remain unavailable until a separately
signed, two-person-approved isolated recovery executor exists.
