# OpenSphere Console

OpenSphere Console is the operator control plane and experience host for OpenSphere. It owns the Web/API shell and the native CLI, OS Shell, OSAA/OSDST, Extension Controller, Registry, Recovery, and Gitea bootstrap capabilities as one integrated release family. Each runtime keeps its own process, identity, credential, failure, and artifact boundary.

The current implementation branch reconstructs the product from the accepted product boundaries and verified legacy behavior. Historical source remains evidence; it is not copied as the target structure.

## Authority

- Console design index: `../DESIGN/20-MODULE/OpenSphere-Console/CONSOLE-DESIGN-INDEX.md`
- Repository/build/GHCR model: `../DESIGN/06-OPERATIONS/OPERATIONS-PLATFORM-REPOSITORY-BUILD-GHCR-OPERATING-MODEL.md`
- Release channels: `../DESIGN/06-OPERATIONS/OPERATIONS-PLATFORM-RELEASE-CHANNEL-POLICY.md`
- Source authority: `../DESIGN/09-GOVERNANCE/GOVERNANCE-PLATFORM-SOURCE-AUTHORITY-POLICY.md`
- Implementation assessment: `../DESIGN/20-MODULE/OpenSphere-Console/90-EVIDENCE/CONSOLE-EVIDENCE-CURRENT-CODE-IMPLEMENTATION-ENTRY-ASSESSMENT.md`

Archived `_DOCS_` material and bundled historical manuals are evidence only. They do not override the active DESIGN tree.

## Target repository structure

```text
apps/                 independently runnable Console-native applications
cmd/                  native command-line programs
packages/contracts/   OpenAPI, JSON Schema, owner/consumer contracts, shared types
migrations/           reconstructed baseline and append-only version migrations
deploy/               base manifests and environment overlays
src/                   legacy Angular application during controlled migration
backend/               legacy runtime implementations during controlled migration
```

`src/` and `backend/` remain migration sources until each capability passes its new contract and acceptance gate. New cross-capability contracts belong in `packages/contracts`; new code must not import another repository's source tree.

The first `apps/console-api` slice implements opaque session/CSRF resolution, current permission and revoke checks, governed Registry action intake, C_REG-backed Extension inspection and install planning, independent-person approval, and atomic operation/audit/outbox persistence. The retained `backend/registry` process emits fully bound exact-digest Extension candidates. The separate `apps/extension-controller` process still claims only exact-digest revocation actions with a bounded lease and fencing epoch and records an `Applied` execution receipt. These processes run alongside the legacy Backend until install execution, remaining Owner actions, credential broker, route coverage, projection verification, and cutover gates are complete.

## Local validation

```powershell
npm ci --no-audit --no-fund --legacy-peer-deps
npm run verify:contracts
npm test
npm run build -- --configuration production
```

The full legacy test suite still contains migration targets. `npm run verify:contracts` is the first self-contained gate and must remain green without sibling repository source.

Build, publish, promotion, deployment, and runtime verification are distinct operations. A successful local build does not authorize GHCR publication or deployment.
