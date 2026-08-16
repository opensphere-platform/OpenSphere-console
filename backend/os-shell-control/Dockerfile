FROM docker.io/library/node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS dependencies
WORKDIR /app/os-shell-control
COPY os-shell-control/package.json os-shell-control/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM docker.io/library/node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app/os-shell-control
COPY --from=dependencies /app/os-shell-control/node_modules ./node_modules
COPY os-shell-control/config.js os-shell-control/kubernetes.js os-shell-control/runtime-template.js os-shell-control/server.js ./
COPY opensphere-console-backend/os-shell-contract.js opensphere-console-backend/os-shell-database.js ./authority/
COPY opensphere-console-backend/os-shell-admission.js opensphere-console-backend/os-shell-context.js ./authority/
RUN sed -i "s#require('../opensphere-console-backend/#require('./authority/#g" server.js \
  && node --check server.js \
  && chown -R 10001:10001 /app
ENV NODE_ENV=production PORT=8080
USER 10001:10001
EXPOSE 8080 8443
CMD ["node", "server.js"]
