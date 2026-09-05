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

Display the classification basis alongside the official term: product/installation unit → Module; work unit → Feature; inclusion property → Built-in Feature; executing/consumed target → Service; connection relationship → Integration; presentation addition → UI Extension. These are different classification axes, not six mutually exclusive peer product types. Label product cards as modules and contained work as features; explicitly name built-in features. Tool, Library and Reference Template describe supporting deliverables. A concrete example is Cluster Manager (Module) using Ceph management (Feature) to connect (Integration) an external Ceph (Service).

The 2026-09-06 clarification edits existing content values only. Copy keys, renderer signature, model shape and Web source remain unchanged, so only the index-content image needs publication. API, authorization and deployment topology are unaffected.

Cluster Manager's functional labels are Kubernetes 관리 / 기반 서비스 관리(HISS) / Ceph 스토리지 관리. Restore existing product implementations; do not replace them because naming changed.

## Architecture page

The real Console root page's **10P × 6L Architecture** tab explains modules as enclosing boxes and their features as smaller boxes. 10 Perspectives and six SRLs remain unchanged. They describe user/business viewpoints and realization responsibilities, not module, repository or Pod counts. Product description cards do not create live navigation or represent installation status.

`landing-module-overview.ts` is a presentation component within the existing web image, not another service. Its copy is in `architecture.copy.json`. Existing named-product descriptions remain editable in the separate content image. The new renderer key set requires a matched Web/content pair; a subsequent wording-only update can publish content alone.

## Compatibility and acceptance

Historical source names and wire contracts (`subShell`, `kind=plugin`, CRDs, `structuralRole`, routes and signed identifiers) remain unchanged. Old UI labels and explanatory names are updated separately. The content validator still enforces exact keys, fixed coordinates, bounded data, SHA-256 integrity and the reviewed renderer signature. Both images are pinned by digest in the same Console Deployment; the aggregate Console release channel is not advanced by this partial update.

Completed local verification: all 29 index/architecture tests and the Angular production build, including asset/composition checks, passed. Existing style/CommonJS warnings remain; there were no build errors.

Deployment verified on 2026-09-06 after the user's explicit publication/deployment approval: the matched Web/content pair from source `196406ad10fdd3367f3e322460c003a053e2a3a1` was published as `202609060804` under the local edge policy and deployed to the existing localhost Console. Both replicas are Ready. The served content reports that exact version/source. In the authenticated Console browser, all ten tabs rendered, all seven module cards and their feature boxes appeared, the 10P/6L axes remained, and no obsolete Architecture display names, broken images or card overflow were observed at the existing desktop viewport. These checks do not establish mobile breakpoint coverage or backend functional acceptance. The initial security-review block was resolved by the user's subsequent explicit deployment instruction.

Only the Web image and index-content init image changed. The index-content `edge` tag was advanced; the aggregate Console `edge` anchor was preserved. API, database, RBAC and other modules were not changed. This documentation follow-up does not require another image build. Do not treat this update as acceptance of HISS/Ceph operations or the complete Console installation.
