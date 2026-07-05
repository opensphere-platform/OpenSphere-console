FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js /app/server.js
COPY manual-seeds /app/manual-seeds
COPY kanidm-ca.crt /app/kanidm-ca.crt
ENV PORT=8080 KANIDM_CA_PATH=/app/kanidm-ca.crt
USER node
EXPOSE 8080
CMD ["node", "/app/server.js"]
