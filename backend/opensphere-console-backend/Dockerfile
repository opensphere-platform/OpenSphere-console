# Console Backend — Supabase-authenticated policy and API boundary.
FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY server.js /app/server.js
COPY supabase-auth.js /app/supabase-auth.js
ENV PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "/app/server.js"]
