# OpenSphere Console working rules

- The active design authority is `../DESIGN/20-MODULE/OpenSphere-Console/CONSOLE-DESIGN-INDEX.md`.
- Platform-wide repository, build, GHCR, channel, design-system, security, error, naming, and source rules are inherited through that index. Do not treat archived `_DOCS_` files, bundled Manual content, old reports, or comments as current authority.
- `main` revision `0d3f56ab97b717dc1c4c8f83ce3725c69f01b20d` is historical implementation evidence. Reconstruct product contracts and verified behavior; do not preserve large routers, accumulated migrations, legacy names, direct sibling-source imports, or operational workarounds merely because they exist.
- Console owns Web/API, Registry, CLI, OS Shell, OSAA/OSDST, Extension Controller, Recovery, and Gitea bootstrap as native capabilities. Keep package, process/image, service identity, credential, data-writer, and failure boundaries separate.
- Drawer reference (user decision, 2026-09-06): follow `/manage/console-admins` and reuse `apps/console-web/src/app/os/os-panel.ts` (`OsPanel` / Clarity side panel), including for module installation. Use its title/body/`osPanelFooter` slots, remembered resize, header offset and close/focus handling; do not implement a separate page-specific dialog shell.
- New public or internal HTTP behavior requires an operation in `packages/contracts/openapi/console-v1.yaml`, referenced JSON Schema, authorization/idempotency/error semantics, and a contract test.
- New code must not read another repository's source path. Cross-repository compatibility is proven with versioned contracts and provider/consumer conformance fixtures.
- Never store private keys, PATs, service-role secrets, passwords, kubeconfig, or browser-readable refresh tokens in the repository. Test keys must be generated in a temporary directory for each test.
- Keep build, publish, promotion, deploy, and runtime verification separate. No publish, channel movement, deployment, remote write, or credential migration is implied by a code change request.
- Every implementation change maps to at least one `CON-FR-*`, C4 owner, contract/schema, runtime scenario, and acceptance gate.
- Keep the design and implementation controllable by the operating team. Do not add a repository, process, datastore, queue, framework, dependency, or abstraction for anticipated use; require a current unmet requirement and evidence that the existing boundary cannot satisfy it.
