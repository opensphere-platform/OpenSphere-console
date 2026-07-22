# Manage design consistency audit

Date: 2026-07-22 (KST)

## Finding

`/manage/data-identity` and `/manage/change-control` were implemented with page-local header and metric styling plus Clarity's default tabs, while `/manage/platform-control` used a scoped workspace design system. That split made related Console authority pages look like separate products.

## Applied correction

- Shared the page lead, last-checked metadata, icon refresh action, six-cell status rail, overview surface, and responsive behavior through `.control-detail-page`.
- Removed Clarity's tab header/container from both specialist pages and used the same direct native `workspace-tabs` DOM and CSS anatomy as Platform Control: index, title, purpose subtitle, active surface, and accent underline.
- Moved the tab styling to one global `.workspace-tabs` rule consumed by Platform Control, Data & Identity, and Change Control; the pages no longer carry duplicate tab definitions.
- Kept the detailed information architecture intact: seven Supabase workspaces and eight Gitea workspaces remain independently addressable.
- Kept authority boundaries intact: Supabase owns Data & Identity, Gitea owns declarative change, Kubernetes reports observed runtime truth, and HIS remains an external telemetry owner.

## Evidence sequence

1. `01-platform-control.png` — accepted visual baseline; healthy.
2. `02-data-identity.png` — initial inconsistent page; local refresh/action/tab treatment.
3. `03-change-control.png` — initial inconsistent page; local refresh/action/tab treatment.
4. `04-data-identity-implemented.png` — shared header, rail, and surface applied.
5. `05-change-control-implemented.png` — shared header, rail, and surface applied.
6. `06-change-control-workspace-tabs.png` — intermediate Clarity-hosted title/subtitle tabs; follow-up mismatch found.
7. `07-data-identity-workspace-tabs.png` — intermediate matching Supabase tabs.
8. `08-platform-control-v14-reference.png` — same-window native Platform Control reference.
9. `09-change-control-native-tabs.png` — final direct native tab implementation; passed.
10. `10-change-control-dr-native-selected.png` — selected terminal workspace with the same white active surface and blue underline; passed.
11. `11-platform-control-shared-tabs.png` — final Platform Control render after the shared CSS extraction.
12. `12-change-control-shared-tabs.png` — final Change Control render from the same shared CSS; passed.

All screenshots were captured from the same authenticated Chrome window at 2705×1713. Full-view comparison and live tab interaction found no remaining P0, P1, or P2 issue. The only evidence limit is that responsive behavior was verified from the CSS breakpoint rules rather than a separate mobile screenshot in this run.
