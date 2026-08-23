# OpenSphere Dialogue State Tracker (OSDST)

OSDST is a CBSS Core Service. It owns OSAA conversation state transitions,
typed dialogue projections, turn leases, and retention maintenance.

The service deliberately reuses the existing CBSS Supabase PostgreSQL database
and `osaa.*` schema. It does not introduce another database, queue, or generic
workflow framework.

Runtime boundary:

- OSAA Gateway is the only application client and calls OSDST over its typed HTTP API.
- OSDST is the single writer for conversation and dialogue-state records.
- Console Backend observes OSDST and manages its rollout mode; it does not write dialogue records.
- Identity and permissions remain owned by Console Identity and are verified per request.

Health and operations are exposed through `/healthz`, `/readyz`, `/metrics`, and
`/v1/status`. Readiness is fail-closed when either the CBSS schema or the existing
dialogue maintenance identity is unavailable.
