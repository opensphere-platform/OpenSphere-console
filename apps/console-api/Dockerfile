FROM docker.io/library/node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
WORKDIR /workspace/apps/console-api
COPY apps/console-api/package.json apps/console-api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY apps/console-api/src ./src
COPY apps/os-shell-control/authority/os-shell-context.js /workspace/apps/os-shell-control/authority/os-shell-context.js
COPY apps/console-api/runtime/platform-release-contract.js apps/console-api/runtime/platform-release-agent-identity-cutover.js ./runtime/
COPY apps/console-api/runtime/foundation-bootstrap-contract.js ./runtime/
COPY apps/console-api/runtime/package.json ./runtime/
COPY packages /workspace/packages
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "src/server.mjs"]
