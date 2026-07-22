\set ON_ERROR_STOP on

-- OCI digest revocation is Console security state, not a controller-local or
-- legacy PostgreSQL ledger.  It is append-only so a revoked artifact can
-- never be silently reinstated by editing history.
CREATE TABLE IF NOT EXISTS console.image_revocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository text NOT NULL CHECK (repository ~ '^ghcr\\.io/opensphere-platform/[a-z0-9._-]+$'),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  replacement_digest text CHECK (replacement_digest IS NULL OR replacement_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_id uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  actor_label text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  operation_id text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (repository, digest)
);

CREATE INDEX IF NOT EXISTS image_revocation_revoked_at_idx
  ON console.image_revocation (revoked_at DESC);

CREATE OR REPLACE FUNCTION console.reject_image_revocation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'console.image_revocation is append-only';
END;
$$;

DROP TRIGGER IF EXISTS image_revocation_append_only ON console.image_revocation;
CREATE TRIGGER image_revocation_append_only
  BEFORE UPDATE OR DELETE ON console.image_revocation
  FOR EACH ROW EXECUTE FUNCTION console.reject_image_revocation_mutation();
ALTER TABLE console.image_revocation ENABLE ALWAYS TRIGGER image_revocation_append_only;
ALTER TABLE console.image_revocation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS console_backend_image_revocation_read ON console.image_revocation;
CREATE POLICY console_backend_image_revocation_read ON console.image_revocation
  FOR SELECT TO opensphere_console_backend USING (true);
DROP POLICY IF EXISTS console_backend_image_revocation_insert ON console.image_revocation;
CREATE POLICY console_backend_image_revocation_insert ON console.image_revocation
  FOR INSERT TO opensphere_console_backend WITH CHECK (true);

GRANT SELECT, INSERT ON console.image_revocation TO opensphere_console_backend;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON console.image_revocation FROM anon, authenticated;
-- DUPA uses the Supabase service JWT only for this controller-owned, append-
-- only security path.  It does not receive mutable application-table grants.
GRANT USAGE ON SCHEMA console, audit TO service_role;
GRANT SELECT ON console.image_revocation TO service_role;
GRANT SELECT, INSERT ON audit.event TO service_role;

CREATE OR REPLACE FUNCTION console.revoke_image(
  p_repository text,
  p_digest text,
  p_replacement_digest text,
  p_actor_id uuid,
  p_actor_label text,
  p_reason text,
  p_operation_id text,
  p_request_id uuid,
  p_event_hash text
) RETURNS console.image_revocation
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit
AS $$
DECLARE
  revoked console.image_revocation;
BEGIN
  INSERT INTO console.image_revocation (
    repository, digest, replacement_digest, actor_id, actor_label, reason, operation_id
  ) VALUES (
    p_repository, p_digest, nullif(p_replacement_digest, ''), p_actor_id, p_actor_label,
    btrim(p_reason), p_operation_id
  ) RETURNING * INTO revoked;

  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action, target_type, target_id,
    reason, phase, result, payload_digest, event_hash
  ) VALUES (
    p_request_id, p_operation_id,
    CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'human' END,
    p_actor_id, 'extension-image-revoke', 'oci-image',
    p_repository || '@' || p_digest, btrim(p_reason), 'applied', 'accepted',
    'sha256:' || encode(digest(p_repository || '|' || p_digest || '|' || coalesce(p_replacement_digest, ''), 'sha256'), 'hex'),
    p_event_hash
  );
  RETURN revoked;
END;
$$;

REVOKE ALL ON FUNCTION console.revoke_image(text, text, text, uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console.revoke_image(text, text, text, uuid, text, text, text, uuid, text) TO opensphere_console_backend, service_role;
