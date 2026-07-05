# OAA Console Manual SubShell

Status: implemented MVP
Date: 2026-07-06
Scope: Console Manual, OAA Manual Registry, header search, plugin/manual expansion path

## Purpose

Console Manual is the human-facing surface over the same manual knowledge that OAA uses.

The important rule is that OAA and the operator must read from the same canonical manual registry. OAA should not use one private knowledge path while the Console UI uses a different help-center source.

## Implemented MVP

The MVP uses OAA Gateway as the Manual Registry API owner because the manual data already lives in Backbone PostgreSQL with pgvector.

Implemented endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/manual/sources` | List registered manual sources and authority tiers. |
| `GET /api/manual/documents?q=&source=&limit=` | List manual documents. |
| `GET /api/manual/document?sourceId=` | Return one manual document with ordered chunks and related action bindings. |
| `GET /api/manual/search?q=&limit=` | Return vector-ranked manual search hits for top header search and Manual search. |

The Console exposes these through:

| Surface | Implementation |
|---|---|
| Manual data client | `src/app/core/manual.service.ts` |
| Global header search | `src/app/core/search.service.ts` merges `ManualService.search()` into Documentation results. |
| Native route | `/manual` in `src/app/app.routes.ts` |
| Native nav item | `Manual` under the Build band in `src/app/os/os-shell.ts` |
| Manual screen | `src/app/pages/manual-shell.ts` |
| Plugin manual runtime contribution | `src/app/core/extension-host.service.ts` exposes `extensions.manual.contribute()` when a plugin has `manual:contribute`. |

## Data Model

The screen and API use the existing OAA manual model:

- `ManualSource`
- `ManualDocument`
- `ManualChunk`
- `ManualConcept`
- `ManualRelation`
- `ManualActionBinding`

`ManualDocument` and `ManualChunk` are stored in:

- `oaa_knowledge_documents`
- `oaa_knowledge_chunks`

Concept graph and action metadata are stored in:

- `oaa_manual_concepts`
- `oaa_manual_relations`
- `oaa_manual_action_bindings`

## Shell And Plugin Expansion

The MVP adds a runtime extension capability named `manual:contribute`.

When a verified plugin declares this permission, the host exposes:

```ts
ctx.extensions.manual?.contribute({
  sourceId: 'plugin:<plugin-id>',
  name: '<Plugin Name>',
  authorityTier: 3,
  language: 'mixed',
  documents: [
    {
      id: 'overview',
      title: 'Plugin Manual Overview',
      content: '...',
      route: '/p/<plugin-id>',
      sourcePath: '<plugin-id>/overview',
      documentType: 'reference',
      tags: ['plugin']
    }
  ]
});
```

The host then:

1. Stores the contribution in `ExtensionHostService.manualContributions`.
2. Adds those documents to top header Documentation search through `SearchService.queryManualContributions()`.
3. Attempts to sync the contribution into OAA Gateway through `POST /api/oaa/admin/knowledge/manual-seed`.

The sync call intentionally uses the current user's token. If the current user is not an admin, the client-side contribution remains searchable in the session, but it is not written into the canonical OAA Manual Registry.

The payload shape is:

```ts
interface ManualContributionDocument {
  id: string;
  title: string;
  content: string;
  route?: string;
  sourcePath?: string;
  documentType?: string;
  tags?: string[];
}

interface ManualContribution {
  sourceId?: string;
  name?: string;
  authorityTier?: number;
  language?: 'ko' | 'en' | 'mixed';
  documents: ManualContributionDocument[];
}
```

Plugins and subShells should eventually also register manual sources through a server-side installation-time API. The Manual Registry will ingest those sources into the same tables, making them available to:

- `/manual`
- top header search
- OAA RAG
- OAA action binding suggestions

## Search Contract

Top header search should treat Manual as part of the Documentation section.

For a query such as `10 perspective`, the path is:

```text
os-search
-> SearchService.querySectioned()
-> ManualService.search()
-> GET /api/manual/search?q=10%20perspective
-> Documentation result with path /manual?doc=<sourceId>&q=<query>
```

The result opens the Manual subShell and selects the source document.

## Remaining Work

The MVP completes the Console Manual surface, but the following items remain for the next hardening phase:

1. Add first-class `oaa_manual_sources` and `oaa_manual_sections` tables.
2. Promote `manual:contribute` into the published `@opensphere/sdk` capability set after SDK release coordination.
3. Add server-side plugin installation-time manual ingestion so plugin manuals are canonical before first runtime activation.
4. Add write UI for manual source registration beyond bundled seed and Admin Backbone paste/seed tools.
5. Add source-level ACL checks to the Manual Registry queries.
6. Add richer section anchors so search results can open an exact section, not only the document.
