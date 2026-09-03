-- Native OSDST authority for the current Console; no legacy console/audit schema.
-- Provenance: selected dialogue table/chain contracts from legacy 0063/0071/0072/0073.
-- Reconstructed against current identity and console_audit; does not apply legacy migrations.
-- Runtime owners: OSDST serving and OSDST maintenance, never OSAA Gateway or PostgREST.
CREATE SCHEMA IF NOT EXISTS osaa;
REVOKE ALL ON SCHEMA osaa FROM PUBLIC, anon, authenticated, service_role;
CREATE ROLE opensphere_osdst NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE opensphere_osdst_maintenance NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA osaa, extensions TO opensphere_osdst, opensphere_osdst_maintenance;
CREATE TABLE osaa.conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  title text NOT NULL DEFAULT '새 대화' CHECK (length(title) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  model_id text,
  summary text,
  retention_days integer CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  last_message_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CHECK (deleted_at IS NULL OR status = 'archived')
);

CREATE INDEX conversation_owner_recent_idx
  ON osaa.conversation (owner_id, last_message_at DESC, id)
  WHERE deleted_at IS NULL;

CREATE TABLE osaa.conversation_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES osaa.conversation(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  turn_request_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 200000),
  model_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, turn_request_id, role)
);

CREATE INDEX conversation_message_context_idx
  ON osaa.conversation_message (conversation_id, sequence DESC)
  WHERE status = 'completed';

ALTER TABLE osaa.conversation ALTER COLUMN retention_days SET DEFAULT 30;
UPDATE osaa.conversation SET retention_days = 30 WHERE retention_days IS NULL;
ALTER TABLE osaa.conversation ALTER COLUMN retention_days SET NOT NULL;

ALTER TABLE osaa.conversation_message
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 5);

CREATE INDEX conversation_message_pending_lease_idx
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

