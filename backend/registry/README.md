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

Extension resolution uses `UIPluginPackage` as the installable catalog and keeps activated `UIPluginRegistration` entries in the separate `plugins` runtime projection. This permits a verified Package to be resolved before its first Registration exists. A candidate requires a canonical OpenSphere GHCR repository, exact image digest, matching resolution/trust identity, full source revision, semantic compatibility version, provenance/SBOM references, and Package generation/resource version. The eligible response binds `descriptorRevision` to the catalog revision and `executionRevision` to the exact image. A stale snapshot, stale requested revision, or incomplete execution identity fails closed.

Runtime instances, credentials, capacity, replica counts, backup policy and lifecycle state are
not Registry fields. Core Services are discovery-only. Only exact-digest `extension` and
`installableModule` descriptors can be resolved; OSCE and each Owner execute approved changes.

The service keeps one immutable in-memory snapshot. A complete validated input set is serialized
deterministically, hashed as the catalog revision and atomically swapped. After a source failure,
browse retains the last snapshot with `stale=true`; resolve fails closed.
