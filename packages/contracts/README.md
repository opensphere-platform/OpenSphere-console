# Console contracts

This package is the machine-readable boundary for Console Web, API, CLI, OSAA, native workers, and cooperating owners. It starts with the session, authorization, audit, and operation Backbone slice and expands until every production endpoint is represented.

The TypeScript host contract was reconstructed from legacy `@opensphere/sdk` revision `0b5356db5de55c7330480f595fef9a84186426b4`. That provenance is recorded in this package's metadata and contract evidence. The contract is now versioned with Console so a Console build never reads a sibling repository's working tree. External publication or transfer to Design Kit remains a separate decision.

Contract status is explicit in `contract-denominator.json`. The current denominator contains 24 operations, 5 governed action policies, 16 JSON Schemas, and 10 Console component boundaries. `foundational-slice` means implementation may begin on those operations; it does not claim full API coverage.

`browser-api-cutover.json` is the migration denominator for the actual Console Web source. It assigns every distinct `/api` route pattern to one target component and records which browser-session capabilities remain unavailable. The verifier currently closes 121 route patterns across 15 functional families; 11 of 13 target browser-session capabilities are implemented and verified. Authenticated routes stay on the legacy session authority until all 13 capabilities are complete; public Registry and CLI artifact routes may remain independently target-routed.

`supplemental/supp-731-disposition.json` records the per-capability decision for the historical Registry/Extension supplement. It is an adoption ledger, not permission to merge the old branch wholesale.
