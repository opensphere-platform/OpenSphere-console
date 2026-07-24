# Kubernetes feature source

The RCC Kubernetes feature is based on the environment-specific Cluster
Manager implementation maintained at:

- Repository: `https://github.com/opensphere-platform/OpenSphere-shell-clusterManager.git`
- Source revision: `f5c57cdcfc92faa638764ebcb2f16ac1200bd01a`
- Source package version: `1.3.3`

The source was integrated as a native Angular feature instead of loading it
through DUPA or an Angular Element. RCC-specific changes include:

- same-origin API routing through `/api/control-centers/:ccId/k8s`;
- Supabase operator and control-center authorization;
- server-held, read-only Kubernetes credentials;
- disabled mutation, exec, and VNC actions;
- append-only Supabase audit events.

When updating this feature, review the upstream diff from the revision above
and keep the RCC authentication, authorization, and read-only boundaries.
