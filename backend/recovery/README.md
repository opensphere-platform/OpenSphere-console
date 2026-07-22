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

The current manifest records verified Supabase, Storage and Gitea restore
drills.  It deliberately keeps `decommission.approved` false until an
independent human approval is recorded.  The Console must show that approval
as a decommission gate, never infer it from technical evidence.
