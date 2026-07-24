# PolyON Region Control Center — CC2

This directory contains the first CC2 deployment baseline for the PolyON
Region Control Center.

## Public endpoint

- URL: `https://rcc.cc2.opl.io.kr`
- Required DNS record: `rcc.cc2.opl.io.kr. 300 IN A 158.180.78.77`
- Ingress: Traefik `websecure`
- Certificate resolver: `letsencrypt`

DNS must resolve publicly before Traefik can complete the ACME HTTP challenge.

## Runtime boundaries

- `polyon-rcc`: Web, backend API, read-only Kubernetes proxy
- `polyon-rcc-data`: Supabase identity, PostgreSQL, PostgREST, Storage
- `polyon-rcc-change`: private Gitea change authority and PostgreSQL

The existing `headlamp` namespace is not modified or removed.

The RCC backend ServiceAccount may read the allowlisted Kubernetes resources.
It cannot read Secrets or create, update, patch, or delete Kubernetes objects.
Browser requests require a Supabase administrator session and an explicit
`operator_control_center` assignment for `cc2`.

## Deployment

Run from the repository root:

```sh
./deploy/rcc/deploy-cc2.sh
```

The script builds arm64 images locally, imports them into CC2 K3s, installs the
isolated Supabase and Gitea authorities when absent, and applies the RCC
workloads. It does not configure public DNS and does not remove the existing
Headlamp deployment.
