# OpenSphere Registry & Catalog Service

`opensphere-registry` is a CBSS Core Service and the single read-only serving authority for
OpenSphere extension discovery and installable Catalog candidates.

- Public discovery: `GET /api/v1/registry`
- Internal deterministic resolution: `POST /api/v1/registry/resolve`
- Operations: `GET /healthz`, `/readyz`, `/v1/status`, `/metrics`
- Inputs: verified UI Plugin CRs, Catalog CRs, Foundation descriptors, public trust keys and
  operator-owned navigation preferences
- Mutations: none. It does not install, update, delete or operate workloads.

The service keeps one immutable in-memory snapshot. A complete validated input set is serialized
deterministically, hashed as the catalog revision and atomically swapped. After a source failure,
browse retains the last snapshot with `stale=true`; resolve fails closed.
