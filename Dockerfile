# Build context: OpenSphere-Platform-V2 root.
# OpenSphere Console depends on sibling package OpenSphere-SDK.
FROM docker.io/library/node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
WORKDIR /app/OpenSphere-console
COPY OpenSphere-SDK /app/OpenSphere-SDK
RUN cd /app/OpenSphere-SDK && npm install --no-audit --no-fund && npm run build
COPY OpenSphere-console/package.json OpenSphere-console/package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps
COPY OpenSphere-console/angular.json OpenSphere-console/tsconfig.json OpenSphere-console/tsconfig.app.json OpenSphere-console/tsconfig.spec.json ./
COPY OpenSphere-console/public ./public
COPY OpenSphere-console/src ./src
RUN npx ng build --configuration production

FROM docker.io/nginxinc/nginx-unprivileged@sha256:592b23aa79a6e6c08ba4b20f1fff700e1328895705966722608e115d62e52d39
USER root
RUN apk del --no-cache curl
USER 101
COPY --from=build /app/OpenSphere-console/dist/opensphere-console/browser /usr/share/nginx/html
COPY OpenSphere-console/nginx/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
