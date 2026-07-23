\set ON_ERROR_STOP on

-- AI Hub is a first-class Supabase consumer. Schema creation and grants belong
-- to the Console migration owner; the SubShell runtime never performs DDL,
-- creates database roles, or receives an owner/service-role credential.
-- The installer upgrades these bootstrap roles to scoped LOGIN roles with
-- generated passwords before consumers start. Keeping this migration
-- independently executable prevents ordering-only success during recovery.
DO $$ BEGIN
  CREATE ROLE opensphere_ai_runtime NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE ROLE opensphere_ai_pipeline NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT opensphere_ai_runtime, opensphere_ai_pipeline TO authenticator;

CREATE SCHEMA IF NOT EXISTS ai;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS ai.model_registry_versions (
  name text NOT NULL,
  version text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (name, version)
);

CREATE TABLE IF NOT EXISTS ai.model_registry_promotions (
  namespace text NOT NULL,
  name text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, name)
);

CREATE TABLE IF NOT EXISTS ai.model_registry_approval_audit (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ai.model_registry_evaluation_metrics (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ai.vector_collections (
  namespace text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner text NOT NULL DEFAULT 'opensphere-ai-hub',
  groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, name)
);

CREATE TABLE IF NOT EXISTS ai.vector_access_policies (
  namespace text NOT NULL,
  collection text NOT NULL,
  owner text NOT NULL DEFAULT 'opensphere-ai-hub',
  groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, collection)
);

