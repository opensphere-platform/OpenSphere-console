\set ON_ERROR_STOP on

-- Promote the governed external Ceph prerequisite contract to v2.
-- v2 adds the restricted data-path verification namespace, RBAC and
-- default-deny policy. A changed contract digest deliberately creates a new
-- reviewed change instead of silently expanding an already-applied v1 request.
UPDATE console.consumer_contract
SET metadata = jsonb_set(
      jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{contract}',
        '"opensphere.ceph.rook-prerequisite/v2"'::jsonb,
        true
      ),
      '{runtimeChart}',
      '"opensphere-ceph-runtime/1.3.0"'::jsonb,
      true
    ),
    updated_at = clock_timestamp()
WHERE consumer_id = 'ceph-prerequisites';
