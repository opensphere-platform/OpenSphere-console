# Console Backend — Supabase-authenticated policy and API boundary.
# The same exact image is used by the isolated Platform Release Job. kubectl,
# GitHub attestation verification and the Setup source are therefore pinned
# build inputs instead of tools discovered from an operator workstation.
FROM registry.k8s.io/kubectl@sha256:d08f476d04d0e30f426f06bc6ff6c38913aaa4591943046b77e2f74a72d3611c AS kubectl

FROM docker.io/library/node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
ARG TARGETARCH
ARG SETUP_SOURCE_REVISION
RUN test -n "${SETUP_SOURCE_REVISION}" \
    && echo "${SETUP_SOURCE_REVISION}" | grep -Eq '^[a-f0-9]{40}$' \
    && case "${TARGETARCH}" in \
      amd64) GH_SHA256='83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60' ;; \
      arm64) GH_SHA256='06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909' ;; \
      *) echo "unsupported GitHub CLI architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q -O /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_${TARGETARCH}.tar.gz" \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && cp "/tmp/gh_2.96.0_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && chmod 0555 /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz "/tmp/gh_2.96.0_linux_${TARGETARCH}" \
      /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
LABEL io.opensphere.setup-source-revision="${SETUP_SOURCE_REVISION}"
WORKDIR /app/opensphere-console-backend
# Build with `docker build -f opensphere-console-backend/Dockerfile .` from
# `backend/` and a named `setup-cli` context, so the browser API cannot supply
# or mutate the release executor implementation.
COPY opensphere-console-backend/server.js ./server.js
COPY opensphere-console-backend/supabase-auth.js ./supabase-auth.js
COPY opensphere-console-backend/cli-token-policy.js ./cli-token-policy.js
COPY opensphere-console-backend/browser-session.js ./browser-session.js
COPY opensphere-console-backend/plugin-proxy-auth.js ./plugin-proxy-auth.js
COPY opensphere-console-backend/baseline-monitoring.js ./baseline-monitoring.js
COPY opensphere-console-backend/notification-api.js ./notification-api.js
COPY opensphere-console-backend/external-channel-api.js ./external-channel-api.js
COPY opensphere-console-backend/recovery-owner.js ./recovery-owner.js
COPY opensphere-console-backend/foundation-bootstrap-contract.js ./foundation-bootstrap-contract.js
COPY opensphere-console-backend/foundation-bootstrap-bundle.js ./foundation-bootstrap-bundle.js
COPY opensphere-console-backend/foundation-bootstrap-reconciler.js ./foundation-bootstrap-reconciler.js
COPY opensphere-console-backend/platform-release-contract.js ./platform-release-contract.js
COPY opensphere-console-backend/platform-release-reconciler.js ./platform-release-reconciler.js
COPY opensphere-console-backend/platform-release-executor.mjs ./platform-release-executor.mjs
COPY --from=setup-cli src /app/opensphere-setup-cli/src
COPY --from=setup-cli package.json /app/opensphere-setup-cli/package.json
COPY notification-dispatcher/contract.js /app/notification-dispatcher/contract.js
ENV PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "/app/opensphere-console-backend/server.js"]
