-- PLAN-015 v1.2: CBSS-owned OSAA Dialogue State projection and transition ledger.
-- Dialogue transitions are conversation data, not Agent Runtime evidence.

ALTER TABLE osaa.conversation_message
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0);

CREATE INDEX IF NOT EXISTS conversation_message_pending_lease_idx
  ON osaa.conversation_message (lease_expires_at, conversation_id)
  WHERE role = 'user' AND status = 'pending';

CREATE TABLE osaa.dialogue_state_projection (
  conversation_id uuid PRIMARY KEY REFERENCES osaa.conversation(id) ON DELETE CASCADE,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  schema_version text NOT NULL DEFAULT 'osaa.dialogue-state/v1'
    CHECK (schema_version = 'osaa.dialogue-state/v1'),
  domain text,
  intent text,
  phase text NOT NULL DEFAULT 'idle',
  target_ref jsonb,
  slots jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(slots) = 'object'),
  missing_slots text[] NOT NULL DEFAULT ARRAY[]::text[],
  capability_ref text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  operation_ref uuid,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_turn_request_id uuid,
  state_digest text NOT NULL CHECK (state_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX dialogue_state_projection_owner_idx
  ON osaa.dialogue_state_projection (owner_id, updated_at DESC);

CREATE TABLE osaa.dialogue_state_transition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES osaa.conversation(id) ON DELETE RESTRICT,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  turn_request_id uuid NOT NULL,
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  next_revision bigint NOT NULL CHECK (next_revision = base_revision + 1),
  prev_state_digest text NOT NULL CHECK (prev_state_digest ~ '^sha256:[0-9a-f]{64}$'),
  state_digest text NOT NULL CHECK (state_digest ~ '^sha256:[0-9a-f]{64}$'),
  delta jsonb NOT NULL CHECK (
    jsonb_typeof(delta) = 'object'
    AND delta ->> 'schema' = 'osaa.dialogue-state-delta/v1'
  ),
  capability_ref text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  operation_ref uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, turn_request_id),
  UNIQUE (conversation_id, next_revision)
);

CREATE INDEX dialogue_state_transition_chain_idx
  ON osaa.dialogue_state_transition (conversation_id, next_revision);

CREATE TABLE osaa.dialogue_state_purge_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  transition_count bigint NOT NULL CHECK (transition_count >= 0),
  terminal_state_digest text CHECK (
    terminal_state_digest IS NULL OR terminal_state_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  purged_by text NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE osaa.dialogue_turn_recovery_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  turn_request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('lease-expired', 'admin-recovery')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  previous_lease_owner text,
  previous_lease_expires_at timestamptz,
  attempt integer NOT NULL CHECK (attempt >= 0),
  recovered_by text NOT NULL CHECK (length(recovered_by) BETWEEN 1 AND 200),
  recovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, turn_request_id, attempt, action)
);

CREATE OR REPLACE FUNCTION osaa.reject_dialogue_state_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('opensphere.dialogue_state_purge', true) = 'enabled' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'OSAA dialogue state transitions are append-only during retention';
END
$$;

CREATE TRIGGER dialogue_state_transition_append_only
  BEFORE UPDATE OR DELETE ON osaa.dialogue_state_transition
  FOR EACH ROW EXECUTE FUNCTION osaa.reject_dialogue_state_mutation();
ALTER TABLE osaa.dialogue_state_transition
  ENABLE ALWAYS TRIGGER dialogue_state_transition_append_only;

CREATE OR REPLACE FUNCTION osaa.reject_dialogue_purge_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OSAA dialogue state purge receipts are append-only';
END
$$;

CREATE TRIGGER dialogue_state_purge_receipt_append_only
  BEFORE UPDATE OR DELETE ON osaa.dialogue_state_purge_receipt
  FOR EACH ROW EXECUTE FUNCTION osaa.reject_dialogue_purge_receipt_mutation();
ALTER TABLE osaa.dialogue_state_purge_receipt
  ENABLE ALWAYS TRIGGER dialogue_state_purge_receipt_append_only;

CREATE TRIGGER dialogue_turn_recovery_receipt_append_only
  BEFORE UPDATE OR DELETE ON osaa.dialogue_turn_recovery_receipt
  FOR EACH ROW EXECUTE FUNCTION osaa.reject_dialogue_purge_receipt_mutation();
