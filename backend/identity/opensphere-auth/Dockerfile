# opensphere-auth BFF — Kanidm-backed OIDC issuer that owns the console login UI.
FROM docker.io/library/node:22-alpine
ENV PORT=8443
WORKDIR /app
# server-side QR generation for authenticator enrollment (no third-party calls)
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund
# CA that signed kanidm-tls (used to validate the internal Kanidm core over TLS)
COPY kanidm-ca.crt /etc/kanidm-ca/ca.crt
COPY --chmod=0644 server.mjs /app/server.mjs
USER node
EXPOSE 8443
CMD ["node", "/app/server.mjs"]
