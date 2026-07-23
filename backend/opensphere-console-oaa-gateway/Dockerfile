FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
WORKDIR /app
COPY package.json /app/package.json
RUN apk upgrade --no-cache \
    && npm install --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY server.js /app/server.js
COPY provider-tool-calls.js /app/provider-tool-calls.js
COPY kubernetes-resource-catalog.js /app/kubernetes-resource-catalog.js
COPY manual-seed-reconcile.js /app/manual-seed-reconcile.js
COPY agent-control-readiness.js /app/agent-control-readiness.js
COPY manual-seeds /app/manual-seeds
ENV PORT=8080
USER node
EXPOSE 8080
CMD ["node", "/app/server.js"]
