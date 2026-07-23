# OAA Manual Knowledge Data Model

Status: implementation contract v0.8
Date: 2026-07-23
Scope: OpenSphere AI Agent(OAA), OpenSphere manuals, Supabase PostgreSQL + pgvector, Console control plane

Product ownership: Manual UI, canonical Help Center documents, release seed and lifecycle are owned exclusively by `OpenSphere-console`. OAA Gateway provides the Console-owned durable registry/search execution boundary; it is not a separate Manual product owner. See `MANUAL-OWNERSHIP.md`.

Governance note: Manual contribution, authority and Shell integration follow
[`CONSTITUTION-0003` §14](../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0003-SHELL-HOSTING-INTEGRATION.md#14-manual과-search-연결).
The current implementation exposes the OAA manual knowledge store through `/api/manual/*`,
the top-header Documentation search section, and the Console-native `/manual` page.

## 1. Goal

OAA must not treat OpenSphere manuals as loose text. A manual is operational knowledge with authority, version, navigation context, product scope, and source evidence.

The manual knowledge model therefore has four required layers:

1. `ManualSource`: where the manual came from.
2. `ManualDocument`: one authoritative document or article.
3. `ManualSection`: stable semantic sections inside a document.
4. `ManualChunk`: retrieval-sized text blocks stored in Supabase pgvector.

It also has two optional but important semantic layers:

5. `ManualConcept`: named OpenSphere concepts such as the 10 Perspectives, architecture planes, service tiers, policies, and product vocabulary.
6. `ManualRelation`: explicit links between concepts, documents, sections, tools, APIs, menus, and runtime resources.

The key decision is this: OAA should not manage manuals as only vectorized text. It should manage manuals as a small knowledge graph backed by Supabase PostgreSQL rows, with pgvector used as the retrieval index for natural-language lookup.

For the current implementation, `ManualDocument` and `ManualChunk` are stored in the migration-owned `oaa` schema:

- `oaa_knowledge_documents`
- `oaa_knowledge_chunks`

`document`, `document_version`, `section`, `embedding_model`, `embedding`, `concept`, `concept_relation`, `tool_capability`, and `action_binding` are also normalized in the same schema. The serving tables preserve the existing Console Manual/search contract while sources are migrated.

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
manual:console-docs:platform-control-plane-v2
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
| 2 | Product/manual authority | Manual Registry seed/canonical docs, Help Center articles (legacy `OpenSphere-shell-menual` source retired after migration verification) |
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
| `concept:opensphere:perspective:base-substrate` | `perspective` | Host, storage, and base platform layer |
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
manual-section:manual:console-docs:platform-control-plane-v2#oaa
```

## 6. ManualChunk

`ManualChunk` maps to one row in `oaa_knowledge_chunks`.

```ts
interface ManualChunk {
  id: string;
  documentId: string;
  documentRevision: string; // SHA-256 of the complete document content
  active: boolean;
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
    mode: 'provider' | 'lexical';
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
- Never overwrite or delete chunk content that has been used by `retrieval_trace`.
- Insert updated content under a new `documentRevision`, then atomically switch `active` to the new revision.
- Lexical fallback uses PostgreSQL `tsvector`; it must never manufacture a hash vector and call it semantic evidence.

### 6.1 Revision and refresh lifecycle

`oaa_knowledge_chunks` is a content-addressed serving projection. A document refresh writes
`(document_id, document_revision, chunk_index)` rows and marks only that revision active. Older
revisions remain immutable so an audit can reconstruct the exact evidence used by an earlier answer.
Removing a release-bound manual retires the document and deactivates its chunks; it does not delete
rows referenced by evidence.

Unchanged releases update document metadata without re-embedding or rewriting chunk rows. This makes
two Gateway replicas safe during rolling deployment and prevents a release restart from creating
duplicate semantic work.

## 7. Retrieval Contract

OAA answer generation must receive both chunk text and citation metadata.

Minimal retrieval result:

```ts
interface ManualRetrievalHit {
  documentId: string;
  chunkId: string;
  documentRevision: string;
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

Operational questions include installation, preflight, plugin lifecycle, Kubernetes runtime state, Data & Identity, Change Control, Foundation, Samba-AD, OpenSearch, and OAA Gateway troubleshooting.

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
    | 'apply'
    | 'delete'
    | 'update'
    | 'run'
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
| Query redacted centralized logs | `oaa.observability.logs.query` | `cluster-manager-his-owner-facade` | `read` | `none` |
| Query sanitized distributed traces | `oaa.observability.traces.query` | `cluster-manager-his-owner-facade` | `read` | `none` |
| Restart deployment | `oaa.k8s.deployment.restart` | `kubernetes-api` | `medium` | `required` |
| Scale deployment | `oaa.k8s.deployment.scale` | `kubernetes-api` | `medium` | `required` |
| Inspect an allowlisted Kubernetes resource | `oaa.k8s.resources.list` / `oaa.k8s.resource.get` | `kubernetes-api` | `read` | `none` |
| Update a workload image by immutable digest | `oaa.k8s.workload.update-image` | `kubernetes-api` | `high` | `required` |
| Apply an allowlisted desired-state manifest | `oaa.k8s.resource.apply` | `kubernetes-api` | `high` | `required` |
| Protected resource deletion | `oaa.k8s.resource.delete` | `kubernetes-api` | `critical` | `required` |
| Run or suspend a CronJob | `oaa.k8s.cronjob.run` / `oaa.k8s.cronjob.suspend` | `kubernetes-api` | `high` | `required` |
| Inspect all control-plane owners | `oaa.control-plane.status` | `opensphere-api` | `read` | `none` |
| Search canonical catalog topology | `oaa.catalog.entities.list` | `opensphere-api` | `read` | `none` |
| Read Foundation owner state | `oaa.foundation.status` | `foundation-owner-facade` | `read` | `none` |
| Enable/disable a Foundation engine | `oaa.foundation.engine.lifecycle` | `foundation-owner-facade` | `critical` | `required` |
| Create/release a parameter-free Foundation claim | `oaa.foundation.claim.create` / `oaa.foundation.claim.release` | `foundation-owner-facade` | `high/critical` | `required` |
| Create/release a typed Samba-AD directory claim | `oaa.foundation.identity-directory.claim.create` / `oaa.foundation.identity-directory.claim.release` | `foundation-owner-facade` | `high/critical` | `required` |
| Read sanitized Console users and roles | `oaa.identity.status` | `console-identity-owner-facade` | `read` | `none` |
| Create/enable/disable a Console user | `oaa.identity.user.create` / `oaa.identity.user.enabled` | `console-identity-owner-facade` | `critical` | `required` |
| Add/remove a canonical Console role | `oaa.identity.role.membership` | `console-identity-owner-facade` | `critical` | `required` |
| Read Extension revocations / inspect exact digest | `oaa.extension.security.status` / `oaa.extension.image.inspect` | `dupa-extension-security-owner-facade` | `read` | `none` |
| Revoke an exact-digest Extension image | `oaa.extension.image.revoke` | `dupa-extension-security-owner-facade` | `critical` | `required` |
| Read sanitized Notification operation state | `oaa.notification.status` | `console-notification-owner-facade` | `read` | `none` |
| Enable/disable/test a configured channel | `oaa.notification.channel.enabled` / `oaa.notification.channel.test` | `console-notification-owner-facade` | `critical` | `required` |
| Retry a failed Notification delivery | `oaa.notification.delivery.retry` | `console-notification-owner-facade` | `critical` | `required` |
| Read/plan HIS Observability configuration | `oaa.his.observability.config` / `oaa.his.observability.plan` | `cluster-manager-his-owner-facade` | `read` | `none` |
| Apply HIS Observability configuration | `oaa.his.observability.configure` | `cluster-manager-his-owner-facade` | `critical` | `required` |
| Read/plan external Ceph from a staged import | `oaa.ceph.status` / `oaa.ceph.plan` | `cluster-manager-ceph-owner-facade` | `read` | `none` |
| Connect/disconnect external Ceph | `oaa.ceph.connect` / `oaa.ceph.disconnect` | `cluster-manager-ceph-owner-facade` | `critical` | `required` |
| Read correlated agent evidence | `oaa.evidence.status` | `oaa-supabase-evidence-owner` | `read` | `none` |
| Update retention/legal hold policy | `oaa.evidence.retention.update` | `oaa-supabase-evidence-owner` | `critical` | `required` |

LLM key custody remains a Console-native administration workflow. Raw provider credentials are never accepted as chat/tool arguments and therefore are deliberately absent from the conversational action registry.

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

The Gateway owns the reviewed capability definitions in code and projects the active registry and action bindings into Supabase. This keeps executable code and RBAC reviewable while making the current capability surface queryable and auditable at runtime.

The first registry entries should cover:

- `oaa.environment.read`
- `oaa.control-plane.status`
- `oaa.catalog.entities.list`
- `oaa.foundation.status`
- `oaa.foundation.engine.lifecycle`
- `oaa.foundation.claim.create`
- `oaa.foundation.claim.release`
- `oaa.foundation.identity-directory.claim.create`
- `oaa.foundation.identity-directory.claim.release`
- `oaa.identity.status`
- `oaa.identity.user.create`
- `oaa.identity.user.enabled`
- `oaa.identity.role.membership`
- `oaa.extension.security.status`
- `oaa.extension.image.inspect`
- `oaa.extension.image.revoke`
- `oaa.notification.status`
- `oaa.notification.channel.enabled`
- `oaa.notification.channel.test`
- `oaa.notification.delivery.retry`
- `oaa.evidence.status`
- `oaa.evidence.retention.update`
- `oaa.k8s.pods.list`
- `oaa.k8s.services.list`
- `oaa.k8s.events.list`
- `oaa.k8s.logs.tail`
- `oaa.k8s.resource.describe`
- `oaa.k8s.deployment.rollout`
- `oaa.k8s.deployment.restart`
- `oaa.k8s.deployment.scale`
- `oaa.k8s.resources.list`
- `oaa.k8s.resource.get`
- `oaa.k8s.workload.restart`
- `oaa.k8s.workload.scale`
- `oaa.k8s.workload.update-image`
- `oaa.k8s.workload.rollback-image`
- `oaa.k8s.resource.apply`
- `oaa.k8s.resource.delete`
- `oaa.k8s.cronjob.run`
- `oaa.k8s.cronjob.suspend`
- `oaa.knowledge.search`
- `oaa.knowledge.ingest-manual`

## 10. Normalized Storage Target

Implemented by `backend/supabase/migrations/0005_oaa_governed_agent.sql` in the `oaa` schema. The production table names are `document`, `document_version`, `section`, `embedding_model`, `embedding`, `concept`, `concept_relation`, `tool_capability`, and `action_binding`, with `oaa_knowledge_documents` and `oaa_knowledge_chunks` retained as the serving contract.

The SQL below is a historical logical-model sketch, not a second schema to create. New code must use migration `0005` rather than these obsolete `oaa_manual_*` names.

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
| `document_revision` | SHA-256 content revision used by this chunk |
| `active` | current serving revision selector; historical revisions remain false |
| `chunk_index` | order in document |
| `content` | chunk text |
| `embedding` | provider-generated `vector(1536)`; hash vectors are prohibited in Supabase production mode |
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
      "sourceId": "console-docs/platform-control-plane-v2",
      "title": "OpenSphere Console Platform Control Plane V2",
      "version": "2026-07-22",
      "sourcePath": "docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md",
      "documentType": "architecture",
      "authorityTier": 1,
      "perspective": ["main-shell", "ai-level"],
      "plane": ["p1-control", "p4-intelligence", "p6-experience"],
      "component": ["supabase", "gitea", "oaa-gateway"],
      "tags": ["platform-control-plane", "supabase", "gitea", "oaa"],
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
      "id": "manual-action:platform-control:restart-oaa-gateway",
      "sourceId": "console-docs/platform-control-plane-v2",
      "sectionId": "manual-section:console-docs/platform-control-plane-v2#oaa",
      "intent": "restart",
      "toolId": "oaa.k8s.deployment.restart",
      "riskLevel": "medium",
      "confirmation": "required"
    }
  ]
}
```

## 13. Admin UI Implications

Console 관리 > OAA > Knowledge Store should evolve from a free text form into three modes:

1. Manual paste: current MVP form.
2. Manual seed: upload or trigger a `manual-seed` manifest.
3. Repository sync: ingest selected paths from `_DOCS_`, `OpenSphere-console/docs`, and signed subShell manual contributions. There is no standalone Manual repository or Manual subShell ingestion source.

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
4. `OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md`: tier 1
5. `OpenSphere-console/docs/OAA-MANUAL-KNOWLEDGE-DATA-MODEL.md`: tier 3
6. Manual Registry seed/canonical docs (`backend/opensphere-console-oaa-gateway/manual-seeds/opensphere-core-manuals.json`): tier 2 Help Center source

The Manual Registry seed/canonical docs are authoritative. The legacy standalone Manual source was retired after migration verification; the Help Center, the Console-native `/manual` page, and OAA all consume the same canonical content served from the Manual Registry.

## 15. Governed Retrieval and Action Execution

OAA is a Console operator tool, not a generic chat panel. Every retrieval is filtered by the caller's current Console permissions and document ACL before vector or lexical ranking. Supabase records the selected `document_id`, `chunk_id`, and `document_revision` in append-only `oaa.retrieval_trace`; the answer must cite that evidence rather than claim ungrounded system knowledge.

For provider-backed agent runs, the Gateway creates `agent_run.id` before retrieval. `retrieval_trace.agent_run_id`, `tool_run.agent_run_id`, and `llm_usage_event.agent_run_id` correlate the immutable knowledge revision, read-tool evidence, and provider usage with that run. Prompts, responses, credentials, and raw logs are excluded; only digests and bounded metadata are retained. The Admin Agent Evidence view and `oaa.evidence.status` expose this correlation to authorized administrators.

Retention is also typed evidence data, not a hidden maintenance constant. `evidence_retention_policy` defines 30–3650 days, `retain|export-before-delete`, and legal hold for six evidence streams. Every policy change creates an append-only `evidence_policy_event`. OAA does not expose a purge endpoint: an expired row remains until a reviewed owner maintenance flow has an `evidence_export_receipt` covering it.

Non-read actions follow this control path:

```text
OAA binding
  -> Gateway validates confirmation and caller-supplied reason
  -> Console Backend validates canonical permission and MFA assurance
  -> console.begin_change records an idempotent audited intent
  -> approved GitOps declaration is merged in Gitea
  -> dedicated least-privilege reconciler claims the approved outbox item
  -> reconciler applies the bound operation and reports observed rollout state to the same request ID
```

The Gateway has no Kubernetes write RBAC. Every restart, scale, image update/rollback, manifest apply/delete, and CronJob mutation is therefore a **control-plane submission**, not a direct `kubectl` capability. The separate `oaa-governed-adapter` has only the verb/resource/namespace combinations required by the reviewed contracts: workloads, ConfigMaps, Services, Jobs/CronJobs, Ingresses, NetworkPolicies, HPAs, and PDBs may be reconciled; PVCs may be read/created/patched but not deleted. The adapter cannot read Secrets, mutate Nodes, or alter Kubernetes RBAC. LLM provider Secrets live only in the dedicated `opensphere-oaa-credentials` namespace. The Gateway has read-only custody there and has no Secret access in the Console runtime namespace, so it cannot cross-read Console auth, TLS, Gitea, Supabase, notification, or registry credentials. Raw key material is never returned to the browser or accepted as a conversational tool argument. `oaa.tool_run` records the OAA-side intent evidence and `audit.event` / `console.change_request` remain the authoritative management audit trail.

Operational state is not refreshed by chat prompts alone. The Gateway lists and watches an allowlisted catalog of Kubernetes resource kinds, sanitizes every object before storage, and projects current state to `oaa.runtime_resource`. The catalog includes core workload/network/storage resources and OpenSphere lifecycle resources: `PlatformSupportProfile`, cluster-scoped HIS `ObservabilityBinding`, UI plugin Package/Registration, Foundation Model/Descriptor, Foundation Claim/Binding, and typed IdentityDirectory Claim/Binding. The Binding projection removes the internal query endpoint and retains only capability, readiness, unavailable-capability and evidence-digest metadata. Each watch event is also appended to immutable `oaa.runtime_event`, while replica-aware `oaa.watch_cursor` records stream health and resource versions. Supabase is therefore the durable query/audit projection; the Kubernetes API remains the source of truth.

Release-bound manuals are also reconciled, not seeded only into an empty database. On each Gateway release the bundled manifest compares document checksum and aligned active revision, plus canonical checksums and explicit seed ownership for every concept and relation. Changed definitions are detected even when row counts are unchanged. Removed documents and concepts are retired, removed relations are pruned, and historical document/chunk revisions referenced by retrieval evidence remain intact. This makes Supabase follow reviewed manual releases without turning it into the source authority for live Kubernetes state.

Authenticated control-plane diagnosis adds a second projection class. The Gateway queries Console/DUPA, Main Shell Registry, Cluster Manager HIS/Ceph, Supabase, Gitea, HIS Binding, consumer contracts, notifications, and Extension Host through fixed owner URLs. Sanitized results are stored as `source=owner-api`, `kind=ControlPlaneAuthority`; an append-only event is written only when the stable state digest changes. If an owner API is unavailable, the prior projection may be returned only as `lastKnown` with `stale=true` and its observation time. Supabase never becomes the current authority merely because a cached row exists.

Control-plane reachability is not the complete Agent readiness claim. The `oaa.control-plane.status` result includes `agentControl.fullyOperational`, stable blocker codes, Platform Support conditions, and the required/observed/missing Observability, HIS owner, Ceph owner, and Platform Recovery owner capability sets. Semantic embedding, runtime projection, governed mutation lifecycle, Platform Support, owner reachability, advanced telemetry, recovery execution/evidence promotion, and signed-owner capability publication must all be proven before this field becomes true.

Platform Recovery follows the same owner rule. `oaa.recovery.status` and `oaa.recovery.plan` read a resource-name-scoped recovery evidence ConfigMap through Console Backend and expose only verification booleans, structured checks, evidence age, blockers, and a fixed isolated-drill plan. Vault locations, checksum values, archive bytes, credentials, raw URLs, and scripts are excluded. The current owner advertises only `status-read` and `plan-read`; the Agent must not claim restore execution until a signed owner advertises both `drill-request` and `evidence-promote` behind AAL2, independent Gitea approval, and a durable reconcile receipt.

Owner mutations are a distinct execution class from Kubernetes desired-state changes. Platform readiness, Extension lifecycle, HIS canary/lifecycle/Observability configuration, Ceph connect/disconnect, Foundation engine/Claim lifecycle, Console Identity, and OAA evidence retention accept no operator-supplied URL or arbitrary payload. Each binding resolves to a fixed owner route, validates a closed input catalog, requires an AAL2 administrator, a human reason and exact confirmation, and records a redacted result digest in `oaa.tool_run`. HIS configuration accepts a complete schema whose credential-bearing fields are Kubernetes Secret names/keys only; its confirmation explicitly states public Grafana exposure and data reset. Ceph provider export is staged outside chat in a dedicated one-hour TTL Kubernetes Secret and the OAA contract accepts only `opensphere-ceph-imports/opensphere-ceph-import-<uuid>`. A successful connection consumes the import immediately; expired imports are rejected and removed. The platform-owned Rook operator is never installed or removed by the runtime Agent, including when legacy connection metadata claims prior ownership; the runtime image contains only the external consumer cluster chart. The signed infrastructure-owner release artifact carries the least-privilege Ceph runtime RBAC, while operator and CRD readiness remain separate signed platform prerequisites. Foundation additionally rechecks the Cluster Manager/HIS lifecycle gate and persists an owner audit before mutation. Its Claim API accepts only `identity|data` with no preserve-unknown parameters. Console Identity additionally excludes email/recovery links from status and protects self-disable/self-demotion and last-admin continuity. Kubernetes changes continue through Backend/Gitea/two-person approval/reconciler; owner operations rely on the owning API's durable operation/audit contract.

Secret values, ConfigMap values, Pod environment values, arbitrary annotations, provider credentials, and provider-specific sensitive identifiers are excluded before projection. Catalog rows are declared topology only; they are correlated with live Kubernetes/owner evidence and never treated as runtime truth or a write path.

### Production cutover checklist

1. Apply Supabase migrations through `0022_oaa_recovery_owner_permissions.sql` and verify the `oaa` schema, immutable knowledge revisions, append-only runtime events, replica-aware watch cursors, owner projection indexes/comments, correlated agent/retrieval/tool/provider evidence, retention/legal-hold policies, Extension/Notification/HIS/Ceph/Recovery owner permissions, `vector` extension, RLS policies, and constrained `opensphere_oaa_gateway` role.
2. Run `scripts/migrate-legacy-knowledge-to-supabase.js --dry-run`, then `--apply` with a real embedding provider. It must re-embed source text; legacy hash vectors must not be copied.
3. Confirm retrieval ACL tests with at least a viewer, operator, and administrator account; inspect `oaa.retrieval_trace` and answer citations.
4. Bind each allowed action to a named GitOps repository, branch, manifest path, validation command, approval policy, and reconciler status source. All Kubernetes mutations use the dedicated `oaa-governed-adapter`; every additional mutation type requires a new reviewed binding, validation contract, and least-privilege RBAC change.
5. Exercise each new mutation type in non-production: intent, two-person approval, Git commit, reconcile, observed result, and immutable audit correlation. Only then enable that capability for a production role.
