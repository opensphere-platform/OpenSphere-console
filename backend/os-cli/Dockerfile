FROM docker.io/library/golang@sha256:523c3effe300580ed375e43f43b1c9b091b68e935a7c3a92bfcc4e7ed55b18c2 AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go test ./... && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=0.4.0" -o /out/opensphere-cli-linux-amd64 ./cmd/os && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w -X main.version=0.4.0" -o /out/opensphere-cli-darwin-arm64 ./cmd/os && \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=0.4.0" -o /out/opensphere-cli-windows-amd64.exe ./cmd/os

# index.json의 크기·SHA-256은 소스에 적힌 과거 값이 아니라 이 빌드에서 나온 정확한
# 세 바이너리로 다시 생성한다. Console은 이 생성물만 배포한다.
FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS manifest
WORKDIR /work
COPY index.json generate-manifest.mjs ./
COPY --from=build /out/ /out/
RUN node generate-manifest.mjs /work/index.json /out /work/index.generated.json

FROM docker.io/nginxinc/nginx-unprivileged@sha256:592b23aa79a6e6c08ba4b20f1fff700e1328895705966722608e115d62e52d39
USER root
RUN apk del --no-cache curl
USER 101
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=manifest --chown=101:101 /work/index.generated.json /srv/index.json
COPY --from=build --chown=101:101 /out/ /srv/
EXPOSE 8080
