# OpenSphere AI Agent(OAA) Backbone Implementation Plan

Status: implemented MVP
Date: 2026-07-06
Scope: OpenSphere Console, Backbone, OAA Gateway, Admin UI, right-docked OAA chat

## 1. Decision

OAA is implemented as a separate Backbone tier, not as a browser-only feature.

The tier name is `OAA-Gateway`.

Reason:

- LLM API keys must never be exposed to the browser.
- Chat, RAG, tool execution, approval, and audit need a server-side control point.
- OAA must be able to read selected OpenSphere runtime state through Kubernetes APIs.
- Mutating operations must require explicit confirmation and audit.

Backbone remains the shared data substrate:

- PostgreSQL stores knowledge, chunks, concept graph, tool registry, and action bindings.
- pgvector is enabled for knowledge retrieval.
- Kubernetes Secrets store LLM API key material.
- Kubernetes API access is mediated by the `oaa-gateway` ServiceAccount.

## 2. Implemented Components

### 2.1 OAA Gateway

Path: `backend/oaa-gateway`

Runtime:

- Namespace: `opensphere-backbone`
- Deployment: `oaa-gateway`
- Service: `oaa-gateway:8080`
- Same-origin route: `/api/oaa/*`
- Current deployed image during verification: `localhost:5000/oaa-gateway:oaa-20260704-27`

Responsibilities:

- Verify Kanidm Bearer tokens.
- Store and rotate LLM key Secrets.
- Return only key metadata and fingerprints.
- Call OpenAI-compatible LLM providers such as DeepSeek.
- Store and search OpenSphere knowledge in Backbone PostgreSQL.
- Maintain manual concepts and manual relations.
- Expose read-only Kubernetes tools.
- Expose controlled admin actions with exact confirmation.
- Record audit events.

Key APIs:

- `GET /api/oaa/health`
- `GET /api/oaa/admin/llm-keys`
- `POST /api/oaa/admin/llm-keys`
- `DELETE /api/oaa/admin/llm-keys/{id}?reason=...`
- `POST /api/oaa/chat`
- `GET /api/oaa/knowledge/search`
- `GET /api/oaa/knowledge/concepts`
- `GET /api/oaa/tools/manifest`
- `GET /api/oaa/tools/action-bindings`
- `POST /api/oaa/tools/environment`
- `POST /api/oaa/tools/k8s/pods-summary`
- `POST /api/oaa/tools/k8s/services`
- `POST /api/oaa/tools/k8s/events`
- `POST /api/oaa/tools/k8s/describe`
- `POST /api/oaa/tools/k8s/rollout`
- `POST /api/oaa/tools/k8s/pod-logs`
- `POST /api/oaa/actions/bindings/execute`
- `POST /api/oaa/actions/k8s/restart-deployment`
- `POST /api/oaa/actions/k8s/scale-deployment`

### 2.2 Backbone Installer Integration

Path: `backend/dupa-control/controller.js`

The Backbone stack now declares `OAA-Gateway` as a managed component.

Installer additions:

- ServiceAccount `oaa-gateway`
- Role for LLM key Secret custody in `opensphere-backbone`
- ClusterRole/ClusterRoleBinding for read-only environment inspection
- ClusterRole/ClusterRoleBinding for controlled deployment patch actions
- Deployment `oaa-gateway`
- Service `oaa-gateway`

The installer image can override the gateway image with `OAA_GATEWAY_IMAGE`.

### 2.3 Admin Backbone UI

Path: `src/app/pages/admin-backbone.ts`

The `/manage/backbone` page includes an `OAA Gateway` tab with:

- LLM key registration
- DeepSeek provider preset
- OpenAI-compatible provider fields
- key fingerprint listing
- enabled/disabled status
- Knowledge Store stats
- manual seed action
- concept graph view
- tool registry view
- action bindings view
- binding execution support

### 2.4 OAA Chat UI

Path: `src/app/os/os-oaa-agent.ts`

The Console shell has a right-docked OAA chat panel.

Implemented behavior:

