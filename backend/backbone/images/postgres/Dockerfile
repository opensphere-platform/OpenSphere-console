FROM docker.io/library/postgres:19beta1-alpine@sha256:d2e89cb432902a3b7a9d447a587fffeea0b4cddff5a07784241d35e1a16de253 AS build
ARG PGVECTOR_VERSION=0.8.5
ARG PGVECTOR_SHA256=6f88a5cbdde31666f4b6c1a6b75c51dcbeffe58f9a7d2b26e502d5a6e5e14d44
RUN apk add --no-cache build-base clang21 llvm21-dev wget ca-certificates \
    && wget -q -O /tmp/pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
    && echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - \
    && mkdir /tmp/pgvector \
    && tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector --strip-components=1 \
    && make -C /tmp/pgvector NO_BC=1 \
    && make -C /tmp/pgvector NO_BC=1 DESTDIR=/stage install

FROM docker.io/library/postgres:19beta1-alpine@sha256:d2e89cb432902a3b7a9d447a587fffeea0b4cddff5a07784241d35e1a16de253 AS runtime
RUN apk upgrade --no-cache \
    && apk add --no-cache curl \
    && rm -f /usr/local/bin/gosu
COPY --from=build /stage/ /

FROM scratch
COPY --from=runtime / /
ENV LANG=en_US.utf8 \
    PG_MAJOR=19 \
    PG_VERSION=19beta1 \
    PGDATA=/var/lib/postgresql/19/docker
VOLUME ["/var/lib/postgresql"]
EXPOSE 5432
USER 70:70
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["postgres"]
STOPSIGNAL SIGINT
