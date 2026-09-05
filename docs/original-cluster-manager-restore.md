# Original Cluster Manager integration — 2026-09-06

Requirement: CON-FR-007; owners: C_EXT signed module materialization and C_API/Supabase identity + audit.

The user rejected the newly created read-only substitute. The product source is
https://github.com/opensphere-platform/OpenSphere-shell-clusterManager at baseline
824a9174ca581be5f4382d409c649843f9e44454, compatibility version 1.3.18.

C_EXT accepts the original infrastructure profile only for the signed official module.
It uses opensphere-cluster-manager-runtime, separate from the previous read-only identity.
The fixed installation policy mount is read-only. User bearer credentials are exchanged
by the existing Console owner path, then revalidated by C_API and Supabase for each event.
No browser cookie, raw credential, arbitrary metadata or caller-selected actor is accepted
by POST /api/internal/cluster-manager/events. Migration 0041 appends to the existing audit
ledger and checks live session, permission revision, revoke epoch, admin role and MFA.
Actual AAL1 remains AAL1; only configured HTTPS localhost + edge permits it for mutations.

Acceptance: original signed browser artifacts pass the actual consumer verifier; original
133 tests, Controller/identity/audit 164 tests and isolated PostgreSQL 10 negative/positive
checks passed before publication. Runtime and browser acceptance must be recorded separately.

Known integration gap: the current Console Ceph prerequisite reconciler is not connected.
An absent external Ceph connection must not be reported as connected or verified. No disks,
provider data, pools, credentials, or optional HISS workloads are modified by restoring the UI.

Post-deployment integration findings: C_EXT overwrote old verification while waiting for a
replacement Pod, causing a recovery deadlock. New artifact verification is now independent
of old rollback eligibility; old unverified state is never promoted as evidence. The browser
also interpreted canonical owner /app paths as website-root paths, contradicting C_EXT.
They now map under the exact signed proxy revision, retaining origin/traversal isolation.
The Catalog read-only-substitute description is corrected.
