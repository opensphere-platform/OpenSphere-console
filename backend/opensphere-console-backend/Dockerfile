# Console Backend — Supabase-authenticated policy and API boundary.
FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app/opensphere-console-backend
# Build with `docker build -f opensphere-console-backend/Dockerfile .` from
# `backend/`, so the API and Dispatcher share one validated input contract.
COPY opensphere-console-backend/server.js ./server.js
COPY opensphere-console-backend/supabase-auth.js ./supabase-auth.js
COPY opensphere-console-backend/cli-token-policy.js ./cli-token-policy.js
COPY opensphere-console-backend/notification-api.js ./notification-api.js
COPY opensphere-console-backend/external-channel-api.js ./external-channel-api.js
COPY opensphere-console-backend/recovery-owner.js ./recovery-owner.js
COPY notification-dispatcher/contract.js /app/notification-dispatcher/contract.js
ENV PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "/app/opensphere-console-backend/server.js"]
