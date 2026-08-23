-- PLAN-016: OSDST is the sole Dialogue State runtime and maintenance owner.
-- Reuse the existing CBSS maintenance login; no database, role or queue is added.

CREATE OR REPLACE FUNCTION osaa.purge_dialogue_state(
  target_conversation_id uuid,
  purge_reason text
) RETURNS osaa.dialogue_state_purge_receipt
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
DECLARE
  target osaa.conversation%ROWTYPE;
  transition_total bigint;
  terminal_digest text;
  receipt osaa.dialogue_state_purge_receipt%ROWTYPE;
  purge_request_id uuid := gen_random_uuid();
BEGIN
  IF session_user <> 'opensphere_osaa_dialogue_maintenance' THEN
    RAISE EXCEPTION 'dialogue purge requires the OSDST maintenance identity';
  END IF;
  IF length(trim(COALESCE(purge_reason, ''))) < 8 THEN
    RAISE EXCEPTION 'purge reason must contain at least 8 characters';
  END IF;

  SELECT * INTO target FROM osaa.conversation
  WHERE id = target_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found'; END IF;
  IF target.deleted_at IS NULL OR target.retention_days IS NULL
     OR target.deleted_at + make_interval(days => target.retention_days) > clock_timestamp() THEN
    RAISE EXCEPTION 'conversation is not eligible for retention purge';
  END IF;
  IF EXISTS (SELECT 1 FROM osaa.conversation_message
    WHERE conversation_id = target.id AND status = 'pending') THEN
    RAISE EXCEPTION 'conversation has a pending turn';
  END IF;

  SELECT count(*), max(state_digest) FILTER (
    WHERE next_revision = (SELECT max(next_revision)
      FROM osaa.dialogue_state_transition WHERE conversation_id = target.id)
  ) INTO transition_total, terminal_digest
  FROM osaa.dialogue_state_transition WHERE conversation_id = target.id;

  PERFORM set_config('opensphere.dialogue_state_purge', 'enabled', true);
  DELETE FROM osaa.dialogue_state_transition WHERE conversation_id = target.id;
  DELETE FROM osaa.dialogue_state_projection WHERE conversation_id = target.id;

  INSERT INTO osaa.dialogue_state_purge_receipt(
    conversation_id, owner_id, reason, transition_count,
    terminal_state_digest, purged_by
  ) VALUES (
    target.id, target.owner_id, trim(purge_reason), transition_total,
    terminal_digest, session_user
  ) RETURNING * INTO receipt;

  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action,
    target_type, target_id, reason, phase, result, payload_digest, event_hash
  ) VALUES (
    purge_request_id, 'osaa-dialogue-purge:' || target.id::text, 'service', NULL,
    'osaa-dialogue-state-purge', 'Conversation', target.id::text,
    trim(purge_reason), 'applied', format('purged %s transition(s)', transition_total),
    terminal_digest, encode(extensions.digest(convert_to(
      purge_request_id::text || '|' || target.id::text || '|' || transition_total::text || '|' || trim(purge_reason),
      'UTF8'
    ), 'sha256'), 'hex')
  );
  RETURN receipt;
END
$$;

CREATE OR REPLACE FUNCTION osaa.purge_eligible_dialogue_state(purge_limit integer DEFAULT 25)
RETURNS SETOF osaa.dialogue_state_purge_receipt
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
DECLARE
  candidate record;
BEGIN
  IF session_user <> 'opensphere_osaa_dialogue_maintenance' THEN
    RAISE EXCEPTION 'scheduled dialogue purge requires the OSDST maintenance identity';
  END IF;
  IF purge_limit < 1 OR purge_limit > 100 THEN
    RAISE EXCEPTION 'dialogue purge limit must be between 1 and 100';
  END IF;
  FOR candidate IN
    SELECT c.id
    FROM osaa.conversation c
    WHERE c.deleted_at IS NOT NULL
      AND c.retention_days IS NOT NULL
      AND c.deleted_at + make_interval(days => c.retention_days) <= clock_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM osaa.conversation_message m
        WHERE m.conversation_id = c.id AND m.status = 'pending'
      )
    ORDER BY COALESCE(c.deleted_at, c.created_at), c.id
    LIMIT purge_limit
    FOR UPDATE OF c SKIP LOCKED
  LOOP
    RETURN NEXT osaa.purge_dialogue_state(
      candidate.id,
      'scheduled OSDST dialogue retention expiry'
    );
  END LOOP;
  RETURN;
END
$$;

REVOKE ALL ON FUNCTION osaa.purge_dialogue_state(uuid, text) FROM PUBLIC, opensphere_console_backend;
GRANT EXECUTE ON FUNCTION osaa.purge_dialogue_state(uuid, text)
  TO opensphere_osaa_dialogue_maintenance;
REVOKE ALL ON FUNCTION osaa.purge_eligible_dialogue_state(integer) FROM PUBLIC, opensphere_console_backend;
GRANT EXECUTE ON FUNCTION osaa.purge_eligible_dialogue_state(integer)
  TO opensphere_osaa_dialogue_maintenance;

COMMENT ON FUNCTION osaa.purge_eligible_dialogue_state(integer) IS
  'OSDST-owned bounded retention purge using the existing dedicated CBSS dialogue maintenance login.';
