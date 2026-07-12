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

FROM docker.io/library/golang@sha256:523c3effe300580ed375e43f43b1c9b091b68e935a7c3a92bfcc4e7ed55b18c2 AS cli-build
WORKDIR /src
COPY OpenSphere-console/backend/os-cli/go.mod ./
COPY OpenSphere-console/backend/os-cli/cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test ./... && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=0.2.0" -o /out/opensphere-cli-linux-amd64 ./cmd/os && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w -X main.version=0.2.0" -o /out/opensphere-cli-darwin-arm64 ./cmd/os && \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=0.2.0" -o /out/opensphere-cli-windows-amd64.exe ./cmd/os

FROM docker.io/nginxinc/nginx-unprivileged@sha256:592b23aa79a6e6c08ba4b20f1fff700e1328895705966722608e115d62e52d39
ENV OS_PLUGIN_NAMESPACE=opensphere-console
USER root
RUN apk del --no-cache curl
USER 101
COPY --from=build /app/OpenSphere-console/dist/opensphere-console/browser /usr/share/nginx/html
COPY OpenSphere-console/backend/os-cli/index.json /usr/share/nginx/html/api/cli/index.json
COPY --from=cli-build /out/ /usr/share/nginx/html/api/cli/
COPY OpenSphere-console/nginx/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
