# OpenSphere Registry & Catalog Service

`opensphere-registry` is a CBSS Core Service and the single read-only serving authority for
OpenSphere module discovery and installable Catalog candidates.

- Public discovery: `GET /api/v1/registry`
- Internal deterministic resolution: `POST /api/v1/registry/resolve`
- Operations: `GET /healthz`, `/readyz`, `/v1/status`, `/metrics`
- Common model: `RegistryDescriptorV1` classes `coreService`, `extension`, `installableModule`
- Inputs: canonical `opensphere-installation-lock`, verified UI Plugin CRs, Foundation descriptors,
  public trust keys and operator-owned navigation preferences
- Coverage: expected/published/rejected/missing totals and the same values by descriptor class
- Mutations: none. It does not install, update, delete or operate workloads.

Extension resolution uses `UIPluginPackage` as the installable catalog and keeps activated `UIPluginRegistration` entries in the separate `plugins` runtime projection. This permits a verified Package to be resolved before its first Registration exists. The currently supported `edge` candidate requires a canonical OpenSphere GHCR repository, exact image digest, matching resolution/trust identity, full source revision, semantic compatibility version, `buildAuthority=localhost`, exact-image-bound P-256 signature/local-build evidence references, and Package generation/resource version. The eligible response binds `descriptorRevision` to the catalog revision and `executionRevision` to the exact image, and reports `LocalEdgeSigned` / `NotRequiredLocalEdge` instead of official provenance/SPDX verification. A stale snapshot, stale requested revision, or incomplete execution identity fails closed.

The current Go service validates this local-edge binding; it does not fetch or cryptographically verify OCI provenance or SPDX bundle bytes. Therefore `evidenceRefs` and the projected manifest/signature/permission strings are not an accepted official-channel attestation receipt. The legacy DUPA inspection path contains the prior `gh attestation verify --bundle-from-oci` implementation. If official candidate/stable/ga resolution becomes a current requirement, bounded verification belongs in C_REG's existing ingest/refresh path, keyed by exact digest and source/workflow policy. That requirement does not justify a new service, queue, database, or per-request verifier, and no verifier dependency is added while only local edge is published.

Runtime instances, credentials, capacity, replica counts, backup policy and lifecycle state are
not Registry fields. Core Services are discovery-only. Only exact-digest `extension` and
`installableModule` descriptors can be resolved; OSCE and each Owner execute approved changes.

The service keeps one immutable in-memory snapshot. A complete validated input set is serialized
deterministically, hashed as the catalog revision and atomically swapped. After a source failure,
browse retains the last snapshot with `stale=true`; resolve fails closed.

For the Console-only bootstrap, an absent Foundation descriptor API is reported as
`Ready=false, Reason=NotInstalled`; it does not prevent publishing the native Console
catalog. A forbidden or unavailable Foundation API still fails closed. UI Plugin APIs,
the installation lock and `opensphere-extension-trusted-keys` remain required inputs.
This avoids manufacturing Foundation resources or retaining a legacy trust-key alias.