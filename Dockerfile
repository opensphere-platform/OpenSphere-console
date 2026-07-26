# Build context: OpenSphere-Platform-V2 root.
# The canonical Console source depends on the sibling OpenSphere-SDK package.
ARG CLI_UPDATE_SIGNING_PROFILE=local
ARG CLI_UPDATE_TRUST_ID=
ARG CLI_UPDATE_TRUST_PUBLIC=
# The macOS CLI must be compiled natively: it reaches the Keychain through cgo
# against Security.framework, so no Windows or Linux host can produce it. Making
# it a mandatory build input coupled every Console change to a macOS builder — a
# local edge build of a frontend fix was blocked by an unrelated backend/os-cli
# commit. It is now an optional context: a release supplies it and asserts it
# with CLI_REQUIRE_DARWIN=true, while a local edge build omits it and the
# generated manifest records which platforms are absent.
ARG CLI_DARWIN_CONTEXT=cli-darwin-absent
ARG CLI_REQUIRE_DARWIN=false
FROM docker.io/library/node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
WORKDIR /app/OpenSphere-console
COPY OpenSphere-SDK /app/OpenSphere-SDK
RUN cd /app/OpenSphere-SDK && npm install --no-audit --no-fund && npm run build
COPY OpenSphere-console/package.json OpenSphere-console/package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps
COPY OpenSphere-console/angular.json OpenSphere-console/tsconfig.json OpenSphere-console/tsconfig.app.json OpenSphere-console/tsconfig.spec.json ./
COPY OpenSphere-console/scripts ./scripts
COPY OpenSphere-console/public ./public
COPY OpenSphere-console/src ./src
RUN npm run build -- --configuration production

FROM scratch AS cli-darwin-absent
FROM ${CLI_DARWIN_CONTEXT} AS cli-darwin

FROM docker.io/library/golang@sha256:523c3effe300580ed375e43f43b1c9b091b68e935a7c3a92bfcc4e7ed55b18c2 AS cli-build
ARG CLI_UPDATE_TRUST_ID
ARG CLI_UPDATE_TRUST_PUBLIC
ARG CLI_REQUIRE_DARWIN
WORKDIR /src
COPY OpenSphere-console/backend/os-cli/go.mod ./
COPY OpenSphere-console/backend/os-cli/cmd ./cmd
# Execute tests for the build stage's native Linux architecture. Forcing an
# amd64 test binary while Buildx is building the arm64 image makes `go test`
# attempt to execute the wrong architecture. The downloadable artifacts below
# remain explicitly cross-built and are architecture-independent payloads.
RUN mkdir -p /out && go test ./... && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=0.8.1 -X main.updateProductionKeyID=${CLI_UPDATE_TRUST_ID} -X main.updateProductionPublicKey=${CLI_UPDATE_TRUST_PUBLIC}" -o /out/opensphere-cli-linux-amd64 ./cmd/os && \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=0.8.1 -X main.updateProductionKeyID=${CLI_UPDATE_TRUST_ID} -X main.updateProductionPublicKey=${CLI_UPDATE_TRUST_PUBLIC}" -o /out/opensphere-cli-windows-amd64.exe ./cmd/os
RUN --mount=from=cli-darwin,target=/darwin,ro \
    if [ -f /darwin/opensphere-cli-darwin-arm64 ] && [ -f /darwin/opensphere-cli-darwin-amd64 ]; then \
      cp /darwin/opensphere-cli-darwin-arm64 /darwin/opensphere-cli-darwin-amd64 /out/; \
    elif [ "${CLI_REQUIRE_DARWIN}" = "true" ]; then \
      echo 'natively built macOS CLI artifacts are required for this release class' >&2; exit 1; \
    fi

FROM docker.io/library/node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS cli-manifest
ARG CLI_UPDATE_SIGNING_PROFILE
ARG CLI_UPDATE_TRUST_ID
ARG CLI_UPDATE_TRUST_PUBLIC
ARG CLI_REQUIRE_DARWIN
WORKDIR /manifest
COPY OpenSphere-console/backend/os-cli/index.json ./index.json
COPY OpenSphere-console/backend/os-cli/generate-manifest.mjs ./generate-manifest.mjs
COPY --from=cli-build /out/ ./artifacts/
# A release build requires every declared platform; a local edge build publishes
# what it produced and the manifest names the platforms it had to omit.
RUN --mount=type=secret,id=cli_update_signing_key,required=false \
    node ./generate-manifest.mjs ./index.json ./artifacts ./artifacts/index.json \
      "$CLI_UPDATE_SIGNING_PROFILE" "$CLI_UPDATE_TRUST_ID" /run/secrets/cli_update_signing_key "$CLI_UPDATE_TRUST_PUBLIC" \
      "$([ "${CLI_REQUIRE_DARWIN}" = "true" ] && echo false || echo true)"

FROM docker.io/nginxinc/nginx-unprivileged@sha256:592b23aa79a6e6c08ba4b20f1fff700e1328895705966722608e115d62e52d39
ENV OS_PLUGIN_NAMESPACE=opensphere-console
USER root
RUN apk del --no-cache curl
USER 101
COPY --from=build /app/OpenSphere-console/dist/opensphere-console/browser /usr/share/nginx/html
COPY --from=cli-manifest /manifest/artifacts/ /usr/share/nginx/html/api/cli/
COPY OpenSphere-console/nginx/default.conf.template /etc/nginx/templates/default.conf.template
RUN set -eu; \
    grep -q '"contract": "console-help-center-v2"' /usr/share/nginx/html/manual-contract.json; \
    grep -q '"version": "0.8.1"' /usr/share/nginx/html/api/cli/index.json; \
    grep -q '"algorithm": "Ed25519"' /usr/share/nginx/html/api/cli/index.json; \
    grep -Rqs 'console-help-center-v2' /usr/share/nginx/html/main-*.js; \
    if grep -aRqs '/bff/cli' /usr/share/nginx/html/api/cli/opensphere-cli-*; then exit 1; fi; \
    if grep -Rqs 'os-source-chips' /usr/share/nginx/html/main-*.js; then exit 1; fi
EXPOSE 8080
