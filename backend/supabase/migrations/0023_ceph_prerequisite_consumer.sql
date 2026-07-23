\set ON_ERROR_STOP on

-- External Ceph prerequisite installation is a dedicated governed consumer.
-- The reviewed Gitea declaration is reconciled only by the closed,
-- chart-digest-pinned Rook prerequisite controller.
INSERT INTO console.consumer_contract (
  consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets,
  gitea_repository, gitea_path, reconciler, observability_claim, status, metadata
) VALUES (
  'ceph-prerequisites',
  'External Ceph Consumer Prerequisites',
  'subshell',
  ARRAY['console','audit'],
  ARRAY[]::text[],
  'opensphere/platform-declarations',
  'ceph-prerequisites/',
  'ceph-prerequisite-reconciler',
  'cluster-manager-ceph-prerequisites',
  'Unknown',
  '{
    "authority":"Gitea reviewed Rook release + Kubernetes observed receipt",
    "contract":"opensphere.ceph.rook-prerequisite/v1",
    "release":"rook-ceph/v1.20.2",
    "chartSha256":"6e0f10f5ca54e618fb90dd149dc9dfbc8a4932955bff2227b692fb32069daf52"
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
VALUES ('ceph-prerequisites', ARRAY['metrics','logs'])
ON CONFLICT (consumer_id) DO NOTHING;
