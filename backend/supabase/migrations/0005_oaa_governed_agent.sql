\set ON_ERROR_STOP on

-- OAA is a Console control-plane consumer, not a browser chat transcript.
-- This migration makes Supabase the authority for OAA knowledge, capability
-- declarations, retrieval evidence and execution traces.  PostgREST does not
-- expose this schema: all access is through the OAA Gateway/Console Backend.

CREATE SCHEMA IF NOT EXISTS oaa;
REVOKE ALL ON SCHEMA oaa FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_oaa_gateway') THEN
    CREATE ROLE opensphere_oaa_gateway NOLOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;
CREATE TABLE IF NOT EXISTS oaa.embedding_model (
  id text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 16 AND 4096),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, dimensions)
);

-- A stable document identity and immutable versions make re-ingestion and
-- model cutovers atomic.  The legacy-compatible tables below are the active
-- serving projection during the first cutover phase.
CREATE TABLE IF NOT EXISTS oaa.document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL DEFAULT 'opensphere',
  source_type text NOT NULL,
  source_id text NOT NULL,
  title text NOT NULL,
  active_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS oaa.document_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES oaa.document(id) ON DELETE CASCADE,
  version text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'active', 'superseded', 'retired', 'failed')),
  authority_tier integer NOT NULL DEFAULT 3 CHECK (authority_tier BETWEEN 0 AND 4),
  acl jsonb NOT NULL DEFAULT '{"visibility":"authenticated"}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (document_id, content_hash)
);

ALTER TABLE oaa.document
  DROP CONSTRAINT IF EXISTS document_active_version_id_fkey;
