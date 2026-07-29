\set ON_ERROR_STOP on

-- PFS control-plane establishment is a reviewed declarative consumer. The
-- browser and Foundation subShell cannot apply this contract; only the
-- dedicated, catalog-pinned reconciler can claim its merged requests.
INSERT INTO console.consumer_contract (
  consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets,
  gitea_repository, gitea_path, reconciler, observability_claim, status, metadata
) VALUES (
  'foundation-bootstrap',
  'Platform Foundation Service Stack Bootstrap',
  'platform',
  ARRAY['console','audit'],
  ARRAY[]::text[],
  'opensphere/platform-declarations',
  'foundation-bootstrap/',
  'foundation-bootstrap-reconciler',
  'foundation-bootstrap',
  'Unknown',
  '{
    "authority":"Gitea reviewed fixed catalog + Kubernetes observed receipt",
    "contract":"opensphere.foundation.bootstrap/v1",
    "catalogVersion":"20260728.1",
    "catalogSha256":"213d48cd7ddf6b67bfc718cfb8975309a65c8e6f65bbe3f5afdc29625d5cd070",
    "requires":"PlatformSupportProfile/default Ready",
    "browserWrite":false
  }'::jsonb
)
ON CONFLICT (consumer_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  owner_kind = EXCLUDED.owner_kind,
  supabase_schemas = EXCLUDED.supabase_schemas,
  storage_buckets = EXCLUDED.storage_buckets,
  gitea_repository = EXCLUDED.gitea_repository,
  gitea_path = EXCLUDED.gitea_path,
  reconciler = EXCLUDED.reconciler,
  observability_claim = EXCLUDED.observability_claim,
  metadata = EXCLUDED.metadata,
  updated_at = clock_timestamp();

INSERT INTO console.observability_claim (consumer_id, requested_capabilities)
VALUES ('foundation-bootstrap', ARRAY['metrics','logs'])
ON CONFLICT (consumer_id) DO UPDATE SET
  requested_capabilities = EXCLUDED.requested_capabilities,
  updated_at = clock_timestamp();
