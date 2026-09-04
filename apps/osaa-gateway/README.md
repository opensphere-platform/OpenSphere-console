# OSAA Gateway

OpenSphere AI Agent gateway.

This service is a stateless, Console-native OSAA workload. It uses Supabase
PostgreSQL, Console Backend policy APIs, and bounded Kubernetes read APIs
instead of storing sensitive state or privileged credentials in the browser.

## Responsibilities

- Delegate session and role verification to the Supabase-backed Console identity service.
- Keep server-side LLM provider interaction outside the browser.
- Accept LLM key changes only after Console API owner admission, then enforce
  current AAL2, reason, durable audit and exact Secret custody in the C_AI owner.
- Return only masked key metadata and fingerprints to the browser.
- Call OpenAI-compatible LLM providers such as DeepSeek.
- Store and search OpenSphere knowledge in the Supabase `osaa` schema.
- Seed OpenSphere manual documents, concepts, and relations.
- Expose read-only Kubernetes tools for OSAA.
- Submit controlled Kubernetes actions only through the Console Backend after explicit confirmation.
- Correlate key changes, tool calls, action execution, and chat completions with Supabase audit and Gitea change evidence.

## Runtime

Installed as a Main Shell native workload after the Supabase and Gitea readiness gates:

- Namespace: `opensphere-console`
- ServiceAccount: `opensphere-console-osaa-gateway`
- Deployment: `opensphere-console-osaa-gateway`
- Service: `opensphere-console-osaa-gateway:8080`
- Console route: same-origin `/api/osaa/*`

The deployment contract is [`deploy.yaml`](deploy.yaml). Production releases
use the Console release BOM; a local cluster may use the corresponding pinned
local image tag.

## Key APIs

- `GET /api/osaa/health`
- `GET /api/osaa/admin/llm-keys`
- `POST /api/osaa/admin/llm-keys`
- `DELETE /api/osaa/admin/llm-keys/{id}?reason=...`
- `POST /api/osaa/chat`
- `GET /api/osaa/knowledge/search`
- `GET /api/osaa/knowledge/concepts`
- `GET /api/osaa/tools/manifest`
- `GET /api/osaa/tools/action-bindings`
- `POST /api/osaa/tools/environment`
- `POST /api/osaa/tools/k8s/pods-summary`
- `POST /api/osaa/tools/k8s/services`
- `POST /api/osaa/tools/k8s/events`
- `POST /api/osaa/tools/k8s/describe`
- `POST /api/osaa/tools/k8s/rollout`
- `POST /api/osaa/tools/k8s/pod-logs`
- `POST /api/osaa/actions/bindings/execute`
- `POST /api/osaa/actions/k8s/restart-deployment`
- `POST /api/osaa/actions/k8s/scale-deployment`

## Chat Commands

Read-only examples:

```text
/env
/pod-count
/pods opensphere-console
/describe deployment opensphere-console opensphere-console-osaa-gateway
/rollout opensphere-console opensphere-console-osaa-gateway
```

Controlled write examples:

```text
/restart opensphere-console opensphere-console-osaa-gateway confirm restart deployment opensphere-console/opensphere-console-osaa-gateway
```

```text
/scale opensphere-console opensphere-console-osaa-gateway 2 confirm scale deployment opensphere-console/opensphere-console-osaa-gateway to 2
```

Natural-language chat can propose action bindings. Mutating actions still need
an explicit confirmation path and admin authorization.

## Local Checks

```powershell
node --check apps/osaa-gateway/server.js
npm.cmd test
npm.cmd run build
```

## Target browser-session admission

`C_AI` owns the Console-native OSAA and Manual read surfaces. Browser cookies never enter this workload. Nginx first exchanges the opaque Console session through an internal C_API admission request, removes Cookie and client identity headers, and forwards only the resulting bearer.

During the atomic browser-session migration, the Gateway supports two explicit identity profiles. The default profile keeps the current compatibility authority at `CONSOLE_IDENTITY_URL/api/identity/session`. The target profile requires `CONSOLE_TARGET_OWNER_ADMISSION=true` and reads `CONSOLE_SESSION_AUTHORITY_URL/api/identity/me` with the internal `X-OS-Owner-Admission: osaa-gateway-v1` marker. Target C_API accepts that bearer only when Supabase `/user` and the current DB browser session, Auth session reference, permission revision, revoke epoch, expiry, and AAL all agree. The Gateway derives the three closed Console groups only from `console.role.*` permissions.

Do not enable target mode by itself. It must be rendered together with the Nginx internal admission upstream and the rest of the authenticated browser-family cutover. `CONSOLE_IDENTITY_URL` remains the fixed compatibility Owner API origin until those Owner operations have target contracts.
