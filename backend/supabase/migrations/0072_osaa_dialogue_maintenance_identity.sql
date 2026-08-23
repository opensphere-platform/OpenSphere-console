-- Move Dialogue State recovery from a PostgREST-assumable role to one
-- installer-provisioned, direct PostgreSQL login held only by Console Backend.
-- Historical migration 0071 remains immutable; this forward migration closes
-- the shared JWT signing-secret escalation path.

REVOKE opensphere_osaa_dialogue_maintenance FROM authenticator;
ALTER ROLE opensphere_osaa_dialogue_maintenance NOINHERIT NOBYPASSRLS;

CREATE OR REPLACE FUNCTION osaa.reap_expired_dialogue_turns(
  reap_limit integer
) RETURNS SETOF osaa.dialogue_turn_recovery_receipt
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
BEGIN
  IF session_user <> 'opensphere_osaa_dialogue_maintenance' THEN
    RAISE EXCEPTION 'dialogue lease reaping requires the dedicated CBSS maintenance login';
  END IF;
  IF reap_limit < 1 OR reap_limit > 1000 THEN
    RAISE EXCEPTION 'reap limit must be between 1 and 1000';
  END IF;
  RETURN QUERY
  WITH expired AS (
    SELECT m.id,m.conversation_id,c.owner_id,m.turn_request_id,
      m.lease_owner,m.lease_expires_at,m.attempt
    FROM osaa.conversation_message m
    JOIN osaa.conversation c ON c.id=m.conversation_id
    WHERE m.role='user' AND m.status='pending'
      AND m.lease_expires_at IS NOT NULL
      AND m.lease_expires_at<=clock_timestamp()
    ORDER BY m.lease_expires_at,m.id
    LIMIT reap_limit
    FOR UPDATE OF m SKIP LOCKED
  ), recovered AS (
    UPDATE osaa.conversation_message m
    SET status='failed',completed_at=clock_timestamp(),
      lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
      metadata=m.metadata || '{"recovery":"lease-reaper"}'::jsonb
    FROM expired e WHERE m.id=e.id
    RETURNING e.conversation_id,e.owner_id,e.turn_request_id,
      e.lease_owner,e.lease_expires_at,e.attempt
  )
  INSERT INTO osaa.dialogue_turn_recovery_receipt(
    conversation_id,owner_id,turn_request_id,action,reason,
    previous_lease_owner,previous_lease_expires_at,attempt,recovered_by
  )
  SELECT conversation_id,owner_id,turn_request_id,'lease-expired',
    'expired dialogue turn lease recovered by bounded reaper',
    lease_owner,lease_expires_at,attempt,session_user
  FROM recovered
  RETURNING *;
END
$$;

REVOKE ALL ON FUNCTION osaa.recover_dialogue_turn(uuid, uuid, text) FROM PUBLIC;
DROP FUNCTION osaa.recover_dialogue_turn(uuid, uuid, text);

CREATE FUNCTION osaa.recover_dialogue_turn(
  target_conversation_id uuid,
  target_turn_request_id uuid,
  expected_owner_id text,
  recovery_reason text
) RETURNS osaa.dialogue_turn_recovery_receipt
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
DECLARE
  target record;
  receipt osaa.dialogue_turn_recovery_receipt%ROWTYPE;
BEGIN
  IF session_user <> 'opensphere_osaa_dialogue_maintenance' THEN
    RAISE EXCEPTION 'dialogue turn recovery requires the dedicated CBSS maintenance login';
  END IF;
  IF length(trim(COALESCE(expected_owner_id, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'expected conversation owner is required';
  END IF;
  IF length(trim(COALESCE(recovery_reason, ''))) NOT BETWEEN 8 AND 500 THEN
    RAISE EXCEPTION 'recovery reason must contain 8 to 500 characters';
  END IF;

  SELECT m.id,m.conversation_id,c.owner_id,m.turn_request_id,
    m.lease_owner,m.lease_expires_at,m.attempt
  INTO target
  FROM osaa.conversation_message m
  JOIN osaa.conversation c ON c.id=m.conversation_id
  WHERE m.conversation_id=target_conversation_id
    AND m.turn_request_id=target_turn_request_id
    AND c.owner_id=expected_owner_id
    AND m.role='user' AND m.status='pending'
  FOR UPDATE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending conversation turn not found for expected owner';
  END IF;

  UPDATE osaa.conversation_message
  SET status='failed',completed_at=clock_timestamp(),
    lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
    metadata=metadata || '{"recovery":"admin-recovery"}'::jsonb
  WHERE id=target.id;

  INSERT INTO osaa.dialogue_turn_recovery_receipt(
    conversation_id,owner_id,turn_request_id,action,reason,
    previous_lease_owner,previous_lease_expires_at,attempt,recovered_by
  ) VALUES (
    target.conversation_id,target.owner_id,target.turn_request_id,'admin-recovery',
    trim(recovery_reason),target.lease_owner,target.lease_expires_at,
    target.attempt,session_user
  ) RETURNING * INTO receipt;
  RETURN receipt;
END
$$;

REVOKE ALL ON FUNCTION osaa.reap_expired_dialogue_turns(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION osaa.recover_dialogue_turn(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION osaa.reap_expired_dialogue_turns(integer)
  TO opensphere_osaa_dialogue_maintenance;
GRANT EXECUTE ON FUNCTION osaa.recover_dialogue_turn(uuid, uuid, text, text)
  TO opensphere_osaa_dialogue_maintenance;

COMMENT ON FUNCTION osaa.recover_dialogue_turn(uuid, uuid, text, text) IS
  'Explicit turn recovery restricted to the authenticated conversation owner supplied by Console Backend.';
