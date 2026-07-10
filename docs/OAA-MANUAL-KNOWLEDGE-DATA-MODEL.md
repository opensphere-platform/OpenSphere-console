# OAA Manual Knowledge Data Model

Status: draft v0.2
Date: 2026-07-04
Scope: OpenSphere AI Agent(OAA), OpenSphere manuals, Backbone PostgreSQL + pgvector

Governance note: Manual contribution, authority and Shell integration follow
[`CONSTITUTION-0003` §14](../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0003-SHELL-HOSTING-INTEGRATION.md#14-manual과-search-연결).
The current implementation exposes the OAA manual knowledge store through `/api/manual/*`,
the top-header Documentation search section, and the registered `/p/manual` subShell.

## 1. Goal

OAA must not treat OpenSphere manuals as loose text. A manual is operational knowledge with authority, version, navigation context, product scope, and source evidence.

The manual knowledge model therefore has four required layers:

1. `ManualSource`: where the manual came from.
2. `ManualDocument`: one authoritative document or article.
3. `ManualSection`: stable semantic sections inside a document.
4. `ManualChunk`: retrieval-sized text blocks stored in pgvector.

It also has two optional but important semantic layers:

5. `ManualConcept`: named OpenSphere concepts such as the 10 Perspectives, architecture planes, service tiers, policies, and product vocabulary.
6. `ManualRelation`: explicit links between concepts, documents, sections, tools, APIs, menus, and runtime resources.

The key decision is this: OAA should not manage manuals as only vectorized text. It should manage manuals as a small knowledge graph backed by PostgreSQL rows, with pgvector used as the retrieval index for natural-language lookup.

For MVP, `ManualDocument` and `ManualChunk` are stored in the existing OAA tables:

- `oaa_knowledge_documents`
- `oaa_knowledge_chunks`

The remaining structure is stored in `metadata` JSON. Later, the same fields can be promoted into normalized tables without changing the chat contract.

This means a question like "What is OpenSphere 10 Perspective?" should resolve through this path:

```text
user question
-> vector search over ManualChunk
-> concept lookup for matching ManualConcept IDs
-> authority conflict resolution by source tier
-> answer with citations
-> optional action binding proposal if the matched manual section describes an executable operation
```

## 2. Canonical IDs

Every manual object needs a stable ID that can survive title changes.

Recommended format:

```text
manual:<source>:<path-or-route-slug>
manual-section:<document-id>#<section-slug>
manual-chunk:<document-id>#<chunk-index>
```

Examples:

```text
manual:docs:01-constitution/open-sphere-constitution
manual:console-docs:backbone-architecture
manual:help-center:perspectives
manual-section:manual:help-center:perspectives#10-perspectives
```

## 3. ManualSource

`ManualSource` describes a repository, Help Center app, Git path, or managed CMS channel.

```ts
interface ManualSource {
  id: string;
  type: 'repo' | 'help-center' | 'cms' | 'git' | 'api' | 'upload';
  name: string;
  basePath?: string;
  baseUrl?: string;
  owner?: string;
  authorityTier: 0 | 1 | 2 | 3 | 4;
  defaultNamespace: string;
  defaultLanguage: 'ko' | 'en' | 'mixed';
  refreshMode: 'manual' | 'scheduled' | 'webhook' | 'release-bound';
}
```

Authority tier:

| Tier | Meaning | Example |
|---:|---|---|
| 0 | Constitution / invariant authority | `_DOCS_/01-CONSTITUTION/*` |
| 1 | Architecture / ADR authority | `_DOCS_/20-*`, `_DOCS_/10-*` |
| 2 | Product/manual authority | `OpenSphere-shell-menual`, Help Center articles, registered `manual` subShell |
| 3 | Implementation notes / audit / runbook | `OpenSphere-console/docs/*`, audit docs |
| 4 | Temporary imported notes | admin pasted documents |

Retrieval must prefer lower tier numbers when two sources conflict.

## 4. ManualDocument

`ManualDocument` maps to one row in `oaa_knowledge_documents`.

```ts
interface ManualDocument {
  namespace: 'opensphere' | string;
  sourceType: 'manual';
  sourceId: string;
  title: string;
  version?: string;
  content: string;
  metadata: ManualDocumentMetadata;
}

interface ManualDocumentMetadata {
  schema: 'manual.opensphere.io/v1alpha1';
  source: ManualSourceRef;
  documentType: 'concept' | 'howto' | 'reference' | 'runbook' | 'adr' | 'policy' | 'api' | 'troubleshooting';
  authorityTier: 0 | 1 | 2 | 3 | 4;
  status: 'draft' | 'active' | 'deprecated' | 'superseded';
  language: 'ko' | 'en' | 'mixed';
  route?: string;
  sourcePath?: string;
  sourceUrl?: string;
  perspective?: OpenSpherePerspective[];
  plane?: OpenSpherePlane[];
  component?: string[];
  audience?: ('admin' | 'developer' | 'operator' | 'architect' | 'support' | 'end-user')[];
  tags?: string[];
  aliases?: string[];
  replaces?: string[];
  replacedBy?: string;
  acl?: ManualAcl;
  checksum?: string;
}

interface ManualSourceRef {
  id: string;
  type: ManualSource['type'];
  name: string;
}

interface ManualAcl {
  visibility: 'public' | 'authenticated' | 'admin' | 'restricted';
  groups?: string[];
}
```

`OpenSpherePerspective` should use the OpenSphere 10 Perspective IDs:

```ts
type OpenSpherePerspective =
  | 'main-shell'
  | 'base-substrate'
  | 'k8s-cluster-ceph'
  | 'user-auth'
  | 'developer'
  | 'ai-level'
  | 'api-information-flow'
  | 'workspace-internal'
  | 'customer'
  | 'external-edge-service'
  | 'website';
```

`OpenSpherePlane` should use the architecture plane IDs:

```ts
type OpenSpherePlane =
  | 'p0-host-substrate'
  | 'p1-control'
  | 'p2-foundation'
  | 'p3-service'
  | 'p4-intelligence'
  | 'p5-catalog-store'
  | 'p6-experience'
  | 'p7-access-edge';
```

## 4.1 ManualConcept

`ManualConcept` is the canonical structure for OpenSphere-specific knowledge that a generic LLM cannot already know. The 10 Perspective model should be stored here, then linked back to the manual sections that define it.

```ts
interface ManualConcept {
  id: string;
  namespace: 'opensphere' | string;
  type:
    | 'perspective'
    | 'architecture-plane'
    | 'service-tier'
    | 'product-area'
    | 'policy'
    | 'api'
    | 'cli'
    | 'menu'
    | 'runtime-resource'
    | 'term';
  name: string;
  aliases?: string[];
  summary: string;
  definition: string;
  authorityTier: 0 | 1 | 2 | 3 | 4;
  status: 'draft' | 'active' | 'deprecated' | 'superseded';
  sourceIds: string[];
  sectionIds?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}
```

For the OpenSphere 10 Perspective, each perspective should be one `ManualConcept`:

| Concept ID | Type | Purpose |
|---|---|---|
| `concept:opensphere:perspective:main-shell` | `perspective` | Main shell / user-facing operating frame |
| `concept:opensphere:perspective:base-substrate` | `perspective` | Backbone, storage, base platform layer |
| `concept:opensphere:perspective:k8s-cluster-ceph` | `perspective` | Cluster and storage substrate |
| `concept:opensphere:perspective:user-auth` | `perspective` | Identity, auth, tenant and access model |
| `concept:opensphere:perspective:developer` | `perspective` | Developer workflow and build/deploy model |
| `concept:opensphere:perspective:ai-level` | `perspective` | OAA, AI gateway, knowledge and automation model |
| `concept:opensphere:perspective:api-information-flow` | `perspective` | API, event, data and information flow |
| `concept:opensphere:perspective:workspace-internal` | `perspective` | Internal workspace and operating context |
| `concept:opensphere:perspective:customer` | `perspective` | Customer-facing usage and support context |
| `concept:opensphere:perspective:external-edge-service` | `perspective` | Edge, external service and integration boundary |
| `concept:opensphere:perspective:website` | `perspective` | Website and public surface |

Note: if OpenSphere formally treats this as exactly 10 perspectives, the source manual must resolve whether `website` is part of the ten or a separate public-surface perspective. OAA should not guess; it should follow the tier-0 or tier-1 manual source.

## 4.2 ManualRelation

`ManualRelation` makes the manual navigable by meaning, not only by text similarity.

```ts
interface ManualRelation {
  id: string;
  namespace: 'opensphere' | string;
  fromId: string;
  toId: string;
  relation:
    | 'defines'
    | 'belongs-to'
    | 'depends-on'
    | 'supersedes'
    | 'conflicts-with'
    | 'implemented-by'
    | 'exposed-at'
    | 'controlled-by'
    | 'observed-by'
    | 'documented-in'
    | 'requires-permission';
  confidence: 'manual' | 'derived' | 'inferred';
  authorityTier: 0 | 1 | 2 | 3 | 4;
  sourceId: string;
  sectionId?: string;
  metadata?: Record<string, unknown>;
}
```

Examples:

| From | Relation | To |
|---|---|---|
| `concept:opensphere:perspective:ai-level` | `documented-in` | `manual-section:console-docs/oaa-manual-knowledge-data-model#goal` |
| `concept:opensphere:service:oaa-gateway` | `belongs-to` | `concept:opensphere:perspective:ai-level` |
| `concept:opensphere:service:oaa-gateway` | `implemented-by` | `tool:oaa.environment.read` |
| `manual-action:opensphere:oaa-gateway-restart` | `requires-permission` | `role:opensphere-admins` |

## 5. ManualSection

`ManualSection` is not necessarily a separate MVP table. It is a logical structure used during ingestion and stored in chunk metadata.

```ts
interface ManualSection {
  id: string;
  documentId: string;
  heading: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  order: number;
  anchor: string;
  parentSectionId?: string;
  text: string;
  tags?: string[];
}
```

Section IDs must be stable enough to support citation:

```text
manual-section:manual:console-docs:backbone-architecture#oaa-consumer
```

## 6. ManualChunk

`ManualChunk` maps to one row in `oaa_knowledge_chunks`.

```ts
interface ManualChunk {
  documentId: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata: ManualChunkMetadata;
}

interface ManualChunkMetadata {
  schema: 'manual-chunk.opensphere.io/v1alpha1';
  title: string;
  namespace: string;
  sourceType: 'manual';
  sourceId: string;
  sectionId?: string;
  sectionHeading?: string;
  route?: string;
  sourcePath?: string;
  sourceUrl?: string;
  authorityTier: 0 | 1 | 2 | 3 | 4;
  perspective?: OpenSpherePerspective[];
  plane?: OpenSpherePlane[];
  component?: string[];
  tags?: string[];
  embedding: {
    mode: 'provider' | 'hash';
    provider: string;
    model: string;
    keyId?: string;
    latencyMs?: number;
  };
}
```

Chunking rule:

- Preserve headings in each chunk.
- Target 800-1,200 characters per chunk for manuals.
- Never merge unrelated top-level sections.
- Store citation metadata on every chunk.
- When two documents conflict, prefer lower `authorityTier`, then newer `version`, then `updated_at`.

## 7. Retrieval Contract

OAA answer generation must receive both chunk text and citation metadata.

Minimal retrieval result:

```ts
interface ManualRetrievalHit {
  title: string;
  sourceId: string;
  sourceType: 'manual';
  sectionHeading?: string;
  route?: string;
  sourcePath?: string;
  authorityTier: number;
  content: string;
  score: number;
}
```

OAA should answer using this rule:

1. If relevant manual chunks exist, answer from them and cite title/source.
2. If live environment contradicts manual text, say the manual says one thing but live state currently differs.
3. If no manual chunk is found, say what manual/source is missing instead of inventing OpenSphere-specific facts.

### Operational Answer Contract

For operational questions, OAA must treat manuals and live cluster inspection as different evidence classes.

Operational questions include installation, preflight, plugin lifecycle, Kubernetes runtime state, Backbone, Foundation, Samba-AD, OpenSearch, and OAA Gateway troubleshooting.

OAA must answer in four parts when the question asks what is happening now or what an admin should do:

1. `확인한 현재 클러스터 사실`: values confirmed from the live environment snapshot or read-only tool results.
2. `문서 기반 판단`: design/runbook interpretation from manual chunks and concept relations.
3. `필요한 조치`: recommended next steps, with read-only checks first.
4. `승인 필요한 작업`: any write/apply/install/delete/restart/scale action that requires admin approval and the owning control-plane authority.

OAA must not infer current namespaces, pods, services, deployments, CRDs, readiness, install state, or action results from manuals alone. If live inspection is unavailable or incomplete, OAA must say exactly which fact was not verified.

OAA may draft a Claim, Binding, manifest, command, or action proposal, but must not say it was applied unless an explicit action endpoint result is present in the conversation. Manual evidence gives permission to propose an action; it does not prove the action already happened.

Samba-AD identity-directory preflight is the reference case:

- Generic `FoundationClaim`/`FoundationBinding` CRDs may exist, but they do not by themselves satisfy the typed identity directory contract.
- Samba-AD consumer access requires the typed `IdentityDirectoryClaim`/`IdentityDirectoryBinding` contract and its reconciler to be ready.
- Crossplane core/provider readiness is a separate prerequisite. It can be `PASS` while the typed identity directory contract is still `BLOCK`.
- Keycloak namespace, service name, and current readiness must be read from the live cluster before OAA mentions them as current facts.
- Applying the typed contract or installing Samba-AD remains a Foundation write-path operation requiring admin approval.

## 8. Control Binding Model

Manual knowledge must not stop at explanation. Some manual sections describe actions that OAA can perform through OpenSphere APIs, CLI commands, Kubernetes APIs, SQL, or UI automation. Those sections need an explicit binding between the manual text and the allowed control surface.

This binding is intentionally separate from `ManualChunk`. A chunk tells OAA what is true. An action binding tells OAA what it may do, which tool performs it, which permission is required, and when human confirmation is mandatory.

```ts
interface ManualActionBinding {
  id: string;
  namespace: 'opensphere' | string;
  sourceId: string;
  sectionId?: string;
  title: string;
  intent:
    | 'inspect'
    | 'diagnose'
    | 'configure'
    | 'restart'
    | 'scale'
    | 'rotate-secret'
    | 'deploy'
    | 'rollback'
    | 'ingest-knowledge';
  toolId: string;
  controlPlane: 'opensphere-api' | 'oaa-gateway' | 'kubernetes-api' | 'opensphere-cli' | 'sql' | 'ui';
  riskLevel: 'read' | 'low' | 'medium' | 'high' | 'break-glass';
  confirmation: 'none' | 'required' | 'two-step' | 'ticket-required';
  preflightToolIds?: string[];
  rollbackToolId?: string;
  requiredInputs: JsonSchema;
  permission: {
    roles: string[];
    scopes: string[];
    namespaceScope?: string[];
  };
  audit: {
    eventType: string;
    targetTemplate: string;
  };
  citations: {
    sourceId: string;
    sectionId?: string;
    sourcePath?: string;
  }[];
}
```

Examples:

| Manual intent | Tool ID | Control plane | Risk | Confirmation |
|---|---|---|---|---|
| Read environment snapshot | `oaa.environment.read` | `oaa-gateway` | `read` | `none` |
| Inspect pods in namespace | `oaa.k8s.pods.list` | `kubernetes-api` | `read` | `none` |
| Read recent logs | `oaa.k8s.logs.tail` | `kubernetes-api` | `read` | `none` |
| Restart deployment | `oaa.k8s.deployment.restart` | `kubernetes-api` | `medium` | `required` |
| Scale deployment | `oaa.k8s.deployment.scale` | `kubernetes-api` | `medium` | `required` |
| Rotate LLM key | `oaa.llm-key.rotate` | `oaa-gateway` | `high` | `two-step` |

OAA must follow this execution rule:

1. Retrieve the relevant manual chunks.
2. Identify matching action bindings, if any.
3. Read live state before proposing a write action.
4. Explain the intended action with cited manual evidence.
5. Require the configured confirmation phrase for any non-read action.
6. Execute only through the bound tool, never through ad hoc shell text.
7. Write an audit event containing user, tool ID, target, input hash, result, and cited manual source.

## 9. Tool Capability Registry

Action bindings reference tools by `toolId`. The tool registry is the machine-readable catalog of what OAA can actually do in the current OpenSphere environment.

```ts
interface OaaToolCapability {
  id: string;
  name: string;
  description: string;
  version: string;
  channel: 'api' | 'cli' | 'kubernetes' | 'sql' | 'ui';
  readOnly: boolean;
  endpoint?: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
  };
  command?: {
    binary: 'os' | 'kubectl' | 'psql' | string;
    argvTemplate: string[];
  };
  kubernetes?: {
    verbs: string[];
    apiGroups: string[];
    resources: string[];
    namespaces: string[];
  };
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  permission: {
    roles: string[];
    scopes: string[];
  };
  confirmation: ManualActionBinding['confirmation'];
  auditEventType: string;
}
```

For MVP, the OAA Gateway can expose this registry from code because the available tools are static and controlled by RBAC. Later it should be stored in PostgreSQL so plugins and service tiers can register their own capabilities.

The first registry entries should cover:

- `oaa.environment.read`
- `oaa.k8s.pods.list`
- `oaa.k8s.services.list`
- `oaa.k8s.events.list`
- `oaa.k8s.logs.tail`
- `oaa.k8s.resource.describe`
- `oaa.k8s.deployment.rollout`
- `oaa.k8s.deployment.restart`
- `oaa.k8s.deployment.scale`
- `oaa.knowledge.search`
- `oaa.knowledge.ingest-manual`

## 10. Normalized Storage Target

The current MVP stores manual structure in JSON metadata. That is acceptable while the corpus is small. Once OAA starts executing actions from manuals, the following tables should be promoted to first-class storage:

```sql
CREATE TABLE oaa_manual_sources (
  id text PRIMARY KEY,
  type text NOT NULL,
  name text NOT NULL,
  base_path text,
  base_url text,
  authority_tier int NOT NULL,
  default_namespace text NOT NULL,
  default_language text NOT NULL,
  refresh_mode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oaa_manual_sections (
  id text PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES oaa_knowledge_documents(id) ON DELETE CASCADE,
  heading text NOT NULL,
  level int NOT NULL,
  section_order int NOT NULL,
  anchor text NOT NULL,
  parent_section_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE oaa_manual_concepts (
  id text PRIMARY KEY,
  namespace text NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  summary text NOT NULL,
  definition text NOT NULL,
  authority_tier int NOT NULL,
  status text NOT NULL,
  source_ids text[] NOT NULL DEFAULT '{}',
  section_ids text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oaa_manual_relations (
  id text PRIMARY KEY,
  namespace text NOT NULL,
  from_id text NOT NULL,
  to_id text NOT NULL,
  relation text NOT NULL,
  confidence text NOT NULL,
  authority_tier int NOT NULL,
  source_id text NOT NULL,
  section_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oaa_tool_capabilities (
  id text PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  channel text NOT NULL,
  read_only boolean NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oaa_manual_action_bindings (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  section_id text,
  tool_id text NOT NULL REFERENCES oaa_tool_capabilities(id),
  intent text NOT NULL,
  risk_level text NOT NULL,
  confirmation text NOT NULL,
  required_inputs jsonb NOT NULL,
  permission jsonb NOT NULL,
  audit jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Until these tables exist, `ManualDocumentMetadata` and `ManualChunkMetadata` may include an optional `actions` array with compact action binding IDs:

```ts
interface ManualDocumentMetadata {
  // ...
  actions?: string[];
}

interface ManualChunkMetadata {
  // ...
  actions?: string[];
}
```

## 11. MVP Storage Mapping

### `oaa_knowledge_documents`

| Column | Manual field |
|---|---|
| `namespace` | `ManualDocument.namespace` |
| `source_type` | always `manual` |
| `source_id` | `ManualDocument.sourceId` |
| `title` | `ManualDocument.title` |
| `version` | `ManualDocument.version` |
| `metadata` | `ManualDocumentMetadata` |
| `content_hash` | SHA-256 of normalized content |

### `oaa_knowledge_chunks`

| Column | Manual field |
|---|---|
| `document_id` | FK to document |
| `chunk_index` | order in document |
| `content` | chunk text |
| `embedding` | provider or local hash vector |
| `metadata` | `ManualChunkMetadata` |

## 12. Seed Manifest Format

The initial automated ingestion format should be JSON:

```json
{
  "schema": "manual-seed.opensphere.io/v1alpha1",
  "source": {
    "id": "console-docs",
    "type": "repo",
    "name": "OpenSphere Console Docs",
    "basePath": "docs",
    "authorityTier": 3,
    "defaultNamespace": "opensphere",
    "defaultLanguage": "mixed",
    "refreshMode": "release-bound"
  },
  "documents": [
    {
      "sourceId": "console-docs/backbone-architecture",
      "title": "Backbone Architecture",
      "version": "2026-07-04",
      "sourcePath": "docs/BACKBONE-ARCHITECTURE.md",
      "documentType": "reference",
      "authorityTier": 3,
      "perspective": ["base-substrate", "api-information-flow"],
      "plane": ["p2-foundation", "p6-experience"],
      "component": ["backbone", "postgresql", "oaa-gateway"],
      "tags": ["backbone", "pgvector", "oaa"],
      "content": "..."
    }
  ],
  "concepts": [
    {
      "id": "concept:opensphere:perspective:ai-level",
      "type": "perspective",
      "name": "AI Level",
      "aliases": ["OAA perspective", "AI layer"],
      "summary": "OpenSphere perspective for AI gateway, knowledge, agent and automation capabilities.",
      "definition": "The AI Level perspective describes how OpenSphere AI Agent, model providers, manual knowledge, action bindings and automation tools are governed and operated.",
      "authorityTier": 1,
      "status": "active",
      "sourceIds": ["console-docs/oaa-manual-knowledge-data-model"],
      "sectionIds": ["manual-section:console-docs/oaa-manual-knowledge-data-model#goal"],
      "tags": ["oaa", "ai", "perspective"]
    }
  ],
  "relations": [
    {
      "id": "relation:opensphere:oaa-gateway:belongs-to:ai-level",
      "fromId": "concept:opensphere:service:oaa-gateway",
      "relation": "belongs-to",
      "toId": "concept:opensphere:perspective:ai-level",
      "confidence": "manual",
      "authorityTier": 1,
      "sourceId": "console-docs/oaa-manual-knowledge-data-model"
    }
  ]
}
```

The manifest may also include action bindings:

```json
{
  "actionBindings": [
    {
      "id": "manual-action:backbone:restart-oaa-gateway",
      "sourceId": "console-docs/backbone-architecture",
      "sectionId": "manual-section:console-docs/backbone-architecture#oaa-gateway",
      "intent": "restart",
      "toolId": "oaa.k8s.deployment.restart",
      "riskLevel": "medium",
      "confirmation": "required"
    }
  ]
}
```

## 13. Admin UI Implications

Backbone > OAA Gateway > Knowledge Store should evolve from a free text form into three modes:

1. Manual paste: current MVP form.
2. Manual seed: upload or trigger a `manual-seed` manifest.
3. Repository sync: ingest selected paths from `_DOCS_`, `OpenSphere-console/docs`, `OpenSphere-shell-menual`, and signed subShell manual contributions.

The UI must display:

- title
- source type/id
- authority tier
- document type
- perspective/plane/component tags
- chunk count
- embedding mode/provider/model
- last updated time

The UI should also show action-capable manual sections separately from passive reference material. A human operator must be able to see which manual section gives OAA permission to propose a write action.

## 14. Near-Term OpenSphere Sources

Recommended ingestion order:

1. `_DOCS_/01-CONSTITUTION/*`: tier 0
2. `_DOCS_/README.md`, `_DOCS_/00-전체그림.md`: tier 1
3. `_DOCS_/02-평면설계/*`: tier 1
4. `OpenSphere-console/docs/BACKBONE-ARCHITECTURE.md`: tier 3
5. `OpenSphere-console/docs/OAA-BACKBONE-IMPLEMENTATION-PLAN.md`: tier 3
6. `OpenSphere-shell-menual/src/app/docs.ts`: tier 2 Help Center source

`OpenSphere-shell-menual/src/app/docs.ts` should eventually be converted from UI-local TypeScript data into a shared manual seed or API source so the Help Center, the registered `/p/manual` subShell, and OAA use the same canonical content.
