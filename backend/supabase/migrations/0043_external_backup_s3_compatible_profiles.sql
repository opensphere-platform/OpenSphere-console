\set ON_ERROR_STOP on

-- External backup is an S3-compatible contract. `vendor` identifies the UI
-- profile used to help the operator; it is not an allow-list for the executor.
-- Existing Backblaze targets remain unchanged and immediately satisfy the
-- generalized constraints.
ALTER TABLE console.external_backup_target
  DROP CONSTRAINT IF EXISTS external_backup_target_vendor_check,
  DROP CONSTRAINT IF EXISTS external_backup_target_endpoint_check,
  DROP CONSTRAINT IF EXISTS external_backup_target_region_check;

ALTER TABLE console.external_backup_target
  ALTER COLUMN vendor SET DEFAULT 's3-compatible',
  ADD CONSTRAINT external_backup_target_vendor_check
    CHECK (vendor ~ '^[a-z0-9][a-z0-9.-]{1,63}$'),
  ADD CONSTRAINT external_backup_target_endpoint_check
    CHECK (endpoint ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$'),
  ADD CONSTRAINT external_backup_target_region_check
    CHECK (region ~ '^[a-z0-9][a-z0-9._-]{0,63}$');

COMMENT ON COLUMN console.external_backup_target.vendor IS
  'Operator-facing S3 configuration profile such as s3-compatible, aws-s3, backblaze-b2, cloudflare-r2, minio or ceph-rgw; never an executor allow-list.';
COMMENT ON COLUMN console.external_backup_target.endpoint IS
  'HTTPS origin for an AWS Signature Version 4 compatible S3 API. Paths, queries and embedded credentials are rejected by the API and executor.';
