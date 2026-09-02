# Console contracts

This package is the machine-readable boundary for Console Web, API, CLI, OSAA, native workers, and cooperating owners. It starts with the session, authorization, audit, and operation Backbone slice and expands until every production endpoint is represented.

The TypeScript host contract was reconstructed from legacy `@opensphere/sdk` revision `0b5356db5de55c7330480f595fef9a84186426b4`. That provenance is recorded in this package's metadata and contract evidence. The contract is now versioned with Console so a Console build never reads a sibling repository's working tree. External publication or transfer to Design Kit remains a separate decision.

Contract status is explicit in `contract-denominator.json`. The current denominator contains 58 operations, 6 governed action policies, 64 JSON Schemas, and 10 Console component boundaries. `foundational-slice` means implementation may begin on those operations; it does not claim full API coverage.

`browser-api-cutover.json` is the migration denominator for the actual Console Web source. It assigns every distinct `/api` route pattern to one target component and records which browser-session capabilities remain unavailable. The verifier currently closes 120 route patterns across 15 functional families; all 13 target browser-session capabilities are implemented and verified. Authenticated route cutover remains a separate all-family routing and owner-admission gate; public Registry and CLI artifact routes may remain independently target-routed.

`fixtures/design-kit-type-token-consumer-v1.json` freezes the semantic type variables consumed by the historical Design Kit at an exact source revision and SHA-256. Console tests consume this fixture and never read a sibling repository working tree.

`legacy-api-disposition.json` records one reviewed `adopted`, `reworked`, or `rejected` decision for each of the 277 literal paths in the audited legacy source snapshot. It preserves source file and line evidence, exposes the source inventory's inaccurate test-exclusion claim as a caveat, and fixes the complete path set by SHA-256. `scripts/legacy-api-disposition.mjs` verifies the ledger without depending on a sibling working tree. `scripts/build-legacy-api-disposition.mjs` is a maintenance tool that refuses any source evidence file other than the reviewed SHA. A complete disposition ledger closes analysis coverage; target implementation and routing still require the independent component and browser cutover gates.
`supplemental/supp-731-disposition.json` records the per-capability decision for the historical Registry/Extension supplement. It is an adoption ledger, not permission to merge the old branch wholesale.
