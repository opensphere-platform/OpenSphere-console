-- OpenSphere AI Agent (OSAA) canonical cutover and durable conversation store.
--
-- Historical migration files retain their released OAA names and hashes. This
-- migration removes the live OAA identity in one direction only: schema, roles,
-- permissions, serving tables and callable function bodies become OSAA. No OAA
-- compatibility schema, role, API alias or permission alias is created.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'oaa') THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'osaa') THEN
      RAISE EXCEPTION 'OSAA cutover refused: both oaa and osaa schemas exist';
    END IF;
    ALTER SCHEMA oaa RENAME TO osaa;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'osaa') THEN
    RAISE EXCEPTION 'OSAA cutover refused: source oaa schema is absent';
  END IF;
END
$$;

DO $$
DECLARE
  item record;
  next_name text;
BEGIN
  FOR item IN
    SELECT rolname
    FROM pg_roles
    WHERE rolname LIKE 'opensphere_oaa%'
    ORDER BY rolname
  LOOP
    next_name := replace(item.rolname, 'opensphere_oaa', 'opensphere_osaa');
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = next_name) THEN
      RAISE EXCEPTION 'OSAA role cutover refused: target role % already exists', next_name;
    END IF;
    EXECUTE format('ALTER ROLE %I RENAME TO %I', item.rolname, next_name);
  END LOOP;
END
$$;

-- Rename the six legacy serving projections. Foreign keys and dependent views
-- follow relation OIDs, so this is a data-preserving rename rather than a copy.
DO $$
DECLARE
  item record;
  next_name text;
BEGIN
  FOR item IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'osaa' AND tablename LIKE 'oaa\_%' ESCAPE '\'
    ORDER BY tablename
  LOOP
    next_name := regexp_replace(item.tablename, '^oaa_', 'osaa_');
    IF to_regclass(format('osaa.%I', next_name)) IS NOT NULL THEN
      RAISE EXCEPTION 'OSAA table cutover refused: target table % already exists', next_name;
    END IF;
    EXECUTE format('ALTER TABLE osaa.%I RENAME TO %I', item.tablename, next_name);
  END LOOP;
END
$$;

-- Replace schema/table/permission references embedded in stored function bodies.
-- pg_get_functiondef emits the post-rename OSAA-qualified function header; the
-- replacement updates PL/pgSQL/SQL bodies and per-function search_path clauses.
DO $$
DECLARE
  item record;
  definition text;
BEGIN
  FOR item IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'osaa'
    ORDER BY p.oid
  LOOP
    definition := pg_get_functiondef(item.oid);
    IF definition ~ 'oaa' THEN
      EXECUTE replace(definition, 'oaa', 'osaa');
    END IF;
  END LOOP;
END
$$;

-- Internal relation metadata is renamed as well so current diagnostics and
-- schema introspection expose OSAA terminology only.
DO $$
DECLARE
  item record;
  next_name text;
BEGIN
  FOR item IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'osaa' AND indexname LIKE 'oaa\_%' ESCAPE '\'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conindid = to_regclass(format('osaa.%I', indexname))
      )
    ORDER BY indexname
  LOOP
    next_name := regexp_replace(item.indexname, '^oaa_', 'osaa_');
    IF to_regclass(format('osaa.%I', next_name)) IS NULL THEN
      EXECUTE format('ALTER INDEX osaa.%I RENAME TO %I', item.indexname, next_name);
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  item record;
  next_name text;
BEGIN
  FOR item IN
    SELECT c.relname AS table_name, con.conname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'osaa' AND con.conname LIKE 'oaa\_%' ESCAPE '\'
    ORDER BY c.relname, con.conname
  LOOP
    next_name := regexp_replace(item.conname, '^oaa_', 'osaa_');
    EXECUTE format('ALTER TABLE osaa.%I RENAME CONSTRAINT %I TO %I', item.table_name, item.conname, next_name);
  END LOOP;
END
$$;

DO $$
DECLARE
  item record;
  next_name text;
BEGIN
  FOR item IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'osaa' AND policyname LIKE 'oaa\_%' ESCAPE '\'
    ORDER BY tablename, policyname
  LOOP
    next_name := replace(item.policyname, 'oaa', 'osaa');
    EXECUTE format('ALTER POLICY %I ON osaa.%I RENAME TO %I', item.policyname, item.tablename, next_name);
  END LOOP;
END
$$;

UPDATE console.permission
SET code = regexp_replace(code, '^oaa\.', 'osaa.')
WHERE code LIKE 'oaa.%';

