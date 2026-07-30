\set ON_ERROR_STOP on

-- PFS control-plane establishment is a reviewed declarative consumer. The
-- browser and Foundation subShell cannot apply this contract; only the
-- dedicated, catalog-pinned reconciler can claim its merged requests.
--
-- owner_kind 는 `console.consumer_contract` 의 닫힌 어휘를 따른다
-- (0009: 'console-native' | 'oaa' | 'subshell' | 'extension').
-- 이 소비자는 **console-native** 다. 근거:
--   - reconciler 가 Console Backend 구성요소이고(backend/opensphere-console-backend/
--     foundation-bootstrap-reconciler.js) Deployment 가 opensphere-console 네임스페이스에서 돈다
--   - 쓰는 스키마가 console·audit 로 콘솔 자신의 것이다
--   - 위 주석대로 Foundation subShell 은 이 계약을 적용할 수 없다 → 'subshell' 이 아니다
-- 같은 모양의 선례가 'manual'(Console Manual Registry, console-native, reconciler=manual-ingest) 이다.
-- 어휘를 늘리지 않는 이유: owner_kind 는 "누가 lifecycle 을 소유하는가" 의 닫힌 분류이고
-- (arch-002 INV-SRL-03 단일 소유), 이 행의 소유자는 콘솔 제어 평면이라 새 범주가 필요 없다.
-- 코드에도 'platform' 분기가 없다(owner_kind 는 표시용으로만 투영된다).
INSERT INTO console.consumer_contract (
  consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets,
  gitea_repository, gitea_path, reconciler, observability_claim, status, metadata
) VALUES (
  'foundation-bootstrap',
  'Platform Foundation Service Stack Bootstrap',
  'console-native',
  ARRAY['console','audit'],
  ARRAY[]::text[],
  'opensphere/platform-declarations',
  'foundation-bootstrap/',
  'foundation-bootstrap-reconciler',
  'console-foundation-bootstrap',
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