- Header icon toggles the OAA panel.
- Panel occupies right workspace, not an overlay over the page.
- Main content shrinks when OAA is open.
- Left/right panel resize is supported by dragging the panel left edge.
- Double-clicking the resize edge resets width.
- Full workspace mode is available.
- New chat, title edit, history, transcript copy, and clear history are supported.
- Chat shows answer text, metadata, sources, concepts, and suggested actions.
- Suggested action `Use` fills the command draft.

UX constraints:

- Left page and the gap beside the OAA panel must not show a scrollbar.
- Only the OAA thread area should scroll when chat contents overflow.
- The docked panel keeps a rounded left corner and visible edge.

Verified in browser:

- `/pod-count` returned the live cluster pod summary.
- Natural language question "현재 우리 K8S 클러스터 POD가 몇개지?" returned the live count.
- Resize drag changed the panel width from `372px` to `525px`.
- Left page and gap scrollbars remained hidden after resize.

## 3. Knowledge And RAG

OAA uses Backbone PostgreSQL and pgvector.

Current model:

- `oaa_knowledge_documents`
- `oaa_knowledge_chunks`
- `oaa_manual_concepts`
- `oaa_manual_relations`
- `oaa_tool_capabilities`
- `oaa_manual_action_bindings`

Seed source:

- `backend/oaa-gateway/manual-seeds/opensphere-core-manuals.json`
- Generator: `backend/oaa-gateway/scripts/build-manual-seed.js`

The bundled seed currently carries:

- OpenSphere constitution and architecture documents
- 10 Perspective related concepts
- OAA Gateway concept
- Backbone implementation docs
- Help Center static manual source
- action bindings for read and controlled operations

Important rule:

OAA must not invent OpenSphere-specific concepts that generic LLMs do not know. It should answer from manual chunks, manual concepts, concept relations, and live environment snapshots.

## 4. Runtime Control Model

OAA can directly read the cluster through controlled tools.

Read examples:

- `/env`
- `/pod-count`
- `/pods [namespace]`
- `/services [namespace]`
- `/events [namespace]`
- `/describe pod <namespace> <pod>`
- `/describe deployment <namespace> <deployment>`
- `/rollout <namespace> <deployment>`
- `/logs <namespace> <pod> [tailLines]`

Controlled write examples:

```text
/restart opensphere-backbone oaa-gateway confirm restart deployment opensphere-backbone/oaa-gateway
```

```text
/scale opensphere-backbone oaa-gateway 2 confirm scale deployment opensphere-backbone/oaa-gateway to 2
```

Natural language is allowed to propose actions, but destructive or mutating actions must not execute without an explicit confirmation path.

Execution policy:

1. Understand user intent.
2. Attach live environment and manual context.
3. Propose action binding when relevant.
4. Require exact confirmation for mutating tools.
5. Verify admin group membership for write tools.
6. Execute through OAA Gateway only.
7. Audit the result.
8. Report the final state.

## 5. Verification

Last verified:

- Date: 2026-07-05
- Console image: `localhost:5000/opensphere-console:oaa-ui-20260705-01`
- Gateway image: `localhost:5000/oaa-gateway:oaa-20260704-27`

Checks:

- `npm test`: 33 tests passed.
- `npm run build`: passed with existing bundle/style budget warnings.
- `node --check backend/oaa-gateway/server.js`: passed.
- Kubernetes rollout for Console: Ready/Available.
- Kubernetes rollout for OAA Gateway: Ready/Available.
- Live `/pod-count`: returned `93` pods at verification time.
- Natural language pod-count question: returned `93` with live snapshot evidence.

Known warnings:

- Angular bundle initial budget warning.
- Component SCSS budget warnings for existing large single-file components.
- `AdminPlugins` imports `CarbonIcon` but does not use it in the template.

## 6. Next Work

Priority order:

1. Replace hash embeddings with provider embeddings for production-grade semantic retrieval.
2. Add ingestion UI for OpenSphere manuals, policies, code, runbooks, and catalog sources.
3. Add streaming chat responses.
4. Add explicit preflight cards for natural-language action plans.
5. Add approval state and audit review UI for mutating operations.
6. Promote key metadata and conversations into normalized PostgreSQL tables.
7. Add cost, token, latency, and provider health metrics.
8. Add background ingestion/re-embedding worker.
9. Add tests for browser dock layout and resize behavior.
10. Add a formal OAA action policy document.
