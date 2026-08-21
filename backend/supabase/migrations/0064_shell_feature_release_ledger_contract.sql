-- Keep the OS Shell feature gate bound to the actual append-only migration
-- ledger instead of copying a global "latest migration" literal into both the
-- Backend and this function.  A later, unrelated migration can therefore be
-- deployed without silently making the release owner and database disagree.
CREATE OR REPLACE FUNCTION console.set_shell_feature_state_local_edge(
  p_enabled boolean,p_expected_revision bigint,p_reason text,p_actor_identity text,p_operation_evidence jsonb,
  p_operation_id uuid
) RETURNS SETOF console.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE
  v_state console.shell_control_state%ROWTYPE;
  v_now timestamptz:=clock_timestamp();
  v_latest_migration_id text;
  v_latest_source_revision text;
BEGIN
  SELECT split_part(migration_id,'_',1),source_revision
    INTO v_latest_migration_id,v_latest_source_revision
    FROM console.schema_migration
    ORDER BY migration_id DESC
    LIMIT 1;

  IF p_operation_id IS NULL
    OR p_actor_identity<>'system:serviceaccount:opensphere-console:opensphere-local-edge-release'
    OR jsonb_typeof(p_operation_evidence)<>'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_operation_evidence) AS e(key))
      <>ARRAY['authority','channel','componentSetDigest','gaEligible','latestMigrationId','migrationSetDigest','publicationSha256',
        'releaseIntentKeyId','releaseIntentSha256','releaseIntentSignatureSha256','sourceRevision']
    OR p_operation_evidence->>'authority'<>'kubernetes-workload'
    OR p_operation_evidence->>'channel'<>'edge'
    OR (p_operation_evidence->>'gaEligible')::boolean<>false
    OR p_operation_evidence->>'componentSetDigest'!~'^sha256:[a-f0-9]{64}$'
    OR p_operation_evidence->>'publicationSha256'!~'^sha256:[a-f0-9]{64}$'
    OR p_operation_evidence->>'migrationSetDigest'!~'^sha256:[a-f0-9]{64}$'
    OR p_operation_evidence->>'releaseIntentKeyId'<>'opensphere-edge-local-v1'
    OR p_operation_evidence->>'releaseIntentSha256'!~'^sha256:[a-f0-9]{64}$'
    OR p_operation_evidence->>'releaseIntentSignatureSha256'!~'^sha256:[a-f0-9]{64}$'
    OR p_operation_evidence->>'sourceRevision'!~'^[a-f0-9]{40}$'
    OR p_operation_evidence->>'latestMigrationId'!~'^[0-9]{4}$'
    OR p_operation_evidence->>'latestMigrationId' IS DISTINCT FROM v_latest_migration_id
    OR p_operation_evidence->>'sourceRevision' IS DISTINCT FROM v_latest_source_revision THEN
    RAISE EXCEPTION 'ShellFeatureLocalEdgeEvidenceInvalid' USING ERRCODE='28000';
  END IF;

  SELECT * INTO v_state FROM console.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.operation_phase IN ('Draining','ScaleDownClaimed') THEN
    IF v_state.operation_id<>p_operation_id OR v_state.operation_kind<>(CASE WHEN p_enabled THEN 'Enable' ELSE 'Disable' END)
      OR v_state.operation_identity<>p_actor_identity OR v_state.operation_evidence<>p_operation_evidence THEN
      RAISE EXCEPTION 'ShellFeatureOperationConflict' USING ERRCODE='40001';
    END IF;
    RETURN NEXT v_state; RETURN;
  END IF;
  IF v_state.operation_phase='Completed' AND v_state.operation_id=p_operation_id THEN
    IF v_state.operation_kind=(CASE WHEN p_enabled THEN 'Enable' ELSE 'Disable' END)
      AND v_state.operation_identity=p_actor_identity AND v_state.operation_evidence=p_operation_evidence THEN
      RETURN NEXT v_state; RETURN;
    END IF;
    RAISE EXCEPTION 'ShellFeatureOperationConflict' USING ERRCODE='40001';
  END IF;
  IF v_state.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'ShellFeatureRevisionConflict' USING ERRCODE='40001';
  END IF;
  PERFORM * FROM console.apply_shell_feature_state(p_enabled,p_expected_revision,p_reason,NULL,
    p_actor_identity,p_operation_evidence);
  UPDATE console.shell_control_state SET operation_id=p_operation_id,
    operation_kind=CASE WHEN p_enabled THEN 'Enable' ELSE 'Disable' END,
    operation_phase=CASE WHEN p_enabled THEN 'Completed' ELSE 'Draining' END,
    operation_identity=p_actor_identity,operation_started_at=v_now,
    operation_completed_at=CASE WHEN p_enabled THEN v_now ELSE NULL END,
    scale_claim_token=NULL,scale_claim_expires_at=NULL
    WHERE singleton=true RETURNING * INTO v_state;
  RETURN NEXT v_state;
END $$;

COMMENT ON FUNCTION console.set_shell_feature_state_local_edge(boolean,bigint,text,text,jsonb,uuid) IS
  'Release-only OS Shell gate owner; evidence must match the actual latest append-only migration ID and source revision.';