-- Current control-plane declarations move to OSAA as data, not as an alias.
-- The old consumer row is replaced because its dependent foreign keys do not
-- use ON UPDATE CASCADE.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = 'console' AND rel.relname = 'consumer_contract'
    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%owner_kind%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'OSAA cutover refused: consumer owner_kind constraint is absent';
  END IF;
  EXECUTE format('ALTER TABLE console.consumer_contract DROP CONSTRAINT %I', constraint_name);
  UPDATE console.consumer_contract SET owner_kind = 'osaa' WHERE owner_kind = 'oaa';
  ALTER TABLE console.consumer_contract
    ADD CONSTRAINT consumer_contract_owner_kind_check
    CHECK (owner_kind IN ('console-native', 'osaa', 'subshell', 'extension'));
END
$$;

INSERT INTO console.consumer_contract (
  consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets,
  gitea_repository, gitea_path, reconciler, observability_claim,
  desired_revision, applied_revision, status, last_observed_at, metadata, updated_at
)
SELECT
  'osaa-gateway', replace(display_name, 'OAA', 'OSAA'), 'osaa',
  array_replace(supabase_schemas, 'oaa', 'osaa'), storage_buckets,
  gitea_repository, replace(gitea_path, 'oaa', 'osaa'),
  replace(reconciler, 'oaa', 'osaa'), replace(observability_claim, 'oaa', 'osaa'),
  desired_revision, applied_revision, status, last_observed_at,
  replace(replace(metadata::text, 'OAA', 'OSAA'), 'oaa', 'osaa')::jsonb, updated_at
FROM console.consumer_contract
WHERE consumer_id = 'oaa-gateway';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM console.consumer_contract WHERE consumer_id = 'osaa-gateway') THEN
    RAISE EXCEPTION 'OSAA cutover refused: source consumer declaration is absent';
  END IF;
END
$$;

UPDATE console.observability_claim SET consumer_id = 'osaa-gateway'
WHERE consumer_id = 'oaa-gateway';
UPDATE console.change_execution SET consumer_id = 'osaa-gateway'
WHERE consumer_id = 'oaa-gateway';
DELETE FROM console.consumer_contract WHERE consumer_id = 'oaa-gateway';

UPDATE console.consumer_contract
SET supabase_schemas = array_replace(supabase_schemas, 'oaa', 'osaa'),
    metadata = replace(replace(metadata::text, 'OAA', 'OSAA'), 'oaa', 'osaa')::jsonb,
    updated_at = clock_timestamp()
WHERE 'oaa' = ANY(supabase_schemas) OR metadata::text LIKE '%OAA%';

COMMENT ON TABLE osaa.watch_cursor IS
  'Replica-aware mutable liveness/cursor projection for OSAA Kubernetes watches; never an execution authority.';
COMMENT ON TABLE console.permission IS
  'Canonical Console permissions, including independently reviewed OSAA owner-facade read and mutation capabilities.';
COMMENT ON TABLE osaa.incident_outbox IS
  'Atomic OSAA incident transition outbox; Console notification is an idempotent downstream relay.';

ALTER ROLE opensphere_osaa_gateway SET search_path = osaa, extensions, public;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_osaa_observer') THEN
    ALTER ROLE opensphere_osaa_observer SET search_path = osaa, pg_catalog, extensions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_osaa_api') THEN
    ALTER ROLE opensphere_osaa_api SET search_path = osaa, pg_catalog, extensions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_osaa_incident_relay') THEN
    ALTER ROLE opensphere_osaa_incident_relay SET search_path = osaa, pg_catalog, extensions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_osaa_maintenance') THEN
    ALTER ROLE opensphere_osaa_maintenance SET search_path = osaa, pg_catalog, extensions;
  END IF;
END
$$;

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

ALTER TABLE osaa.conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.conversation_message ENABLE ROW LEVEL SECURITY;

CREATE POLICY osaa_gateway_conversation
  ON osaa.conversation FOR ALL TO opensphere_osaa_gateway
  USING (true) WITH CHECK (true);
CREATE POLICY osaa_gateway_conversation_message
  ON osaa.conversation_message FOR ALL TO opensphere_osaa_gateway
  USING (true) WITH CHECK (true);

REVOKE ALL ON osaa.conversation, osaa.conversation_message
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON osaa.conversation, osaa.conversation_message
  TO opensphere_osaa_gateway;

COMMENT ON TABLE osaa.conversation IS
  'User-owned durable OSAA conversation metadata. The Gateway enforces owner_id on every query.';
COMMENT ON TABLE osaa.conversation_message IS
  'Durable OSAA user and assistant messages. Operational audit/evidence remains in separate digest-only ledgers.';
