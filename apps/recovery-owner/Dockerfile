FROM docker.io/supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00

# This image is intentionally separate from Console application images.  It
# holds the PostgreSQL client/server tools used by an isolated drill, the S3
# client and a tiny AES-GCM evidence writer; it is never mounted by a Console
# request-serving workload.
USER root
# Match the release-owned Supabase PostgreSQL runtime, including vector and
# installed extensions. A generic PostgreSQL image cannot restore this dump.
RUN apk add --no-cache \
      aws-cli \
      ca-certificates \
      coreutils \
      nodejs \
      tar

WORKDIR /opt/opensphere-recovery
COPY entrypoint.mjs ./entrypoint.mjs
COPY external-channel-api.js external-channel-server.js owner-admission.js owner-policy.js ./

RUN addgroup -S -g 10001 recovery \
    && adduser -S -D -H -u 10001 -G recovery recovery \
    && mkdir -p /work \
    && chown recovery:recovery /work

USER 10001:10001

ENTRYPOINT ["node", "/opt/opensphere-recovery/entrypoint.mjs"]
