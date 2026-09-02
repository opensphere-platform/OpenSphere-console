FROM docker.io/henrygd/beszel-agent@sha256:8874e2c53f9de5e063a6a80d6b617e20fa593ac5dc4eb4c6ce1f912f510f38f8

# Release-owned wrapper. The upstream runtime stays byte-for-byte pinned while
# the Console candidate workflow adds OpenSphere provenance and SPDX evidence.
LABEL org.opencontainers.image.title="OpenSphere Console Beszel Agent" \
      org.opencontainers.image.description="Governed outbound-only Beszel Agent for Console baseline host observation" \
      io.opensphere.release-component="beszelAgent" \
      io.opensphere.upstream.version="0.18.7"