ALTER TABLE osaa.dialogue_turn_recovery_receipt
  ENABLE ALWAYS TRIGGER dialogue_turn_recovery_receipt_append_only;

CREATE OR REPLACE FUNCTION osaa.reap_expired_dialogue_turns(
  reap_limit integer,
  recovery_actor text
) RETURNS SETOF osaa.dialogue_turn_recovery_receipt
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
BEGIN
  IF reap_limit < 1 OR reap_limit > 1000 THEN
    RAISE EXCEPTION 'reap limit must be between 1 and 1000';
  END IF;
  IF length(trim(COALESCE(recovery_actor, ''))) < 1 THEN
    RAISE EXCEPTION 'recovery actor is required';
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
    lease_owner,lease_expires_at,attempt,trim(recovery_actor)
  FROM recovered
  RETURNING *;
END
$$;

CREATE OR REPLACE FUNCTION osaa.recover_dialogue_turn(
  target_conversation_id uuid,
  target_turn_request_id uuid,
  recovery_actor text,
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
  IF length(trim(COALESCE(recovery_actor, ''))) < 1 THEN
    RAISE EXCEPTION 'recovery actor is required';
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
    AND m.role='user' AND m.status='pending'
  FOR UPDATE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending conversation turn not found';
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
    target.attempt,trim(recovery_actor)
  ) RETURNING * INTO receipt;
  RETURN receipt;
END
$$;

-- Rows left pending by a pre-lease Gateway are made explicitly recoverable.
-- The runtime reaper will close them and emit one content-free receipt.
UPDATE osaa.conversation_message
SET lease_owner='migration-needs-reconciliation',
  lease_expires_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
  attempt=GREATEST(attempt,1),
  metadata=metadata || '{"recovery":"migration-needs-reconciliation"}'::jsonb
