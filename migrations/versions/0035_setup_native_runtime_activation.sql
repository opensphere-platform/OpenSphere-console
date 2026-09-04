-- Setup-owned activation boundary for the native Console runtime set.
-- The installer may enable OS Shell only after all exact-digest workloads are
-- Ready. It supplies the verified release and current migration evidence;
-- browser and workload roles receive no EXECUTE grant on this function.
CREATE OR REPLACE FUNCTION console_shell.activate_native_runtime_from_setup(
  p_expected_revision bigint,
  p_operation_evidence jsonb
) RETURNS SETOF console_shell.shell_control_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_shell
AS $$
DECLARE
  v_state console_shell.shell_control_state%ROWTYPE;
  v_latest console_migration.applied_migration%ROWTYPE;
  v_channel text;
BEGIN
  SELECT * INTO v_latest
    FROM console_migration.applied_migration
    ORDER BY applied_sequence DESC
    LIMIT 1;

  v_channel := p_operation_evidence->>'channel';
  IF p_expected_revision IS NULL OR p_expected_revision < 1
    OR jsonb_typeof(p_operation_evidence) <> 'object'
    OR (SELECT array_agg(key ORDER BY key)
          FROM jsonb_object_keys(p_operation_evidence) AS e(key))
       <> ARRAY['authority','channel','componentSetDigest','latestGlobalId',
         'migrationSetDigest','releaseDigest','sourceRevision','workloadSet']
    OR p_operation_evidence->>'authority' <> 'opensphere-setup-cli'
    OR v_channel NOT IN ('edge','candidate','stable','lts')
    OR p_operation_evidence->>'componentSetDigest' !~ '^sha256:[a-f0-9]{64}$'
    OR p_operation_evidence->>'releaseDigest' !~ '^sha256:[a-f0-9]{64}$'
    OR p_operation_evidence->>'sourceRevision' !~ '^[a-f0-9]{40}$'
    OR p_operation_evidence->>'latestGlobalId' IS DISTINCT FROM v_latest.global_id
    OR p_operation_evidence->>'migrationSetDigest' IS DISTINCT FROM v_latest.migration_set_digest
    OR p_operation_evidence->>'sourceRevision' IS DISTINCT FROM v_latest.source_revision
    OR p_operation_evidence->'workloadSet' <> '["opensphere-console-api","opensphere-console-osaa-gateway","opensphere-osdst","opensphere-shell-api","opensphere-shell-gateway","opensphere-shell-reconciler"]'::jsonb THEN
    RAISE EXCEPTION 'ShellFeatureSetupEvidenceInvalid' USING ERRCODE='28000';
  END IF;

  SELECT * INTO v_state
    FROM console_shell.shell_control_state
    WHERE singleton = true
    FOR UPDATE;

  IF v_state.enabled THEN
    RETURN NEXT v_state;
    RETURN;
  END IF;
  IF v_state.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'ShellFeatureRevisionConflict' USING ERRCODE='40001';
  END IF;

  PERFORM * FROM console_shell.apply_shell_feature_state(
    true,
    p_expected_revision,
    'Verified OpenSphere Setup native runtime installation completed',
    NULL,
    'installer:opensphere-setup-cli/' || v_channel,
    p_operation_evidence
  );
  UPDATE console_shell.shell_control_state
     SET operation_id = gen_random_uuid(),
         operation_kind = 'Enable',
         operation_phase = 'Completed',
         operation_identity = 'installer:opensphere-setup-cli/' || v_channel,
         operation_started_at = clock_timestamp(),
         operation_completed_at = clock_timestamp(),
         scale_claim_token = NULL,
         scale_claim_expires_at = NULL
   WHERE singleton = true
   RETURNING * INTO v_state;
  RETURN NEXT v_state;
END
$$;

REVOKE ALL ON FUNCTION console_shell.activate_native_runtime_from_setup(bigint,jsonb) FROM PUBLIC;

COMMENT ON FUNCTION console_shell.activate_native_runtime_from_setup(bigint,jsonb) IS
  'Setup-only OS Shell activation after exact-digest native runtime readiness and current migration evidence verification.';
