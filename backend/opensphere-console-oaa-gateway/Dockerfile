FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
WORKDIR /app
COPY package.json /app/package.json
RUN apk upgrade --no-cache \
    && npm install --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY server.js /app/server.js
COPY manual-seeds /app/manual-seeds
# The Kanidm trust CA is never baked into the image. It is a Setup-provisioned Secret
# (opensphere-console-auth-ca) mounted read-only at /etc/kanidm-ca by the base manifest
# (backend/backbone/console-services.yaml); server.js defaults KANIDM_CA_PATH to that same path.
ENV PORT=8080
USER node
EXPOSE 8080
CMD ["node", "/app/server.js"]
