# OAA Gateway

OpenSphere AI Agent gateway.

This service is a stateless, Console-native OAA workload. It uses Supabase
PostgreSQL, Console Backend policy APIs, and bounded Kubernetes read APIs
instead of storing sensitive state or privileged credentials in the browser.

## Responsibilities

- Delegate session and role verification to the Supabase-backed Console identity service.
- Keep server-side LLM provider interaction outside the browser.
- Submit LLM key changes through the Console Backend policy and audit path.
- Return only masked key metadata and fingerprints to the browser.
- Call OpenAI-compatible LLM providers such as DeepSeek.
- Store and search OpenSphere knowledge in the Supabase `oaa` schema.
- Seed OpenSphere manual documents, concepts, and relations.
- Expose read-only Kubernetes tools for OAA.
- Submit controlled Kubernetes actions only through the Console Backend after explicit confirmation.
- Correlate key changes, tool calls, action execution, and chat completions with Supabase audit and Gitea change evidence.

## Runtime

Installed as a Main Shell native workload after the Supabase and Gitea readiness gates:

- Namespace: `opensphere-console`
- ServiceAccount: `opensphere-console-oaa-gateway`
- Deployment: `opensphere-console-oaa-gateway`
- Service: `opensphere-console-oaa-gateway:8080`
- Console route: same-origin `/api/oaa/*`

The deployment contract is [`deploy.yaml`](deploy.yaml). Production releases
use the Console release BOM; a local cluster may use the corresponding pinned
local image tag.

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
/pods opensphere-console
/describe deployment opensphere-console opensphere-console-oaa-gateway
/rollout opensphere-console opensphere-console-oaa-gateway
```

Controlled write examples:

```text
/restart opensphere-console opensphere-console-oaa-gateway confirm restart deployment opensphere-console/opensphere-console-oaa-gateway
```

```text
/scale opensphere-console opensphere-console-oaa-gateway 2 confirm scale deployment opensphere-console/opensphere-console-oaa-gateway to 2
```

Natural-language chat can propose action bindings. Mutating actions still need
an explicit confirmation path and admin authorization.

## Local Checks

```powershell
node --check backend/opensphere-console-oaa-gateway/server.js
npm.cmd test
npm.cmd run build
```
