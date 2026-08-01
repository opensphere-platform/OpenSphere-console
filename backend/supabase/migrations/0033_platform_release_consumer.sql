\set ON_ERROR_STOP on

-- L3 Platform Release is a reviewed Console consumer. The browser and OS CLI
-- submit the same immutable release-lock declaration; only the dedicated
-- reconciler may dispatch the upgrade executor and only the executor reports
-- the observed installation-lock result.
INSERT INTO console.consumer_contract (
  consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets,
  gitea_repository, gitea_path, reconciler, observability_claim, status, metadata
) VALUES (
  'platform-release',
  'OpenSphere Platform Release',
  'console-native',
  ARRAY['console','audit'],
  ARRAY[]::text[],
  'opensphere/platform-declarations',
  'platform-release/',
  'platform-release-reconciler',
  'platform-release',
  'Unknown',
  '{
    "authority":"Gitea reviewed exact release lock + isolated Kubernetes executor receipt",
    "contract":"opensphere.platform.release/v1",
    "requires":"recent operator AAL2 + two-person approval",
    "execution":"dedicated Job; no browser, Console Backend, or local kubeconfig apply",
    "rollback":"transactional Setup verification restores the previous signed release",
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
VALUES ('platform-release', ARRAY['metrics','logs'])
ON CONFLICT (consumer_id) DO UPDATE SET
  requested_capabilities = EXCLUDED.requested_capabilities,
  updated_at = clock_timestamp();
