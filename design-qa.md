# Manual Oracle Systems Reference Design QA

- canonical visual reference: `https://docs.oracle.com/en/systems/`
- source visual truth: `audit-evidence/2026-07-20-oracle-manual-layout/10-oracle-systems-reference.jpg`
- implementation screenshot: `audit-evidence/2026-07-20-oracle-manual-layout/13-console-systems-flow-final-aligned.jpg`
- side-by-side comparison: `audit-evidence/2026-07-20-oracle-manual-layout/14-systems-reference-vs-console-final.jpg`
- state: authenticated Manual → `10 Perspectives`
- viewport: Oracle and OpenSphere desktop wide view

## Findings

No actionable P0/P1/P2 findings remain for the selected reference flow.

- Information architecture: the exact Oracle Systems pattern is reflected as a category hero, a persistent product index on the left, and an unboxed two-column feature grid on the right.
- Category hero: the Manual uses the measured 106px hero rhythm, a restrained gray patterned surface, a 6px pattern divider, a 12px category label, and a 32/38 serif title.
- Left navigation: the rail is 412px wide and uses 18/26 bold product links. The OpenSphere list contains the authoritative 10 Perspectives rather than Oracle product names.
- Feature grid: entries use 48px colored icon tiles, 18/25 bold teal titles, and 15/21 supporting copy with Oracle-like whitespace and no card decoration.
- Shell boundary: the OpenSphere global header, 48px application rail, and Manual-local header remain because the Manual is Console-native. The Oracle-derived content flow begins below those required shell elements.
- Assets: the existing Manual hero artwork and approved Carbon application icon are used; no substitute logo or generated illustration was introduced.

## Comparison History

### Iteration 1 — rejected reference mapping

The earlier implementation treated the Oracle documentation home and a three-column article reader as the primary target. That did not match the user-selected `https://docs.oracle.com/en/systems/` sub-hub.

### Iteration 2 — Systems structure applied

- Replaced the three-column article overview with the exact Systems hierarchy.
- Added the 106px category hero and aligned its title with the Oracle left edge after accounting for the Console application rail.
- Replaced boxed/metadata content with a 412px product index and two-column unboxed feature entries.
- Preserved OpenSphere's 10 Perspectives as content while cloning the reference's spacing, typography, icon scale, and flow.

## Implementation Checklist

- [x] Exact `/en/systems/` page used as visual source truth
- [x] Oracle-style category hero and patterned divider
- [x] 412px left product index
- [x] Two-column unboxed feature flow
- [x] 48px colored approved Carbon icon tiles
- [x] 18px bold teal titles and 15px body copy
- [x] Index-card elevation reduced to `0 1px 3px rgba(0,0,0,.08)`
- [x] Authenticated Chrome verification
- [x] Angular production build
- [x] Kubernetes rollout and 2/2 readiness verification

## Open Questions

- None blocking. Perspective detail pages continue to use the editorial reader because the selected Oracle Systems reference governs the category overview, not every downstream article type.

final result: passed
