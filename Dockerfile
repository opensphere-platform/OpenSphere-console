# Build context: the OpenSphere-Console repository root.
FROM docker.io/library/node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps
COPY angular.json tsconfig.json tsconfig.app.json tsconfig.spec.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY nginx ./nginx
COPY public ./public
COPY src ./src
RUN npm run build -- --configuration production

FROM docker.io/nginxinc/nginx-unprivileged@sha256:592b23aa79a6e6c08ba4b20f1fff700e1328895705966722608e115d62e52d39
ENV OS_PLUGIN_NAMESPACE=opensphere-console
USER root
RUN apk del --no-cache curl
USER 101
COPY --from=build /app/dist/opensphere-console/browser /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
RUN set -eu; \
    grep -q '"contract": "console-help-center-v2"' /usr/share/nginx/html/manual-contract.json; \
    grep -Rqs 'console-help-center-v2' /usr/share/nginx/html/main-*.js; \
    if grep -Rqs 'os-source-chips' /usr/share/nginx/html/main-*.js; then exit 1; fi
EXPOSE 8080