CREATE TABLE IF NOT EXISTS ai.vector_chunks (
  id text PRIMARY KEY,
  namespace text NOT NULL,
  collection text NOT NULL,
  document_id text NOT NULL,
  content text NOT NULL,
  embedding extensions.vector(16) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (namespace, collection)
    REFERENCES ai.vector_collections(namespace, name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_vector_chunks_collection_idx
  ON ai.vector_chunks(namespace, collection);
CREATE INDEX IF NOT EXISTS ai_vector_chunks_embedding_hnsw
  ON ai.vector_chunks USING hnsw (embedding extensions.vector_cosine_ops);

INSERT INTO ai.vector_access_policies (namespace, collection, owner, groups, source, updated_at)
SELECT namespace, name, owner, groups,
       jsonb_build_object(
         'apiVersion', 'supabase.opensphere.io/v1',
         'kind', 'SupabaseVectorAccessPolicy',
         'namespace', namespace,
         'name', name,
         'backend', 'supabase-pgvector'
       ),
       clock_timestamp()
FROM ai.vector_collections
ON CONFLICT (namespace, collection) DO NOTHING;

CREATE OR REPLACE FUNCTION ai.prevent_approval_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, ai
AS $$
BEGIN
  RAISE EXCEPTION 'ai.model_registry_approval_audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS model_registry_approval_audit_no_update ON ai.model_registry_approval_audit;
DROP TRIGGER IF EXISTS model_registry_approval_audit_no_delete ON ai.model_registry_approval_audit;
DROP TRIGGER IF EXISTS model_registry_approval_audit_no_truncate ON ai.model_registry_approval_audit;
CREATE TRIGGER model_registry_approval_audit_no_update
  BEFORE UPDATE ON ai.model_registry_approval_audit
  FOR EACH ROW EXECUTE FUNCTION ai.prevent_approval_audit_mutation();
CREATE TRIGGER model_registry_approval_audit_no_delete
  BEFORE DELETE ON ai.model_registry_approval_audit
  FOR EACH ROW EXECUTE FUNCTION ai.prevent_approval_audit_mutation();
CREATE TRIGGER model_registry_approval_audit_no_truncate
  BEFORE TRUNCATE ON ai.model_registry_approval_audit
  FOR EACH STATEMENT EXECUTE FUNCTION ai.prevent_approval_audit_mutation();
ALTER TABLE ai.model_registry_approval_audit ENABLE ALWAYS TRIGGER model_registry_approval_audit_no_update;
ALTER TABLE ai.model_registry_approval_audit ENABLE ALWAYS TRIGGER model_registry_approval_audit_no_delete;
ALTER TABLE ai.model_registry_approval_audit ENABLE ALWAYS TRIGGER model_registry_approval_audit_no_truncate;

ALTER TABLE ai.model_registry_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.model_registry_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.model_registry_approval_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.model_registry_evaluation_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.vector_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.vector_access_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.vector_chunks ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'model_registry_versions',
    'model_registry_promotions',
    'model_registry_approval_audit',
    'model_registry_evaluation_metrics',
    'vector_collections',
    'vector_access_policies',
    'vector_chunks'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS ai_runtime_scope ON ai.%I', table_name);
    EXECUTE format(
      'CREATE POLICY ai_runtime_scope ON ai.%I FOR ALL TO opensphere_ai_runtime USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON SCHEMA ai FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA ai FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA ai, extensions TO opensphere_ai_runtime;
GRANT SELECT, INSERT, UPDATE ON
  ai.model_registry_versions,
  ai.model_registry_promotions,
  ai.model_registry_evaluation_metrics,
  ai.vector_collections,
  ai.vector_access_policies,
  ai.vector_chunks
TO opensphere_ai_runtime;
GRANT SELECT, INSERT ON ai.model_registry_approval_audit TO opensphere_ai_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON ai.model_registry_approval_audit FROM opensphere_ai_runtime;
ALTER ROLE opensphere_ai_runtime SET search_path = ai, public, extensions;
GRANT opensphere_ai_runtime TO authenticator;

INSERT INTO storage.buckets (id, name, public)
VALUES ('ai-artifacts', 'ai-artifacts', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS ai_runtime_objects_select ON storage.objects;
DROP POLICY IF EXISTS ai_runtime_objects_insert ON storage.objects;
DROP POLICY IF EXISTS ai_runtime_objects_update ON storage.objects;
DROP POLICY IF EXISTS ai_runtime_objects_delete ON storage.objects;
CREATE POLICY ai_runtime_objects_select ON storage.objects FOR SELECT TO opensphere_ai_runtime
  USING (bucket_id = 'ai-artifacts');
CREATE POLICY ai_runtime_objects_insert ON storage.objects FOR INSERT TO opensphere_ai_runtime
  WITH CHECK (bucket_id = 'ai-artifacts');
CREATE POLICY ai_runtime_objects_update ON storage.objects FOR UPDATE TO opensphere_ai_runtime
  USING (bucket_id = 'ai-artifacts') WITH CHECK (bucket_id = 'ai-artifacts');
CREATE POLICY ai_runtime_objects_delete ON storage.objects FOR DELETE TO opensphere_ai_runtime
  USING (bucket_id = 'ai-artifacts');

ALTER TABLE console.change_execution
  ADD COLUMN IF NOT EXISTS consumer_id text REFERENCES console.consumer_contract(consumer_id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS change_execution_consumer_idx
  ON console.change_execution(consumer_id, updated_at DESC);

INSERT INTO console.consumer_contract (
  consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets,
  gitea_repository, gitea_path, reconciler, observability_claim, status, metadata
) VALUES (
  'ai-hub',
  'OpenSphere AI Hub',
  'subshell',
  ARRAY['ai'],
  ARRAY['ai-artifacts'],
  'opensphere/platform-declarations',
  'subshell/ai-hub/',
  'subshell-reconciler',
  'subshell-ai-hub',
  'NotReady',
  '{
    "authority":"Supabase ai schema + RLS-scoped Storage + Gitea declaration",
    "identity":"Console Supabase session authority",
    "bindingSecret":"opensphere-system/opensphere-supabase-ai-runtime",
    "evidence":"awaiting first signed reconcile receipt"
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
VALUES ('ai-hub', ARRAY['metrics','logs','traces'])
ON CONFLICT (consumer_id) DO NOTHING;

COMMENT ON SCHEMA ai IS 'OpenSphere AI Hub durable data; Supabase migration-owned, runtime DDL forbidden';
COMMENT ON COLUMN console.change_execution.consumer_id IS 'Consumer contract bound to this governed Gitea change';
