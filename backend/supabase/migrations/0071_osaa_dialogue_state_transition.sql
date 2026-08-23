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
  osaa.dialogue_state_transition, osaa.dialogue_state_purge_receipt
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON osaa.dialogue_state_projection TO opensphere_osaa_gateway;
GRANT SELECT, INSERT ON osaa.dialogue_state_transition TO opensphere_osaa_gateway;
REVOKE UPDATE, DELETE, TRUNCATE ON osaa.dialogue_state_transition FROM opensphere_osaa_gateway;
REVOKE ALL ON FUNCTION osaa.purge_dialogue_state(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION osaa.purge_dialogue_state(uuid, text) TO opensphere_console_backend;

COMMENT ON TABLE osaa.dialogue_state_projection IS
  'CBSS-owned current OSAA Dialogue State projection. It is not an authorization or resource-state authority.';
COMMENT ON TABLE osaa.dialogue_state_transition IS
  'Conversation-scoped OSAA Dialogue State transition chain, atomically committed with the assistant turn.';
COMMENT ON TABLE osaa.dialogue_state_purge_receipt IS
  'User-content-free receipt proving an authorized retention purge of Dialogue State data.';
