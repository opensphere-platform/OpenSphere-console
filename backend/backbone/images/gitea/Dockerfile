FROM docker.io/gitea/gitea@sha256:4d1d79638bef7a4a82e3a269b95fae1bbb9bcba1258dd84fba7ba3a3a49581e3 AS upstream

FROM docker.io/library/golang:1.26.4-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS build
ARG GITEA_VERSION=1.26.3
ARG GITEA_SHA256=ae04ccc547ac3a56e576a934ee37b1864953b8ca13658556dd8f6072ed96a0d5
RUN apk add --no-cache build-base nodejs npm wget ca-certificates \
    && npm install --global pnpm@10.33.0 \
    && wget -q -O /tmp/gitea.tar.gz "https://github.com/go-gitea/gitea/archive/refs/tags/v${GITEA_VERSION}.tar.gz" \
    && echo "${GITEA_SHA256}  /tmp/gitea.tar.gz" | sha256sum -c - \
    && mkdir /src \
    && tar -xzf /tmp/gitea.tar.gz -C /src --strip-components=1
WORKDIR /src
RUN go get golang.org/x/crypto@v0.52.0 golang.org/x/net@v0.55.0 golang.org/x/image@v0.42.0 \
    && go mod tidy \
    && CGO_ENABLED=0 make build TAGS="bindata timetzdata gogit"

FROM docker.io/library/alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
RUN apk upgrade --no-cache \
    && apk add --no-cache bash gettext ca-certificates tzdata dumb-init git \
    && addgroup -g 1000 git \
    && adduser -D -H -h /var/lib/gitea/git -s /bin/sh -u 1000 -G git git \
    && mkdir -p /var/lib/gitea /etc/gitea /tmp/gitea \
    && chown -R 1000:1000 /var/lib/gitea /etc/gitea /tmp/gitea
COPY --from=build /src/gitea /usr/local/bin/gitea
COPY --from=upstream /usr/local/bin/environment-to-ini /usr/local/bin/environment-to-ini
COPY --from=upstream /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=upstream /usr/local/bin/docker-setup.sh /usr/local/bin/docker-setup.sh
COPY --from=upstream /etc/templates/app.ini /etc/templates/app.ini
RUN mkdir -p /app/gitea \
    && ln -s /usr/local/bin/gitea /app/gitea/gitea
ENV GITEA_WORK_DIR=/var/lib/gitea \
    GITEA_CUSTOM=/var/lib/gitea/custom \
    GITEA_TEMP=/tmp/gitea \
    TMPDIR=/tmp/gitea \
    GITEA_APP_INI=/etc/gitea/app.ini \
    HOME=/var/lib/gitea/git \
    DISABLE_SSH=true
WORKDIR /var/lib/gitea
VOLUME ["/var/lib/gitea", "/etc/gitea"]
EXPOSE 3000
USER 1000:1000
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
