FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
ARG APP_VERSION=development
WORKDIR /app
COPY package.json package-lock.json /app/
RUN apk upgrade --no-cache \
    && npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY server.js conversation-store.js dialogue-state.js dialogue-transition.js dialogue-rollout.js native-identity-client.js /app/
ENV PORT=8080 APP_VERSION=${APP_VERSION}
USER node
EXPOSE 8080
CMD ["node", "/app/server.js"]
