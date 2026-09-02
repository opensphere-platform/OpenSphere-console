FROM docker.io/curlimages/curl@sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6

# The bootstrap Job is a workload in the atomic Console install. Re-publishing
# this pinned utility makes every executed image visible in the signed BOM.
LABEL org.opencontainers.image.title="OpenSphere Console Beszel Bootstrap" \
      org.opencontainers.image.description="Governed bootstrap client for the Console Beszel runtime" \
      io.opensphere.release-component="beszelBootstrap"
