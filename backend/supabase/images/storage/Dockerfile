FROM docker.io/supabase/storage-api@sha256:c8eb9858eafec891a97c27125470aaad54703c3f4eb4d55ca7f1bf6c6411febf

LABEL org.opencontainers.image.title="OpenSphere Console Supabase Storage"

COPY --chmod=755 opensphere-storage-entrypoint.sh /usr/local/bin/opensphere-storage-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/opensphere-storage-entrypoint.sh

# storage-api exits immediately when its first PostgreSQL lookup races the
# cluster DNS/control-plane startup. Keep the process in a bounded-resource
# startup gate until both required services are resolvable and reachable; the
# Kubernetes startup probe then reports recovery without operator intervention.
ENTRYPOINT ["/usr/local/bin/opensphere-storage-entrypoint.sh"]
CMD ["node", "dist/start/server.js"]
