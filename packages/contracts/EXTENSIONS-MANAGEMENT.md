# Extensions management contract — 2026-09-05

Scope: CON-FR-006, 007, 010, 014 and 017; C_WEB → C_API admission →
C_EXT/C_REG → Kubernetes observation. No new service, database or authorization
exception. Existing installation and independent approval rules are unchanged.

The five user work areas are installed features, discovery, installation/change
work, composition/connections, and settings/security. Existing deep links remain.
Cluster Manager discovery uses `/api/admin/extensions/inspect`; its request opens
the existing protected Gitea change template. The returned request ID persists in
the URL. Refresh must reopen that request rather than silently showing a different
latest request. A receipt, approval or merge alone is not installation completion.

The seven adopted C_EXT compatibility routes and existing Registry read route and JSON response fragments are in
`openapi/console-v1.yaml` and `schemas/extension-management.schema.json`.
Catalog host compatibility uses one shared bounded parser in
`packages/registry-client/host-compatibility.mjs` on C_WEB and C_EXT. It accepts
exact, caret, tilde and bounded comparator groups; it does not accept arbitrary
npm range syntax. Invalid success payloads remain contract failures. A 404 from
the optional CLIDownload API is NotConfigured; 403 and 503 remain failures.

Catalog and registration freshness are independent. Failed reads retain the
previous data explicitly as stale. Lifecycle completion requires a fresh
registration matching the receipt UID, an observed generation at least as new as
the requested generation, and the action-specific verified state. Failed,
unavailable, timeout and view destruction never produce a completion toast.

## Human release display

The C_REG inventory descriptor's `release` object may include `version`
(product SemVer when explicitly published), `artifactVersion` (KST
`yyyyMMddHHmm` build), `compatibilityVersion`, `channel`, and `imageDigest`.
Compatibility SemVer, Kubernetes resourceVersion and Git sourceRevision must
never be substituted for a missing product/build version. Missing metadata is
shown as `버전 정보 없음`; hashes remain only in expandable technical details.

For installed core components, the existing `opensphere-installation-lock`
ConfigMap may carry an additional `release-display.json` data value:

```json
{"schema":"opensphere.release-display/v1","components":{"console":{"image":"ghcr.io/opensphere-platform/opensphere-console@sha256:<64-hex>","sourceRevision":"<40-hex>","artifactVersion":"202609051810"}}}
```

This value is optional display metadata, not an installation authority. Maximum
64 KiB and 64 components. A label is used only if image and sourceRevision match
the existing execution lock and the build is a valid calendar timestamp. Bad,
missing or mismatched labels are ignored. The execution lock schema, signature,
revision hash, permissions and image selection remain unchanged. Publication
receipts, not local wall-clock guesses, supply the labels during deployment.

Product logos use the vendored OPL assets with their NOTICE. Pictograms identify
functions, not third-party brand ownership. The layout follows DESIGN-GUIDE.md
and the functional grouping of opensphere.dev; no runtime dependence on an asset
CDN is introduced.

Verification: shared parser tests, controller authority/HTTP/operation tests,
generation/UID/timeout observation tests, module-installation state tests, release
label tests, Go registry tests, contract gates, production build and, after publication, deployed UI acceptance. Deployed UI verification is currently pending.
An independently approved real module installation is a separate acceptance
step; unapproved pending requests must not be auto-approved to satisfy a test.
