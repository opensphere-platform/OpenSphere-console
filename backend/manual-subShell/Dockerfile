FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --chmod=0644 server.js /app/server.js
COPY ui-shell/ /app/plugins/
ENV PLUGINS_DIR=/app/plugins PORT=8080
EXPOSE 8080
USER 1000
CMD ["node", "/app/server.js"]
