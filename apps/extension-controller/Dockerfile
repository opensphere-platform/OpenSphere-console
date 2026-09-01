FROM docker.io/library/node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
WORKDIR /workspace/apps/extension-controller
COPY apps/extension-controller/package.json apps/extension-controller/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY apps/extension-controller/src ./src
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "src/server.mjs"]
