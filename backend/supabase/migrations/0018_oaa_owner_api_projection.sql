\set ON_ERROR_STOP on

-- OAA correlates two sanitized observation classes in the same expiring
-- projection: live Kubernetes resources and authenticated owner-facade status.
-- Neither class transfers authority to Supabase. Owner-facade rows are written
-- only under source=owner-api and stale rows are never presented as current.

CREATE INDEX IF NOT EXISTS runtime_resource_source_freshness_idx
  ON oaa.runtime_resource (source, expires_at DESC, kind, namespace);

CREATE INDEX IF NOT EXISTS runtime_event_source_observed_idx
  ON oaa.runtime_event (source, observed_at DESC, kind, namespace);

COMMENT ON TABLE oaa.runtime_resource IS
  'Expiring sanitized observation projection. Kubernetes and each authenticated owner API remain live authorities; Supabase is a fallback/read-model and correlation store.';

COMMENT ON TABLE oaa.runtime_event IS
  'Append-only digest evidence of sanitized Kubernetes watch and owner-API state changes. Secrets, ConfigMap values, Pod env, credentials, raw logs, prompts, and responses are excluded.';