CREATE FUNCTION osaa.dialogue_genesis_digest(target_conversation_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, extensions
AS $$
  SELECT 'sha256:' || encode(
    extensions.digest(
      convert_to(
        format(
          '{"conversationId":"%s","revision":0,"schema":"osaa.dialogue-state/v1"}',
          target_conversation_id
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE FUNCTION osaa.enforce_dialogue_transition_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
DECLARE
  parent_owner text;
  expected_revision bigint;
  expected_digest text;
BEGIN
  SELECT c.owner_id INTO parent_owner
  FROM osaa.conversation c
  WHERE c.id = NEW.conversation_id
  FOR KEY SHARE;
  IF NOT FOUND OR NEW.owner_id <> parent_owner THEN
    RAISE EXCEPTION 'dialogue transition owner does not match its conversation';
  END IF;

  SELECT t.next_revision, t.state_digest
  INTO expected_revision, expected_digest
  FROM osaa.dialogue_state_transition t
  WHERE t.conversation_id = NEW.conversation_id
  ORDER BY t.next_revision DESC
  LIMIT 1
  FOR SHARE;

  IF NOT FOUND THEN
    expected_revision := 0;
    expected_digest := osaa.dialogue_genesis_digest(NEW.conversation_id);
  END IF;
  IF NEW.base_revision <> expected_revision
     OR NEW.next_revision <> expected_revision + 1 THEN
    RAISE EXCEPTION 'dialogue transition revision does not extend the database chain';
  END IF;
  -- The caller cannot choose the ledger link. Derive both stored copies from
  -- the committed database chain, even when the submitted values are forged.
  NEW.prev_state_digest := expected_digest;
  NEW.delta := jsonb_set(
    NEW.delta,
    '{prevStateDigest}',
    to_jsonb(expected_digest),
    true
  );
  IF (NEW.delta ->> 'baseRevision')::bigint <> NEW.base_revision
     OR (NEW.delta ->> 'nextRevision')::bigint <> NEW.next_revision
     OR NEW.delta ->> 'prevStateDigest' <> NEW.prev_state_digest
     OR NEW.delta ->> 'stateDigest' <> NEW.state_digest THEN
    RAISE EXCEPTION 'dialogue transition delta does not match its ledger columns';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER dialogue_state_transition_chain_guard
  BEFORE INSERT ON osaa.dialogue_state_transition
  FOR EACH ROW EXECUTE FUNCTION osaa.enforce_dialogue_transition_chain();
ALTER TABLE osaa.dialogue_state_transition
  ENABLE ALWAYS TRIGGER dialogue_state_transition_chain_guard;

CREATE FUNCTION osaa.enforce_dialogue_projection_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM osaa.conversation c
    JOIN osaa.dialogue_state_transition t
      ON t.conversation_id = c.id
     AND t.next_revision = NEW.revision
     AND t.state_digest = NEW.state_digest
     AND t.turn_request_id = NEW.last_turn_request_id
    WHERE c.id = NEW.conversation_id
      AND c.owner_id = NEW.owner_id
  ) THEN
    RAISE EXCEPTION 'dialogue projection is not linked to the committed transition';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER dialogue_state_projection_link_guard
  BEFORE INSERT OR UPDATE ON osaa.dialogue_state_projection
  FOR EACH ROW EXECUTE FUNCTION osaa.enforce_dialogue_projection_link();
ALTER TABLE osaa.dialogue_state_projection
  ENABLE ALWAYS TRIGGER dialogue_state_projection_link_guard;

CREATE FUNCTION osaa.verify_dialogue_state_chain(target_conversation_id uuid)
RETURNS TABLE(next_revision bigint, digest_valid boolean, projection_valid boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
  WITH chain AS (
    SELECT t.*,
      lag(t.state_digest) OVER (ORDER BY t.next_revision) AS linked_digest
    FROM osaa.dialogue_state_transition t
    WHERE t.conversation_id = target_conversation_id
  )
  SELECT chain.next_revision,
    chain.prev_state_digest = COALESCE(
      chain.linked_digest,
      osaa.dialogue_genesis_digest(target_conversation_id)
    ) AS digest_valid,
    EXISTS (
      SELECT 1 FROM osaa.dialogue_state_projection p
      WHERE p.conversation_id = target_conversation_id
        AND p.revision = chain.next_revision
        AND p.state_digest = chain.state_digest
    ) = (chain.next_revision = max(chain.next_revision) OVER ()) AS projection_valid
  FROM chain
  ORDER BY chain.next_revision
$$;



CREATE FUNCTION osaa.reject_dialogue_state_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('opensphere.dialogue_state_purge', true) = 'enabled'
     AND current_setting('role', true) = 'opensphere_osdst_maintenance'
     AND pg_has_role(session_user, 'opensphere_osdst_maintenance', 'MEMBER') THEN
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

CREATE FUNCTION osaa.reject_dialogue_purge_receipt_mutation()
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

CREATE FUNCTION osaa.reject_dialogue_state_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OSAA dialogue state tables are append-only and cannot be truncated';
END
$$;

CREATE TRIGGER dialogue_state_projection_reject_truncate
  BEFORE TRUNCATE ON osaa.dialogue_state_projection
  FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_dialogue_state_truncate();
ALTER TABLE osaa.dialogue_state_projection
  ENABLE ALWAYS TRIGGER dialogue_state_projection_reject_truncate;
CREATE TRIGGER dialogue_state_transition_reject_truncate
  BEFORE TRUNCATE ON osaa.dialogue_state_transition
  FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_dialogue_state_truncate();
ALTER TABLE osaa.dialogue_state_transition
  ENABLE ALWAYS TRIGGER dialogue_state_transition_reject_truncate;
CREATE TRIGGER dialogue_state_purge_receipt_reject_truncate
  BEFORE TRUNCATE ON osaa.dialogue_state_purge_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_dialogue_state_truncate();
ALTER TABLE osaa.dialogue_state_purge_receipt
  ENABLE ALWAYS TRIGGER dialogue_state_purge_receipt_reject_truncate;
CREATE TRIGGER dialogue_turn_recovery_receipt_reject_truncate
  BEFORE TRUNCATE ON osaa.dialogue_turn_recovery_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION osaa.reject_dialogue_state_truncate();
ALTER TABLE osaa.dialogue_turn_recovery_receipt
  ENABLE ALWAYS TRIGGER dialogue_turn_recovery_receipt_reject_truncate;

CREATE FUNCTION osaa.reap_expired_dialogue_turns(
  reap_limit integer
) RETURNS SETOF osaa.dialogue_turn_recovery_receipt
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, osaa
AS $$
BEGIN
  IF current_setting('role', true) <> 'opensphere_osdst_maintenance' THEN
    RAISE EXCEPTION 'dialogue lease reaping requires the CBSS dialogue maintenance role';
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
    lease_owner,lease_expires_at,attempt,current_setting('role', true)
  FROM recovered
  RETURNING *;
END
$$;
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
  IF current_setting('role', true) <> 'opensphere_osdst_maintenance' OR NOT pg_has_role(session_user, 'opensphere_osdst_maintenance', 'MEMBER') THEN
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
  IF current_setting('role', true) <> 'opensphere_osdst_maintenance' OR NOT pg_has_role(session_user, 'opensphere_osdst_maintenance', 'MEMBER') THEN
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

  PERFORM console_audit.append_event_internal(
    NULL, 'osdst-purge:' || receipt.id::text, 'service:' || session_user,
    'osaa.dialogue.retention.purge', 'osaa:conversation:' || target.id::text,
    'succeeded', trim(purge_reason), jsonb_build_object(
      'receiptId', receipt.id, 'transitionCount', transition_total, 'terminalStateDigest', terminal_digest));
  -- Complete retention: receipts survive, user messages and conversation metadata do not.
  DELETE FROM osaa.conversation WHERE id=target.id;
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
  IF current_setting('role', true) <> 'opensphere_osdst_maintenance' OR NOT pg_has_role(session_user, 'opensphere_osdst_maintenance', 'MEMBER') THEN
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

-- Owners are current Console subject UUIDs. Deleted identity content is retained only
-- according to the explicit conversation retention lifecycle, not an auth FK cascade.
ALTER TABLE osaa.conversation ADD CONSTRAINT native_conversation_owner_uuid
  CHECK (owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
ALTER TABLE osaa.conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.conversation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.conversation FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE osaa.conversation_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.conversation_message FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.conversation_message FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE osaa.dialogue_state_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_state_projection FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.dialogue_state_projection FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE osaa.dialogue_state_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_state_transition FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.dialogue_state_transition FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE osaa.dialogue_state_purge_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_state_purge_receipt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.dialogue_state_purge_receipt FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE osaa.dialogue_turn_recovery_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.dialogue_turn_recovery_receipt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON osaa.dialogue_turn_recovery_receipt FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY native_osdst_conversation ON osaa.conversation TO opensphere_osdst
  USING (owner_id=current_setting('opensphere.actor_id',true)) WITH CHECK (owner_id=current_setting('opensphere.actor_id',true));
CREATE POLICY native_osdst_message ON osaa.conversation_message TO opensphere_osdst
  USING (EXISTS(SELECT 1 FROM osaa.conversation c WHERE c.id=conversation_id AND c.owner_id=current_setting('opensphere.actor_id',true)))
  WITH CHECK (EXISTS(SELECT 1 FROM osaa.conversation c WHERE c.id=conversation_id AND c.owner_id=current_setting('opensphere.actor_id',true)));
CREATE POLICY native_osdst_dialogue_state_projection ON osaa.dialogue_state_projection TO opensphere_osdst
  USING (owner_id=current_setting('opensphere.actor_id',true) AND EXISTS(SELECT 1 FROM osaa.conversation c WHERE c.id=conversation_id AND c.owner_id=dialogue_state_projection.owner_id))
  WITH CHECK (owner_id=current_setting('opensphere.actor_id',true) AND EXISTS(SELECT 1 FROM osaa.conversation c WHERE c.id=conversation_id AND c.owner_id=dialogue_state_projection.owner_id));
CREATE POLICY native_osdst_dialogue_state_transition ON osaa.dialogue_state_transition TO opensphere_osdst
  USING (owner_id=current_setting('opensphere.actor_id',true) AND EXISTS(SELECT 1 FROM osaa.conversation c WHERE c.id=conversation_id AND c.owner_id=dialogue_state_transition.owner_id))
  WITH CHECK (owner_id=current_setting('opensphere.actor_id',true) AND EXISTS(SELECT 1 FROM osaa.conversation c WHERE c.id=conversation_id AND c.owner_id=dialogue_state_transition.owner_id));
GRANT SELECT,INSERT,UPDATE ON osaa.conversation,osaa.conversation_message,osaa.dialogue_state_projection TO opensphere_osdst;
GRANT SELECT,INSERT ON osaa.dialogue_state_transition TO opensphere_osdst;
CREATE POLICY native_osdst_dialogue_state_purge_receipt_read ON osaa.dialogue_state_purge_receipt FOR SELECT TO opensphere_osdst_maintenance USING(true);
GRANT SELECT ON osaa.dialogue_state_purge_receipt TO opensphere_osdst_maintenance;
CREATE POLICY native_osdst_dialogue_turn_recovery_receipt_read ON osaa.dialogue_turn_recovery_receipt FOR SELECT TO opensphere_osdst_maintenance USING(true);
GRANT SELECT ON osaa.dialogue_turn_recovery_receipt TO opensphere_osdst_maintenance;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA osaa FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION osaa.dialogue_genesis_digest(uuid) TO opensphere_osdst;
GRANT EXECUTE ON FUNCTION osaa.verify_dialogue_state_chain(uuid),osaa.reap_expired_dialogue_turns(integer),
 osaa.recover_dialogue_turn(uuid,uuid,text,text),osaa.purge_dialogue_state(uuid,text),osaa.purge_eligible_dialogue_state(integer)
 TO opensphere_osdst_maintenance;
COMMENT ON SCHEMA osaa IS 'Native Console AI domain; owner-specific tables, no parallel identity or legacy Console schema.';
COMMENT ON TABLE osaa.dialogue_state_transition IS 'OSDST-only conversation transition chain; not current authorization or operational state.';
