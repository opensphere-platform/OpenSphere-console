# OAA Gateway

OpenSphere AI Agent gateway.

This service is a stateless Backbone tier. It uses Backbone PostgreSQL,
Kubernetes Secrets, and Kubernetes APIs instead of storing sensitive state in the
browser.

## Responsibilities

- Verify Kanidm Bearer tokens.
- Own server-side LLM API key custody.
- Store LLM key material in `opensphere-backbone` Kubernetes Secrets.
- Return only masked key metadata and fingerprints to the browser.
- Call OpenAI-compatible LLM providers such as DeepSeek.
- Store and search OpenSphere knowledge in Backbone PostgreSQL + pgvector.
- Seed OpenSphere manual documents, concepts, and relations.
- Expose read-only Kubernetes tools for OAA.
- Expose controlled Kubernetes actions with exact confirmation.
- Audit key changes, tool calls, action execution, and chat completions.

## Runtime

Installed by the Backbone stack installer:

- Namespace: `opensphere-backbone`
- ServiceAccount: `oaa-gateway`
- Deployment: `oaa-gateway`
- Service: `oaa-gateway:8080`
- Console route: same-origin `/api/oaa/*`

The deployment image is controlled by the `OAA_GATEWAY_IMAGE` environment
variable in the Backbone installer. Local development deployments have used
tags such as `localhost:5000/oaa-gateway:oaa-20260704-27`.

## Key APIs

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

## Chat Commands

Read-only examples:

```text
/env
/pod-count
/pods opensphere-backbone
/describe deployment opensphere-backbone oaa-gateway
/rollout opensphere-backbone oaa-gateway
```

Controlled write examples:

```text
/restart opensphere-backbone oaa-gateway confirm restart deployment opensphere-backbone/oaa-gateway
```

```text
/scale opensphere-backbone oaa-gateway 2 confirm scale deployment opensphere-backbone/oaa-gateway to 2
```

Natural-language chat can propose action bindings. Mutating actions still need
an explicit confirmation path and admin authorization.

## Local Checks

```powershell
node --check backend/oaa-gateway/server.js
npm.cmd test
npm.cmd run build
```
