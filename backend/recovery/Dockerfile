FROM docker.io/library/postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193

# This image is intentionally separate from Console application images.  It
# holds the PostgreSQL client/server tools used by an isolated drill, the S3
# client and a tiny AES-GCM evidence writer; it is never mounted by a Console
# request-serving workload.
RUN apk add --no-cache \
      aws-cli \
      ca-certificates \
      coreutils \
      nodejs \
      tar

WORKDIR /opt/opensphere-recovery
COPY entrypoint.mjs ./entrypoint.mjs

RUN addgroup -S -g 10001 recovery \
    && adduser -S -D -H -u 10001 -G recovery recovery \
    && mkdir -p /work \
    && chown recovery:recovery /work

USER 10001:10001

ENTRYPOINT ["node", "/opt/opensphere-recovery/entrypoint.mjs"]
