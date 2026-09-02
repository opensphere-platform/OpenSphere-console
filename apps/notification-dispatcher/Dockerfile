FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
WORKDIR /app
COPY contract.js server.js external-backup-server.js ./
USER node
EXPOSE 8081
CMD ["node", "server.js"]
