FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
WORKDIR /app
COPY package.json /app/package.json
RUN apk upgrade --no-cache \
    && npm install --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY server.js /app/server.js
COPY provider-tool-calls.js /app/provider-tool-calls.js
COPY chat-runtime-policy.js /app/chat-runtime-policy.js
COPY conversation-store.js /app/conversation-store.js
COPY dialogue-state.js /app/dialogue-state.js
COPY dialogue-capability.js /app/dialogue-capability.js
COPY dialogue-evidence.js /app/dialogue-evidence.js
COPY dialogue-rollout.js /app/dialogue-rollout.js
COPY dialogue-request-boundary.js /app/dialogue-request-boundary.js
COPY dialogue-transition.js /app/dialogue-transition.js
COPY turn-lease-execution.js /app/turn-lease-execution.js
COPY kubernetes-resource-catalog.js /app/kubernetes-resource-catalog.js
COPY manual-seed-reconcile.js /app/manual-seed-reconcile.js
COPY agent-control-readiness.js /app/agent-control-readiness.js
COPY extension-presentation.js /app/extension-presentation.js
COPY operational-graph.js /app/operational-graph.js
COPY incident-engine.js /app/incident-engine.js
COPY r2d2-operational-runtime.js /app/r2d2-operational-runtime.js
COPY r2d2-prompt-boundary.js /app/r2d2-prompt-boundary.js
COPY r2d2-durable-binding.js /app/r2d2-durable-binding.js
COPY r2d2-sse-contract.js /app/r2d2-sse-contract.js
COPY r2d2-operational-resilience.js /app/r2d2-operational-resilience.js
COPY r2d2-incident-relay.js /app/r2d2-incident-relay.js
COPY r2d2-source-adapters.js /app/r2d2-source-adapters.js
COPY r2d2-source-grounding.js /app/r2d2-source-grounding.js
COPY r2d2-surface-diagnostics.js /app/r2d2-surface-diagnostics.js
COPY manual-seeds /app/manual-seeds
ENV PORT=8080
USER node
EXPOSE 8080
CMD ["node", "/app/server.js"]