ALTER TABLE oaa.document
  ADD CONSTRAINT document_active_version_id_fkey
  FOREIGN KEY (active_version_id) REFERENCES oaa.document_version(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS oaa.section (
  id text PRIMARY KEY,
  document_version_id uuid NOT NULL REFERENCES oaa.document_version(id) ON DELETE CASCADE,
  heading text NOT NULL,
  level integer NOT NULL CHECK (level BETWEEN 1 AND 6),
  section_order integer NOT NULL,
  anchor text NOT NULL,
  parent_section_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (document_version_id, section_order)
);

CREATE TABLE IF NOT EXISTS oaa.embedding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  embedding_model_id text NOT NULL REFERENCES oaa.embedding_model(id) ON DELETE RESTRICT,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding extensions.vector(1536) NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('staged', 'ready', 'failed', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (embedding_model_id, content_hash)
);
CREATE INDEX IF NOT EXISTS oaa_embedding_hnsw_idx ON oaa.embedding USING hnsw (embedding extensions.vector_cosine_ops);

-- Serving projection.  It retains the current gateway table names so migration
-- can be deployed before the document-version writer is cut over, but adds
-- status/ACL/authority fields and FTS indexes required by governed retrieval.
CREATE TABLE IF NOT EXISTS oaa.oaa_knowledge_documents (
  id uuid PRIMARY KEY,
  namespace text NOT NULL DEFAULT 'opensphere',
  source_type text NOT NULL,
  source_id text NOT NULL,
  title text NOT NULL,
  version text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('staged', 'active', 'superseded', 'retired', 'failed')),
  authority_tier integer NOT NULL DEFAULT 3 CHECK (authority_tier BETWEEN 0 AND 4),
  acl jsonb NOT NULL DEFAULT '{"visibility":"authenticated"}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(namespace, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS oaa.oaa_knowledge_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES oaa.oaa_knowledge_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding extensions.vector(1536) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS oaa_knowledge_chunks_embedding_hnsw_idx ON oaa.oaa_knowledge_chunks USING hnsw (embedding extensions.vector_cosine_ops);
CREATE INDEX IF NOT EXISTS oaa_knowledge_chunks_fts_idx ON oaa.oaa_knowledge_chunks USING gin (search_vector);
CREATE INDEX IF NOT EXISTS oaa_knowledge_documents_active_idx ON oaa.oaa_knowledge_documents (namespace, status, authority_tier, updated_at DESC);

CREATE TABLE IF NOT EXISTS oaa.oaa_manual_concepts (
  id text PRIMARY KEY, namespace text NOT NULL, type text NOT NULL, name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}', summary text NOT NULL, definition text NOT NULL,
  authority_tier integer NOT NULL CHECK (authority_tier BETWEEN 0 AND 4), status text NOT NULL,
  source_ids text[] NOT NULL DEFAULT '{}', section_ids text[] NOT NULL DEFAULT '{}', tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oaa.oaa_manual_relations (
  id text PRIMARY KEY, namespace text NOT NULL, from_id text NOT NULL, to_id text NOT NULL,
  relation text NOT NULL, confidence text NOT NULL, authority_tier integer NOT NULL CHECK (authority_tier BETWEEN 0 AND 4),
  source_id text NOT NULL, section_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oaa.oaa_tool_capabilities (
  id text PRIMARY KEY, name text NOT NULL, version text NOT NULL, channel text NOT NULL,
  read_only boolean NOT NULL, spec jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oaa.oaa_manual_action_bindings (
  id text PRIMARY KEY, source_id text NOT NULL, section_id text,
  tool_id text NOT NULL REFERENCES oaa.oaa_tool_capabilities(id) ON DELETE RESTRICT,
  intent text NOT NULL, risk_level text NOT NULL, confirmation text NOT NULL,
  spec jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oaa.retrieval_trace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL, actor_id uuid NOT NULL,
  query_digest text NOT NULL CHECK (query_digest ~ '^sha256:[0-9a-f]{64}$'),
  document_id uuid REFERENCES oaa.oaa_knowledge_documents(id) ON DELETE SET NULL,
  chunk_id uuid REFERENCES oaa.oaa_knowledge_chunks(id) ON DELETE SET NULL,
  rank integer NOT NULL, score double precision NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oaa.tool_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL, actor_id uuid NOT NULL,
  tool_id text NOT NULL, target text NOT NULL, permission_code text NOT NULL, reason text,
  input_digest text CHECK (input_digest IS NULL OR input_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('intent', 'authorized', 'applied', 'failed', 'blocked')),
  result_digest text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);

-- Canonical permission vocabulary.  Roles remain Console-owned; OAA only
-- declares which of those permissions a retrieval or capability requires.
INSERT INTO console.permission (code, risk_level) VALUES
  ('oaa.chat.use', 'low'), ('oaa.knowledge.read', 'low'), ('oaa.knowledge.manage', 'high'),
  ('oaa.system.read', 'low'), ('oaa.logs.read', 'medium'), ('oaa.action.propose', 'medium'),
  ('oaa.action.execute.low', 'high'), ('oaa.action.execute.high', 'critical')
ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;

INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p ON p.code IN
  ('oaa.chat.use', 'oaa.knowledge.read', 'oaa.system.read', 'oaa.action.propose')
WHERE r.code IN ('console-admins', 'console-operators', 'console-viewers')
ON CONFLICT DO NOTHING;
INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r JOIN console.permission p ON p.code IN
  ('oaa.logs.read', 'oaa.knowledge.manage', 'oaa.action.execute.low', 'oaa.action.execute.high')
WHERE r.code = 'console-admins'
ON CONFLICT DO NOTHING;

-- Existing release-bound manuals were previously ACL-less.  Classify them as
-- authenticated Console knowledge during the dual-read migration; sensitive
-- sources must explicitly replace this with restricted users/groups/permissions.
UPDATE oaa.oaa_knowledge_documents
SET acl = '{"visibility":"authenticated"}'::jsonb,
    status = COALESCE(NULLIF(status, ''), 'active'),
    authority_tier = COALESCE(authority_tier, 3)
WHERE acl = '{}'::jsonb OR acl IS NULL;

-- Gateway-only role: no browser grant, no schema CREATE, no audit mutation.
GRANT USAGE ON SCHEMA oaa, extensions TO opensphere_oaa_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA oaa TO opensphere_oaa_gateway;
ALTER DEFAULT PRIVILEGES IN SCHEMA oaa GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opensphere_oaa_gateway;

ALTER TABLE oaa.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.section ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.embedding ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.oaa_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.oaa_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.oaa_manual_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.oaa_manual_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.oaa_tool_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.oaa_manual_action_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.retrieval_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.tool_run ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document','document_version','section','embedding','oaa_knowledge_documents','oaa_knowledge_chunks','oaa_manual_concepts','oaa_manual_relations','oaa_tool_capabilities','oaa_manual_action_bindings','retrieval_trace','tool_run']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS oaa_gateway_%I ON oaa.%I', t, t);
    EXECUTE format('CREATE POLICY oaa_gateway_%I ON oaa.%I FOR ALL TO opensphere_oaa_gateway USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END;
$$;
