# Contributing to OpenSphere Console

Read `AGENTS.md`, `README.md`, and `../DESIGN/20-MODULE/OpenSphere-Console/CONSOLE-DESIGN-INDEX.md` before changing the repository.

Use one branch per reviewable change. A pull request must identify the affected requirement, C4 component, contract operation, acceptance scenario, and component image set. New HTTP operations require OpenAPI and JSON Schema changes before implementation. New processes require an entrypoint, service identity, credential boundary, health contract, tests, and affected-image declaration.

Run the local validation denominator:

```text
npm ci --legacy-peer-deps --no-audit --no-fund
npm run verify:contracts
npm test
npm run build -- --configuration production
```

Run `go test ./...` in `cmd/os-cli` and `backend/registry` when those components change. Pull requests do not publish images or move channels. Publication and deployment require their dedicated protected workflows and approvals.

Do not import sibling repository source paths. Cross-repository behavior is consumed through a versioned contract, immutable artifact, or conformance fixture. Archived `_DOCS_` content is historical evidence and cannot authorize implementation behavior.
