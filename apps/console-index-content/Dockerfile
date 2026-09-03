# Context: apps/console-index-content. No Angular/npm/Node runtime.
FROM docker.io/library/busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23
ARG VERSION
ARG SOURCE_REVISION
LABEL org.opencontainers.image.title="OpenSphere Console index content" \
      org.opencontainers.image.source="https://github.com/opensphere-platform/OpenSphere-console" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$VERSION \
      io.opensphere.component="consoleIndexContent"
COPY dist/ /content/
COPY prepare-content.sh /usr/local/bin/prepare-content.sh
USER 101:101
ENTRYPOINT ["/bin/sh", "/usr/local/bin/prepare-content.sh"]
