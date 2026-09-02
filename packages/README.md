# Console packages

Packages hold reusable Console-owned policy and machine contracts. They must not import another OpenSphere repository's source tree or bypass a runtime owner's API.

- `contracts/` defines OpenAPI operations, JSON Schemas, owner/consumer contracts, shared TypeScript types, and source dispositions.
- `domain/` defines durable operation states and closed transition rules.
- `authz/` evaluates current server-side identity, permission, AAL, and reason requirements.
- `operation-receipt/` creates canonical digests and immutable operation receipts.
- `testing/` contains cross-package acceptance fixtures for the Backbone foundation slice.

These packages are the first implementation baseline. They do not imply that the remaining legacy `backend/` capabilities have completed migration.
