# Data & Identity / Change Control consistency — Design QA

Date: 2026-07-22 (KST)

## Source and implementation

- Visual baseline: `docs/audit-evidence/2026-07-22-data-change-consistency/01-platform-control.png`
- Initial Data & Identity: `docs/audit-evidence/2026-07-22-data-change-consistency/02-data-identity.png`
- Initial Change Control: `docs/audit-evidence/2026-07-22-data-change-consistency/03-change-control.png`
- Intermediate aligned surfaces: `04-data-identity-implemented.png`, `05-change-control-implemented.png`
- Intermediate Clarity-hosted workspace tabs: `06-change-control-workspace-tabs.png`, `07-data-identity-workspace-tabs.png`
- Exact native-tab comparison: `08-platform-control-v14-reference.png`, `09-change-control-native-tabs.png`
- Selected terminal workspace: `10-change-control-dr-native-selected.png`
- Final shared-style comparison: `11-platform-control-shared-tabs.png`, `12-change-control-shared-tabs.png`
- Runtime: `https://localhost:8090/manage/data-identity` and `https://localhost:8090/manage/change-control`

All runtime captures were produced from the same authenticated Chrome window at 2705×1713. The captures therefore have aligned viewport dimensions and device density. The default Overview state was used for the full-view visual comparison; specialist tabs were verified separately through the accessibility tree and live interaction.

## Comparison result

- Header, last-checked metadata, compact refresh action, six-cell state rail, tab rail, content border, and panel bands now use the Platform Control hierarchy and shared Console tokens.
- The initial pages used page-local header/rail CSS and default one-line Clarity tabs. Those independent component boundaries caused the inconsistency.
- Data & Identity and Change Control now use the same native `workspace-tabs` DOM anatomy as Platform Control: direct tab buttons, two-digit index, task title, specialist subtitle, selected accent rule, and horizontal overflow at constrained widths.
- Change Control intentionally has eight specialist workspaces while Platform Control has three primary perspectives, but their visual grammar is now the same. The difference is information architecture, not styling.
- Typography, spacing, color, border, focus, and responsive behavior were inspected at full-image detail. No P0, P1, or P2 fidelity issue remains.
- No imagery was introduced. Existing Carbon icons and Console semantic colors remain the only visual assets.

## Interactions and accessibility

- Every specialist workspace remains a semantic `tab` inside a `tablist`, with the active content exposed as a `tabpanel`.
- Change Control `Supply Chain` and `DR & Contracts` activated successfully after the final tab change.
- Refresh preserved the active authenticated session and rendered state; no browser warning or error was observed.
- At narrow widths the subtitle and index are removed before the task title, and the tablist remains horizontally navigable.

## QA history

1. Initial audit found standalone refresh buttons, unframed overview content, locally styled rails, and default single-line Clarity tabs.
2. Shared header, status rail, content surface, and numbered one-line tabs were applied to both specialist pages.
3. Follow-up review found the numbered one-line Change Control tabs still did not match Platform Control's title-plus-description workspace tabs.
4. Both specialist pages were upgraded to an indexed title/subtitle anatomy, but follow-up screenshot review showed Clarity's wrapper still changed the active tab width, surface, and underline behavior.
5. The Clarity tab header/container was removed from both specialist pages and replaced with the same direct native `workspace-tabs` structure used by Platform Control.
6. The duplicated Platform Control tab CSS was removed; all three pages now consume one global `.workspace-tabs` rule, preventing the two styles from drifting again.
7. Final same-window comparison and interaction checks found no remaining high- or medium-severity design inconsistency.

## Verification

- `npm test`: 71 passed, 0 failed.
- `npm run test:security`: 34 passed, 0 failed.
- `npm run build`: passed; pre-existing bundle and component-style budget warnings remain.
- Kubernetes rollout: `opensphere-console:manage-consistency-v15`, 2/2 replicas ready.

final result: passed

---

# Platform Control Plane redesign — Design QA

Date: 2026-07-22 (KST)

## Source of truth

The redesign intentionally combines three approved visual directions as task-oriented tabs instead of discarding any direction:

- Operations: `C:\Users\cmars\.codex\generated_images\019f83a9-d008-7f52-8455-c46626b72eb5\exec-68f294fa-7639-4f6e-8b60-ba958ee1d097.png` (1487×1058)
- Evidence: `C:\Users\cmars\.codex\generated_images\019f83a9-d008-7f52-8455-c46626b72eb5\exec-c529cc6a-870f-4eca-8759-8cae90671128.png` (1487×1058)
- Change Journey: `C:\Users\cmars\.codex\generated_images\019f83a9-d008-7f52-8455-c46626b72eb5\exec-761c4b18-315e-417e-afce-e68bb79821da.png` (1487×1058)

