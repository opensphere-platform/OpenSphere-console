-- Include the RLS-protected presentation_preference table introduced by 0026.
-- Preserve exact inventory and FORCE RLS requirements; never treat partial coverage as Ready.
CREATE OR REPLACE FUNCTION console_identity.get_supabase_status(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_observed_at timestamptz := statement_timestamp();
  v_authority_table_count integer;
  v_rls_table_count integer;
  v_baseline_objects_present boolean;
  v_migration_count integer := 0;
  v_migration_chain_count integer := 0;
  v_migration_latest_global_id text;
  v_migration_latest_set_digest text;
  v_migration_latest_set_size integer;
  v_migration_state text;
  v_migration_reason text;
BEGIN
  IF length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid correlation id' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_observed_at THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.data_identity.read'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::integer
    INTO v_authority_table_count, v_rls_table_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('console_identity', 'console_operation', 'console_audit', 'console_extension')
      AND c.relkind IN ('r', 'p');

  v_baseline_objects_present :=
    to_regclass('console_identity.browser_session') IS NOT NULL
    AND to_regclass('console_operation.operation') IS NOT NULL
    AND to_regclass('console_audit.event') IS NOT NULL
    AND to_regclass('console_extension.registry_connection') IS NOT NULL
    AND to_regprocedure('console_identity.resolve_browser_session(bytea,bytea,boolean)') IS NOT NULL
    AND to_regprocedure('console_operation.accept_operation(uuid,uuid,bigint,bigint,text,text,text,text,text,text,text,text,boolean,text,text,text,text,jsonb,jsonb)') IS NOT NULL
    AND to_regprocedure('console_extension.apply_install_registration(uuid,bigint,bigint,uuid,text,text,jsonb,text,text,text,text,bigint,boolean,text,text,text,text)') IS NOT NULL
    AND to_regprocedure('console_extension.record_install_observation(uuid,bigint,bigint,uuid,text,text,text,jsonb)') IS NOT NULL
    AND to_regprocedure('console_operation.verify_extension_operation(uuid,uuid,bigint,bigint,uuid,bigint,text,text)') IS NOT NULL;

  IF to_regclass('console_migration.applied_migration') IS NOT NULL THEN
    WITH ordered AS (
      SELECT global_id, predecessor_global_id,
             row_number() OVER (ORDER BY applied_sequence) AS ordinal,
             lag(global_id) OVER (ORDER BY applied_sequence) AS prior_global_id
      FROM console_migration.applied_migration
    )
    SELECT count(*)::integer,
           count(*) FILTER (
             WHERE (ordinal = 1 AND predecessor_global_id IS NULL)
                OR (ordinal > 1 AND predecessor_global_id = prior_global_id)
           )::integer
      INTO v_migration_count, v_migration_chain_count
      FROM ordered;

    SELECT global_id, migration_set_digest, migration_set_size
      INTO v_migration_latest_global_id, v_migration_latest_set_digest, v_migration_latest_set_size
      FROM console_migration.applied_migration
      ORDER BY applied_sequence DESC
      LIMIT 1;
  END IF;

  IF NOT v_baseline_objects_present THEN
    v_migration_state := 'Unknown';
    v_migration_reason := 'BaselineObjectsMissing';
  ELSIF v_migration_count = 0 THEN
    v_migration_state := 'Partial';
    v_migration_reason := 'MigrationLedgerMissing';
  ELSIF v_migration_chain_count <> v_migration_count OR v_migration_latest_set_size <> v_migration_count THEN
    v_migration_state := 'Blocked';
    v_migration_reason := 'MigrationLedgerInvalid';
  ELSE
    v_migration_state := 'Ready';
    v_migration_reason := NULL;
  END IF;

  RETURN jsonb_build_object(
    'schemaVersion', '1.0',
    'data', jsonb_build_object(
      'state', 'Degraded',
      'required', true,
      'components', jsonb_build_array(
        jsonb_build_object('component', 'database', 'state', 'Ready', 'authority', 'SupabasePostgreSQL', 'reasonCode', NULL),
        jsonb_build_object('component', 'auth', 'state', 'Unknown', 'authority', 'SupabaseAuth', 'reasonCode', 'LiveProbeUnavailable'),
        jsonb_build_object('component', 'dataApi', 'state', 'Unknown', 'authority', 'SupabasePostgREST', 'reasonCode', 'LiveProbeUnavailable'),
        jsonb_build_object('component', 'storage', 'state', 'Unknown', 'authority', 'SupabaseStorage', 'reasonCode', 'LiveProbeUnavailable'),
        jsonb_build_object(
          'component', 'migration',
          'state', v_migration_state,
          'authority', 'ConsoleMigrationLedger',
          'reasonCode', v_migration_reason,
          'baselineRevision', v_migration_latest_global_id,
          'setDigest', v_migration_latest_set_digest,
          'migrationCount', v_migration_count
        ),
        jsonb_build_object(
          'component', 'rls',
          'state', CASE WHEN v_authority_table_count = 16 AND v_rls_table_count = v_authority_table_count THEN 'Ready' ELSE 'Blocked' END,
          'authority', 'PostgreSQLCatalog',
          'reasonCode', CASE WHEN v_authority_table_count = 16 AND v_rls_table_count = v_authority_table_count THEN NULL ELSE 'RlsCoverageIncomplete' END,
          'authorityTables', v_authority_table_count,
          'protectedTables', v_rls_table_count
        ),
        jsonb_build_object('component', 'backup', 'state', 'Unknown', 'authority', 'RecoveryOwner', 'reasonCode', 'EvidenceUnavailable'),
        jsonb_build_object('component', 'restore', 'state', 'Unknown', 'authority', 'RecoveryOwner', 'reasonCode', 'EvidenceUnavailable')
      )
    ),
    'authority', 'Supabase',
    'observedAt', v_observed_at,
    'freshness', 'fresh',
    'correlationId', p_correlation_id,
    'evidenceRefs', jsonb_build_array(
      'supabase-postgresql:connected',
      CASE
        WHEN v_migration_state = 'Ready' THEN 'migration-ledger:' || v_migration_latest_global_id || '@' || v_migration_latest_set_digest
        WHEN v_baseline_objects_present THEN 'baseline-schema:objects-present-ledger-missing'
        ELSE 'baseline-schema:objects-missing'
      END,
      'rls:' || v_rls_table_count::text || '/' || v_authority_table_count::text
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.get_supabase_status(uuid, uuid, bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.get_supabase_status(uuid, uuid, bigint, bigint, text) TO console_api;

