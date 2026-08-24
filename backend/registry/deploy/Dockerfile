FROM docker.io/library/golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./... && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/registry ./cmd/registry

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
ARG APP_VERSION=dev
ARG SOURCE_REVISION=unknown
ARG IMAGE_DIGEST=runtime-reported-by-installation-lock
ENV APP_VERSION=$APP_VERSION SOURCE_REVISION=$SOURCE_REVISION IMAGE_DIGEST=$IMAGE_DIGEST
COPY --from=build /out/registry /usr/local/bin/registry
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/registry"]