WHERE role='user' AND status='pending' AND lease_expires_at IS NULL;

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
BEGIN
  IF length(trim(COALESCE(purge_reason, ''))) < 8 THEN
    RAISE EXCEPTION 'purge reason must contain at least 8 characters';
  END IF;

  SELECT * INTO target
  FROM osaa.conversation
  WHERE id = target_conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found';
  END IF;
  IF target.deleted_at IS NULL
     AND (target.retention_days IS NULL
       OR target.created_at + make_interval(days => target.retention_days) > clock_timestamp()) THEN
    RAISE EXCEPTION 'conversation is not eligible for retention purge';
  END IF;
  IF EXISTS (
    SELECT 1 FROM osaa.conversation_message
    WHERE conversation_id = target.id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'conversation has a pending turn';
  END IF;

  SELECT count(*), max(state_digest) FILTER (
    WHERE next_revision = (SELECT max(next_revision)
      FROM osaa.dialogue_state_transition WHERE conversation_id = target.id)
  )
  INTO transition_total, terminal_digest
  FROM osaa.dialogue_state_transition
  WHERE conversation_id = target.id;

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
  RETURN receipt;
END
$$;

ALTER TABLE osaa.dialogue_state_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_state_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_state_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_state_transition FORCE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_state_purge_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_state_purge_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_turn_recovery_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_turn_recovery_receipt FORCE ROW LEVEL SECURITY;

-- Replace the 0063 Gateway-wide policies with actor-bound ownership. The
-- Gateway must set opensphere.actor_id transaction-locally for every access.
DROP POLICY IF EXISTS osaa_gateway_conversation ON osaa.conversation;
DROP POLICY IF EXISTS osaa_gateway_conversation_message ON osaa.conversation_message;
ALTER TABLE osaa.conversation FORCE ROW LEVEL SECURITY;
ALTER TABLE osaa.conversation_message FORCE ROW LEVEL SECURITY;
CREATE POLICY osaa_gateway_conversation_select
  ON osaa.conversation FOR SELECT TO opensphere_osaa_gateway
  USING (owner_id=current_setting('opensphere.actor_id', true));
CREATE POLICY osaa_gateway_conversation_insert
  ON osaa.conversation FOR INSERT TO opensphere_osaa_gateway
  WITH CHECK (owner_id=current_setting('opensphere.actor_id', true));
CREATE POLICY osaa_gateway_conversation_update
  ON osaa.conversation FOR UPDATE TO opensphere_osaa_gateway
  USING (owner_id=current_setting('opensphere.actor_id', true))
  WITH CHECK (owner_id=current_setting('opensphere.actor_id', true));
CREATE POLICY osaa_gateway_conversation_message_select
  ON osaa.conversation_message FOR SELECT TO opensphere_osaa_gateway
  USING (EXISTS (
    SELECT 1 FROM osaa.conversation c
    WHERE c.id=conversation_id
      AND c.owner_id=current_setting('opensphere.actor_id', true)
  ));
CREATE POLICY osaa_gateway_conversation_message_insert
  ON osaa.conversation_message FOR INSERT TO opensphere_osaa_gateway
  WITH CHECK (EXISTS (
    SELECT 1 FROM osaa.conversation c
    WHERE c.id=conversation_id
      AND c.owner_id=current_setting('opensphere.actor_id', true)
  ));
CREATE POLICY osaa_gateway_conversation_message_update
  ON osaa.conversation_message FOR UPDATE TO opensphere_osaa_gateway
  USING (EXISTS (
    SELECT 1 FROM osaa.conversation c
    WHERE c.id=conversation_id
      AND c.owner_id=current_setting('opensphere.actor_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM osaa.conversation c
    WHERE c.id=conversation_id
      AND c.owner_id=current_setting('opensphere.actor_id', true)
  ));

CREATE POLICY osaa_gateway_dialogue_projection_select
  ON osaa.dialogue_state_projection FOR SELECT TO opensphere_osaa_gateway
  USING (owner_id = current_setting('opensphere.actor_id', true));
CREATE POLICY osaa_gateway_dialogue_projection_insert
  ON osaa.dialogue_state_projection FOR INSERT TO opensphere_osaa_gateway
  WITH CHECK (owner_id = current_setting('opensphere.actor_id', true));
CREATE POLICY osaa_gateway_dialogue_projection_update
  ON osaa.dialogue_state_projection FOR UPDATE TO opensphere_osaa_gateway
  USING (owner_id = current_setting('opensphere.actor_id', true))
  WITH CHECK (owner_id = current_setting('opensphere.actor_id', true));
CREATE POLICY osaa_gateway_dialogue_transition_select
  ON osaa.dialogue_state_transition FOR SELECT TO opensphere_osaa_gateway
  USING (owner_id = current_setting('opensphere.actor_id', true));
CREATE POLICY osaa_gateway_dialogue_transition_insert
  ON osaa.dialogue_state_transition FOR INSERT TO opensphere_osaa_gateway
  WITH CHECK (owner_id = current_setting('opensphere.actor_id', true));

REVOKE ALL ON osaa.dialogue_state_projection,
  osaa.dialogue_state_transition, osaa.dialogue_state_purge_receipt,
  osaa.dialogue_turn_recovery_receipt
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON osaa.dialogue_state_projection TO opensphere_osaa_gateway;
GRANT SELECT, INSERT ON osaa.dialogue_state_transition TO opensphere_osaa_gateway;
REVOKE UPDATE, DELETE, TRUNCATE ON osaa.dialogue_state_transition FROM opensphere_osaa_gateway;
REVOKE DELETE, TRUNCATE ON osaa.conversation, osaa.conversation_message FROM opensphere_osaa_gateway;
REVOKE ALL ON FUNCTION osaa.purge_dialogue_state(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION osaa.purge_dialogue_state(uuid, text) TO opensphere_console_backend;
REVOKE ALL ON FUNCTION osaa.reap_expired_dialogue_turns(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION osaa.recover_dialogue_turn(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION osaa.reap_expired_dialogue_turns(integer, text) TO opensphere_osaa_gateway;
GRANT EXECUTE ON FUNCTION osaa.recover_dialogue_turn(uuid, uuid, text, text) TO opensphere_osaa_gateway;

COMMENT ON TABLE osaa.dialogue_state_projection IS
  'CBSS-owned current OSAA Dialogue State projection. It is not an authorization or resource-state authority.';
COMMENT ON TABLE osaa.dialogue_state_transition IS
  'Conversation-scoped OSAA Dialogue State transition chain, atomically committed with the assistant turn.';
COMMENT ON TABLE osaa.dialogue_state_purge_receipt IS
  'User-content-free receipt proving an authorized retention purge of Dialogue State data.';
COMMENT ON TABLE osaa.dialogue_turn_recovery_receipt IS
  'Append-only, user-content-free receipt for expired lease reaping and explicit administrator turn recovery.';