Runtime under test: `https://localhost:8090/manage/platform-control`

## Final implementation evidence

Authenticated Chrome full-page captures at the native 2705×1713 viewport:

- `docs/audit-evidence/2026-07-22-platform-control-redesign/01-operations.png`
- `docs/audit-evidence/2026-07-22-platform-control-redesign/02-evidence.png`
- `docs/audit-evidence/2026-07-22-platform-control-redesign/03-change-journey.png`
- `docs/audit-evidence/2026-07-22-platform-control-redesign/04-data-identity.png`
- `docs/audit-evidence/2026-07-22-platform-control-redesign/05-data-identity-recovery.png`
- `docs/audit-evidence/2026-07-22-platform-control-redesign/06-change-control.png`
- `docs/audit-evidence/2026-07-22-platform-control-redesign/07-change-control-journey.png`

The reference and implementation differ in pixel dimensions, so comparisons were made using normalized composition, hierarchy, density, state semantics, and panel relationships. Each of the three source images was opened in the same visual-comparison input as its corresponding implementation capture.

## Comparison result

### Operations

- Preserves the dense authority dashboard, top state rail, Supabase/Gitea split, risk inspector, and recent governed activity structure.
- Uses live Console data: Supabase service readiness, identity/storage/audit inventory, Gitea policy, and recovery evidence.
- `No evidence` and `NotConfigured` remain neutral states rather than success.

### Evidence

- Preserves the master/detail evidence workspace: authority filters, evidence table, selected-evidence inspector, provenance chain, and recommended next step.
- Defaults selection to the first non-Verified item, making active risk visible without manufacturing an incident.
- Zero restored objects/users/repositories are rendered as `Attention required` / insufficient evidence, never `Verified`.

### Change Journey

- Preserves the three-lane Supabase → Gitea → Kubernetes relationship, policy inspector, next-action banner, and request list.
- The empty runtime state is explicit: there is no active request and the first governed change is still awaited.
- The screen does not invent PR, outbox, reconciliation, Kubernetes receipt, or HIS telemetry evidence.

### Dedicated management views

- Data & Identity keeps Supabase-specific service, identity, RLS, storage, audit, integration, and structured recovery visibility.
- Change Control keeps Gitea-specific repository, protected branch, signed-commit, direct-push, approval, webhook, supply-chain, DR, and contract visibility.
- The Gitea overview exposes `opensphere/platform-declarations`, protected `main`, signed commits required, and direct push denied.
- HIS remains an external telemetry authority and is displayed as `NotConfigured` when no binding exists; the Console does not create Prometheus/HIS resources.

## States and interactions verified

- Existing authenticated session persisted across `/manage/platform-control`, `/manage/data-identity`, and `/manage/change-control`.
- Operations, Evidence, and Change Journey tabs activated and rendered without route changes or logout.
- Data & Identity `Security & DR` and Change Control `Change Journey` tabs activated correctly.
- Live backend data loaded from both `/api/identity/supabase/status` and `/api/platform/gitea/status`.
- During the complete route/tab pass, no `pageerror` event was emitted.
- During a final Platform Control navigation and observation window, no browser `console` event or `pageerror` event was emitted.

## QA history and fixes

1. Initial comparison found Clarity's global header styling rendering panel headers black and `No evidence` using an incorrect success tone.
2. The redesign stylesheet was ordered explicitly, panel headers were normalized to the Console canvas, and evidence-free state styling was made neutral.
3. Second comparison found the Evidence/Change Journey canvas headers outside that override, initial Evidence selection prioritizing a passing row, and insufficient Gitea overview detail.
4. Canvas headers were added to the override, Evidence now selects the first non-Verified row, and the Gitea overview now exposes repository and branch/signing/direct-push policy.
5. Final captures and the full interaction pass found no remaining P0, P1, or P2 design defects.

## Verification

- `npm test`: 70 passed, 0 failed.
- `npm run test:security`: 33 passed, 0 failed.
- `npm run build`: completed successfully; existing size-budget warnings remain.
- Kubernetes rollout: `opensphere-console:platform-control-v10`, 2/2 replicas ready.

Final result: passed
