# Console Backend — Supabase-authenticated policy and API boundary.
# The same exact image is used by the isolated Platform Release Job. kubectl,
# GitHub attestation verification and the Setup source are therefore pinned
# build inputs instead of tools discovered from an operator workstation.
FROM registry.k8s.io/kubectl@sha256:d08f476d04d0e30f426f06bc6ff6c38913aaa4591943046b77e2f74a72d3611c AS kubectl

FROM docker.io/library/node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
ARG TARGETARCH
ARG SETUP_SOURCE_REVISION
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl libicu72 libssl3 libunwind8 \
    && rm -rf /var/lib/apt/lists/*
RUN test -n "${SETUP_SOURCE_REVISION}" \
    && echo "${SETUP_SOURCE_REVISION}" | grep -Eq '^[a-f0-9]{40}$' \
    && case "${TARGETARCH}" in \
      amd64) \
        PS_ARCH='x64'; \
        PS_SHA256='207a3c0b2f630e8e1226cc9beb651e2e16789f07729197f45fd3ad0902d1c593'; \
        GH_SHA256='83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60' ;; \
      arm64) \
        PS_ARCH='arm64'; \
        PS_SHA256='8eb84faecd4834f4b961a6601c28c0c61a620a43f005e977f546b89e1e0f1aa2'; \
        GH_SHA256='06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909' ;; \
      *) echo "unsupported GitHub CLI architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/powershell.tar.gz \
      "https://github.com/PowerShell/PowerShell/releases/download/v7.5.7/powershell-7.5.7-linux-${PS_ARCH}.tar.gz" \
    && echo "${PS_SHA256}  /tmp/powershell.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/microsoft/powershell/7 \
    && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
    && chmod 0555 /opt/microsoft/powershell/7/pwsh \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
    && curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_${TARGETARCH}.tar.gz" \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && cp "/tmp/gh_2.96.0_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && chmod 0555 /usr/local/bin/gh \
    && rm -rf /tmp/powershell.tar.gz /tmp/gh.tar.gz "/tmp/gh_2.96.0_linux_${TARGETARCH}"
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
RUN node --version \
    && pwsh -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()' \
    && gh --version \
    && kubectl version --client
LABEL io.opensphere.setup-source-revision="${SETUP_SOURCE_REVISION}"
WORKDIR /repo/apps/console-api/runtime
# Build with `docker build -f apps/console-api/runtime/Dockerfile .`
# from the repository root and a named `setup-cli` context, so the browser API cannot supply
# or mutate the release executor implementation.
COPY apps/console-api/runtime/package.json apps/console-api/runtime/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY apps/console-api/runtime/server.js ./server.js
COPY apps/console-api/runtime/supabase-auth.js ./supabase-auth.js
COPY apps/console-api/runtime/browser-session.js ./browser-session.js
COPY apps/console-api/runtime/profile-avatar.js ./profile-avatar.js
COPY apps/console-api/runtime/plugin-proxy-auth.js ./plugin-proxy-auth.js
COPY apps/console-api/runtime/r2d2-proxy-auth.js ./r2d2-proxy-auth.js
COPY apps/os-shell-control/authority/os-shell-contract.js /repo/apps/os-shell-control/authority/os-shell-contract.js
COPY apps/os-shell-control/authority/os-shell-admission.js /repo/apps/os-shell-control/authority/os-shell-admission.js
COPY apps/os-shell-control/authority/os-shell-context.js /repo/apps/os-shell-control/authority/os-shell-context.js
COPY apps/os-shell-control/authority/os-shell-delegation.js /repo/apps/os-shell-control/authority/os-shell-delegation.js
COPY apps/console-api/runtime/local-edge-automation-token.js ./local-edge-automation-token.js
COPY apps/console-api/runtime/local-edge-r1-approval.js ./local-edge-r1-approval.js
COPY apps/console-api/runtime/baseline-monitoring.js ./baseline-monitoring.js
COPY apps/console-api/runtime/data-identity-readiness.js ./data-identity-readiness.js
COPY apps/console-api/runtime/module-operation-api.js ./module-operation-api.js
COPY apps/console-api/runtime/r2d2-operation-api.js ./r2d2-operation-api.js
COPY apps/console-api/runtime/r2d2-durable-operation.js ./r2d2-durable-operation.js
COPY apps/console-api/runtime/r2d2-engineering-remediation.js ./r2d2-engineering-remediation.js
COPY apps/console-api/runtime/r2d2-remediation-api.js ./r2d2-remediation-api.js
COPY apps/console-api/runtime/r2d2-repair-runner-contract.js ./r2d2-repair-runner-contract.js
COPY apps/console-api/runtime/r2d2-repair-runner-api.js ./r2d2-repair-runner-api.js
COPY apps/console-api/runtime/osaa-source-authority.js ./osaa-source-authority.js
COPY apps/console-api/runtime/module-lifecycle-policy.js ./module-lifecycle-policy.js
COPY apps/console-api/runtime/notification-api.js ./notification-api.js
COPY apps/console-api/runtime/external-channel-api.js ./external-channel-api.js
COPY apps/console-api/runtime/recovery-owner.js ./recovery-owner.js
COPY apps/console-api/runtime/foundation-bootstrap-contract.js ./foundation-bootstrap-contract.js
COPY apps/console-api/runtime/foundation-bootstrap-bundle.js ./foundation-bootstrap-bundle.js
COPY apps/console-api/runtime/foundation-bootstrap-reconciler.js ./foundation-bootstrap-reconciler.js
COPY apps/console-api/runtime/platform-release-agent-identity-cutover.js ./platform-release-agent-identity-cutover.js
COPY apps/console-api/runtime/platform-release-contract.js ./platform-release-contract.js
COPY apps/console-api/runtime/platform-release-reconciler.js ./platform-release-reconciler.js
COPY apps/console-api/runtime/platform-release-executor.mjs ./platform-release-executor.mjs
COPY --from=setup-cli src /app/opensphere-setup-cli/src
COPY --from=setup-cli package.json /app/opensphere-setup-cli/package.json
COPY apps/notification-dispatcher/contract.js /repo/apps/notification-dispatcher/contract.js
ENV PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "/repo/apps/console-api/runtime/server.js"]
