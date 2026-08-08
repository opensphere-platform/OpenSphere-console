\set ON_ERROR_STOP on

-- Each S3-compatible target chooses its own TLS trust policy.  The certificate
-- PEM remains inside the existing encrypted external_backup_secret envelope;
-- only non-sensitive certificate metadata is projected to the Console.
ALTER TABLE console.external_backup_target
  ADD COLUMN IF NOT EXISTS tls_trust_mode text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS custom_ca_configured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS custom_ca_subject text,
  ADD COLUMN IF NOT EXISTS custom_ca_issuer text,
  ADD COLUMN IF NOT EXISTS custom_ca_valid_to timestamptz,
  ADD COLUMN IF NOT EXISTS custom_ca_fingerprint text;

ALTER TABLE console.external_backup_target
  DROP CONSTRAINT IF EXISTS external_backup_target_tls_trust_mode_check,
  DROP CONSTRAINT IF EXISTS external_backup_target_custom_ca_fingerprint_check,
  ADD CONSTRAINT external_backup_target_tls_trust_mode_check
    CHECK (tls_trust_mode IN ('system', 'custom-ca')),
  ADD CONSTRAINT external_backup_target_custom_ca_fingerprint_check
    CHECK (
      custom_ca_fingerprint IS NULL
      OR custom_ca_fingerprint ~ '^SHA-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$'
    );

UPDATE console.external_backup_target
SET
  custom_ca_configured = false,
  custom_ca_subject = NULL,
  custom_ca_issuer = NULL,
  custom_ca_valid_to = NULL,
  custom_ca_fingerprint = NULL
WHERE tls_trust_mode = 'system';

COMMENT ON COLUMN console.external_backup_target.tls_trust_mode IS
  'Per-target TLS validation policy: system trust store or an encrypted custom CA bundle.';
COMMENT ON COLUMN console.external_backup_target.custom_ca_configured IS
  'True when the encrypted target secret contains a validated custom CA bundle.';
COMMENT ON COLUMN console.external_backup_target.custom_ca_fingerprint IS
  'SHA-256 fingerprint of the first certificate in the encrypted custom CA bundle.';
