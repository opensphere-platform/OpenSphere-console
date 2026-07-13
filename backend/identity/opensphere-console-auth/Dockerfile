# opensphere-auth BFF — Kanidm-backed OIDC issuer that owns the console login UI.
FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
ENV PORT=8443
WORKDIR /app
# server-side QR generation for authenticator enrollment (no third-party calls)
COPY package.json /app/package.json
RUN apk upgrade --no-cache \
    && npm install --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# The live Kanidm CA is mounted from the kanidm-tls Secret at /certs/tls.crt.
# Never bake an environment-specific bootstrap certificate into this image.
COPY --chmod=0644 server.mjs /app/server.mjs
COPY --chmod=0644 token-verifier.mjs /app/token-verifier.mjs
COPY --chmod=0644 auth-policy.mjs /app/auth-policy.mjs
COPY --chmod=0644 credential-onboarding.mjs /app/credential-onboarding.mjs
COPY --chmod=0644 cli-device.mjs /app/cli-device.mjs
USER 1000:1000
EXPOSE 8443
CMD ["node", "/app/server.mjs"]
