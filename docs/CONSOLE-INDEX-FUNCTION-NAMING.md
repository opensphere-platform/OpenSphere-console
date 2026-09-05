# Console index: module and feature naming

Accepted by the user on 2026-09-06. Scope: CON-FR-014/017, C_WEB and the read-only Console index content component. This decision changes explanatory names, not ownership, authorization, API routes or deployment topology.

## Current names

- **Module / 모듈**: a product unit whose version, installation, update and operating state are managed. Console is also a module. A module can run in several containers.
- **Feature / 기능**: work performed inside a module.
- **Built-in feature / 내장 기능**: a feature included with its module. R2D2, OS Shell, Registry, CLI, Recovery and Extension Controller remain native Console capabilities; separate processes do not make them independent products.
- **Service / 서비스**: an executing/consumed service, such as Supabase, Gitea or PostgreSQL.
- **Integration / 연동**: a connection between systems.
- **UI extension / 화면 확장**: a page, panel, banner, status or owner action entry point. Presentation alone grants no independent data or execution authority.
- Setup CLI is a **tool**; Design Kit/SDK are **libraries**.

Extensions remains the existing discovery/installation/management menu. It is not a product type. Product names remain Console, Cluster Manager, Foundation, Developer, AI Workbench, Pulse and Workspace. Their work categories are navigation descriptions, not new execution layers or claims of implementation readiness.

Cluster Manager's functional labels are Kubernetes 관리 / 기반 서비스 관리(HISS) / Ceph 스토리지 관리. Restore existing product implementations; do not replace them because naming changed.

## Architecture page

The real Console root page's **10P × 6L Architecture** tab explains modules as enclosing boxes and their features as smaller boxes. 10 Perspectives and six SRLs remain unchanged. They describe user/business viewpoints and realization responsibilities, not module, repository or Pod counts. Product description cards do not create live navigation or represent installation status.

`landing-module-overview.ts` is a presentation component within the existing web image, not another service. Its copy is in `architecture.copy.json`. Existing named-product descriptions remain editable in the separate content image. The new renderer key set requires a matched Web/content pair; a subsequent wording-only update can publish content alone.

## Compatibility and acceptance

Historical source names and wire contracts (`subShell`, `kind=plugin`, CRDs, `structuralRole`, routes and signed identifiers) remain unchanged. Old UI labels and explanatory names are updated separately. The content validator still enforces exact keys, fixed coordinates, bounded data, SHA-256 integrity and the reviewed renderer signature. Both images are pinned by digest in the same Console Deployment; the aggregate Console release channel is not advanced by this partial update.

Completed local verification: all 29 index/architecture tests and the Angular production build, including asset/composition checks, passed. Existing style/CommonJS warnings remain; there were no build errors.

Pending acceptance: publish the matched Web/content pair, deploy to the existing localhost Console, and verify browser rendering of the module/feature boxes, all seven modules, unchanged ten tabs and 10P/6L, readable layout, and no content compatibility error. The automatic security review blocked the remote main push; this source change has not been published or deployed. Do not treat this update as acceptance of HISS/Ceph operations or the complete Console installation.
