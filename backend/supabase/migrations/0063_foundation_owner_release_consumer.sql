\set ON_ERROR_STOP on

-- The Foundation owner mirror is updated only from a reviewed Gitea
-- declaration. The browser-facing Backend persists the intent; a dedicated
-- reconciler dispatches the exact executor Job and records its fenced
-- installation-lock receipt through the shared change_execution ledger.
INSERT INTO console.consumer_contract (
  consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets,
  gitea_repository, gitea_path, reconciler, observability_claim, status, metadata
) VALUES (
  'foundation-owner-release',
  'Foundation Owner Component Release',
  'console-native',
  ARRAY['console','audit'],
  ARRAY[]::text[],
  'opensphere/platform-declarations',
  'foundation-owner-release/',
  'foundation-owner-release-reconciler',
  'foundation-owner-release',
  'Unknown',
  '{
    "authority":"signed edge publication + reviewed Gitea merge + isolated executor receipt",
    "contract":"opensphere.foundation.owner.release/v1",
    "requires":"docker-desktop audience-bound release-controller identity",
    "execution":"dedicated exact Job with owner installation-lock CAS",
    "rollback":"executor restores the previous exact image before a failed receipt",
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
VALUES ('foundation-owner-release', ARRAY['metrics','logs'])
ON CONFLICT (consumer_id) DO UPDATE SET
  requested_capabilities = EXCLUDED.requested_capabilities,
  updated_at = clock_timestamp();

-- 0058 intentionally made retries idempotent, but its conflict branch returned
-- an existing request without proving that the reused key described the same
-- immutable intent. Close that alias at the database boundary for every
-- governed consumer, including Foundation owner releases.
CREATE OR REPLACE FUNCTION console.begin_change(
  p_request_id uuid,
  p_idempotency_key text,
  p_actor_type text,
  p_actor_id uuid,
  p_action text,
  p_target text,
  p_reason text,
  p_payload_digest text DEFAULT NULL
) RETURNS console.change_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE
  created console.change_request;
  hash_input text;
  event_digest text;
BEGIN
  IF length(btrim(p_reason)) < 4 THEN RAISE EXCEPTION 'management reason is required'; END IF;
  IF p_actor_type NOT IN ('human', 'service', 'break_glass') THEN RAISE EXCEPTION 'invalid actor type'; END IF;
  IF p_payload_digest IS NOT NULL AND p_payload_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid payload digest';
  END IF;

  INSERT INTO console.change_request (
    request_id, idempotency_key, actor_type, actor_id, action, target, reason, payload_digest, status
  ) VALUES (
    p_request_id, p_idempotency_key, p_actor_type, p_actor_id, p_action, p_target,
    btrim(p_reason), p_payload_digest, 'intent'
  )
  ON CONFLICT (idempotency_key) DO UPDATE
    SET idempotency_key = EXCLUDED.idempotency_key
    WHERE change_request.actor_type IS NOT DISTINCT FROM EXCLUDED.actor_type
      AND change_request.actor_id IS NOT DISTINCT FROM EXCLUDED.actor_id
      AND change_request.action IS NOT DISTINCT FROM EXCLUDED.action
      AND change_request.target IS NOT DISTINCT FROM EXCLUDED.target
      AND change_request.reason IS NOT DISTINCT FROM EXCLUDED.reason
      AND change_request.payload_digest IS NOT DISTINCT FROM EXCLUDED.payload_digest
  RETURNING * INTO created;

  IF created IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'idempotency key reused with a different governed change';
  END IF;
  IF created.request_id <> p_request_id THEN RETURN created; END IF;

  hash_input := concat_ws('|', p_request_id::text, p_actor_type, p_actor_id::text,
    p_action, p_target, btrim(p_reason), coalesce(p_payload_digest, ''), 'intent');
  event_digest := encode(digest(hash_input, 'sha256'), 'hex');
  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action, target_type,
    target_id, reason, phase, result, payload_digest, event_hash
  ) VALUES (
    p_request_id, p_request_id::text, p_actor_type, p_actor_id, p_action, 'declarative-change',
    p_target, btrim(p_reason), 'intent', 'recorded', p_payload_digest, event_digest
  ) ON CONFLICT (request_id, phase, event_hash) DO NOTHING;
  RETURN created;
END;
$$;
