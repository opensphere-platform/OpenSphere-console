\set ON_ERROR_STOP on

-- A governed change already records the payload digest in the append-only audit
-- event. Persist the same correlation key on change_request so closed change
-- templates can find their own latest request without scanning audit payloads.

ALTER TABLE console.change_request
  ADD COLUMN IF NOT EXISTS payload_digest text
  CHECK (payload_digest IS NULL OR payload_digest ~ '^sha256:[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS change_request_template_lookup_idx
  ON console.change_request (target, action, payload_digest, created_at DESC);

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
  ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING * INTO created;

  IF created.request_id <> p_request_id THEN
    RETURN created;
  END IF;

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

COMMENT ON COLUMN console.change_request.payload_digest IS
  'Immutable digest of the governed desired payload; used to correlate closed change templates with their request.';
