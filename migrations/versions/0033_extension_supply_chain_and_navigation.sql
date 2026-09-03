-- Extends the current C_EXT authority without rewriting previously applied migrations.
ALTER TABLE console_extension.revocation
  ADD COLUMN replacement_image_ref text CHECK (
    replacement_image_ref IS NULL
    OR replacement_image_ref ~ '^ghcr\.io/opensphere-platform/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$'
  );

CREATE OR REPLACE FUNCTION console_extension.apply_revocation(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_target_ref text,
  p_payload_digest text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_evidence jsonb;
  v_evidence_digest text;
  v_inserted boolean;
  v_row_count bigint;
  v_replacement_image_ref text;
BEGIN
  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR UPDATE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type <> 'OperationReadyForDispatch'
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner claim is stale or expired' USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id <> 'console.extension.revocation.create'
      OR v_operation.action_version <> '1.0'
      OR v_operation.target_ref <> p_target_ref
      OR v_operation.payload_digest <> p_payload_digest
      OR v_operation.state NOT IN ('Submitted', 'Reconciling', 'Unknown') THEN
    RAISE EXCEPTION 'claim does not match the typed Extension action'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF v_operation.execution_plan IS NULL
      OR jsonb_typeof(v_operation.execution_plan) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(v_operation.execution_plan)) <> 4
      OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(v_operation.execution_plan) AS key
        WHERE key NOT IN ('schemaVersion', 'authority', 'image', 'replacementImage')
      )
      OR v_operation.execution_plan->>'schemaVersion' <> '1.0'
      OR v_operation.execution_plan->>'authority' <> 'ConsoleExtensionRevocation'
      OR v_operation.execution_plan->>'image' <> v_operation.target_ref
      OR (
        jsonb_typeof(v_operation.execution_plan->'replacementImage') NOT IN ('string', 'null')
        OR (
          jsonb_typeof(v_operation.execution_plan->'replacementImage') = 'string'
          AND (
            (v_operation.execution_plan->>'replacementImage')
              !~ '^ghcr\.io/opensphere-platform/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$'
            OR (v_operation.execution_plan->>'replacementImage') = v_operation.target_ref
            OR split_part(v_operation.execution_plan->>'replacementImage', '@', 1)
              <> split_part(v_operation.target_ref, '@', 1)
          )
        )
      ) THEN
    RAISE EXCEPTION 'revocation execution plan is invalid'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;
  v_replacement_image_ref := v_operation.execution_plan->>'replacementImage';

  IF v_operation.state <> 'Reconciling' THEN
    UPDATE console_operation.operation
      SET state = 'Reconciling', state_version = state_version + 1,
          updated_at = statement_timestamp()
      WHERE operation_id = v_operation.operation_id
      RETURNING * INTO v_operation;
  END IF;

  INSERT INTO console_extension.revocation(
    image_ref, replacement_image_ref, operation_id, payload_digest, action_version, claim_epoch
  ) VALUES (
    v_operation.target_ref, v_replacement_image_ref, v_operation.operation_id,
    v_operation.payload_digest, v_operation.action_version, p_claim_epoch
  ) ON CONFLICT (image_ref) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_inserted := v_row_count = 1;

  v_evidence := jsonb_build_object(
    'schemaVersion', '1.0',
    'authority', 'ConsoleExtensionRevocation',
    'imageRef', v_operation.target_ref,
    'replacementImageRef', v_replacement_image_ref,
    'operationId', v_operation.operation_id,
    'claimEpoch', p_claim_epoch,
    'inserted', v_inserted,
    'postcondition', 'RevocationPresent'
  );
  v_evidence_digest := 'sha256:' || encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex');

  INSERT INTO console_operation.execution_receipt(
    operation_id, owner_ref, worker_id, claim_epoch, phase, evidence, evidence_digest
  ) VALUES (
    v_operation.operation_id, 'C_EXT', p_worker_id, p_claim_epoch,
    'Applied', v_evidence, v_evidence_digest
  );

  UPDATE console_operation.operation
    SET state = 'Applied', state_version = state_version + 1,
        observed_postcondition = v_evidence,
        updated_at = statement_timestamp()
    WHERE operation_id = v_operation.operation_id
    RETURNING * INTO v_operation;

  UPDATE console_operation.outbox
    SET delivered_at = statement_timestamp()
    WHERE outbox_id = v_outbox.outbox_id;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    p_worker_id::text,
    v_operation.action_id,
    v_operation.target_ref,
    'succeeded',
    '',
    jsonb_build_object(
      'ownerRef', 'C_EXT',
      'claimEpoch', p_claim_epoch,
      'state', v_operation.state,
      'stateVersion', v_operation.state_version,
      'evidenceDigest', v_evidence_digest
    )
  );

  RETURN jsonb_build_object(
    'operationRecord', to_jsonb(v_operation),
    'evidenceDigest', v_evidence_digest,
    'inserted', v_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.apply_revocation(uuid, bigint, bigint, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.apply_revocation(uuid, bigint, bigint, uuid, text, text)
  TO console_extension_controller;

CREATE OR REPLACE FUNCTION console_extension.list_revocations(
  p_session_id uuid,
  p_actor_ref uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_extension
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_data jsonb;
  v_evidence_refs jsonb;
  v_observed_at timestamptz := statement_timestamp();
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
      OR v_authority.revoke_epoch <> v_session.revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = 'console.extension.revoke'
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'imageRef', revocation.image_ref,
      'replacementImageRef', revocation.replacement_image_ref,
      'operationId', revocation.operation_id,
      'payloadDigest', revocation.payload_digest,
      'actionVersion', revocation.action_version,
      'claimEpoch', revocation.claim_epoch,
      'revokedAt', revocation.revoked_at
    ) ORDER BY revocation.revoked_at DESC, revocation.image_ref), '[]'::jsonb),
    COALESCE(jsonb_agg(to_jsonb('operation:' || revocation.operation_id::text)
      ORDER BY revocation.revoked_at DESC, revocation.image_ref), '[]'::jsonb)
    INTO v_data, v_evidence_refs
    FROM console_extension.revocation;

  RETURN jsonb_build_object(
    'schemaVersion', '1.0',
    'data', v_data,
    'authority', 'ConsoleExtensionRevocation',
    'observedAt', v_observed_at,
    'freshness', 'fresh',
    'correlationId', p_correlation_id,
    'evidenceRefs', v_evidence_refs
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.list_revocations(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.list_revocations(uuid, uuid, text) TO console_api;

CREATE OR REPLACE FUNCTION console_extension.write_presentation_preferences(
  p_actor_ref uuid,
  p_correlation_id text,
  p_updates jsonb,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_extension, console_audit
AS $$
DECLARE
  v_update jsonb;
  v_navigation jsonb;
  v_extension_id text;
  v_seen text[] := ARRAY[]::text[];
  v_updated_at timestamptz := statement_timestamp();
  v_items jsonb;
BEGIN
  IF p_actor_ref IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM console_identity.subject_authority
        WHERE subject_id = p_actor_ref
      )
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]'
      OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 500
      OR jsonb_typeof(p_updates) <> 'array'
      OR jsonb_array_length(p_updates) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid Extension presentation update'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  FOR v_update IN SELECT value FROM jsonb_array_elements(p_updates)
  LOOP
    IF jsonb_typeof(v_update) <> 'object'
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(v_update) AS key
          WHERE key NOT IN ('extensionId', 'navigation')
        )
        OR NOT (v_update ? 'extensionId')
        OR NOT (v_update ? 'navigation') THEN
      RAISE EXCEPTION 'invalid Extension presentation item'
        USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
    END IF;
    v_extension_id := v_update->>'extensionId';
    v_navigation := v_update->'navigation';
    IF COALESCE(v_extension_id, '') !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
        OR v_extension_id = ANY(v_seen)
        OR jsonb_typeof(v_navigation) <> 'object'
        OR v_navigation = '{}'::jsonb
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(v_navigation) AS key
          WHERE key NOT IN ('icon', 'labelOverride', 'bandOverride', 'order')
        )
        OR (
          v_navigation ? 'icon'
          AND (
            jsonb_typeof(v_navigation->'icon') <> 'string'
            OR (v_navigation->>'icon') !~ '^(|[a-z0-9][a-z0-9-]{0,95})$'
          )
        )
        OR (
          v_navigation ? 'labelOverride'
          AND (
            jsonb_typeof(v_navigation->'labelOverride') NOT IN ('string', 'null')
            OR length(COALESCE(v_navigation->>'labelOverride', '')) > 80
            OR COALESCE(v_navigation->>'labelOverride', '') ~ '[[:cntrl:]]'
          )
        )
        OR (
          v_navigation ? 'bandOverride'
          AND (
            jsonb_typeof(v_navigation->'bandOverride') NOT IN ('string', 'null')
            OR length(COALESCE(v_navigation->>'bandOverride', '')) > 80
            OR COALESCE(v_navigation->>'bandOverride', '') ~ '[[:cntrl:]]'
          )
        )
        OR (
          v_navigation ? 'order'
          AND (
            jsonb_typeof(v_navigation->'order') <> 'number'
            OR (v_navigation->>'order') !~ '^[0-9]+$'
            OR (v_navigation->>'order')::integer NOT BETWEEN 0 AND 63
          )
        ) THEN
      RAISE EXCEPTION 'invalid Extension navigation preference'
        USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
    END IF;
    v_seen := array_append(v_seen, v_extension_id);
  END LOOP;

  FOR v_update IN SELECT value FROM jsonb_array_elements(p_updates)
  LOOP
    v_extension_id := v_update->>'extensionId';
    v_navigation := v_update->'navigation';
    INSERT INTO console_extension.presentation_preference(
      extension_id, navigation, updated_by, updated_at
    ) VALUES (
      v_extension_id, v_navigation, p_actor_ref, v_updated_at
    )
    ON CONFLICT (extension_id) DO UPDATE
      SET navigation = console_extension.presentation_preference.navigation || EXCLUDED.navigation,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at;
  END LOOP;

  PERFORM console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    p_actor_ref::text,
    'console.extension.presentation.update',
    CASE WHEN cardinality(v_seen) = 1
      THEN 'extension:' || v_seen[1]
      ELSE 'extension-navigation'
    END,
    'succeeded',
    btrim(p_reason),
    jsonb_build_object('extensionIds', to_jsonb(v_seen), 'count', cardinality(v_seen))
  );

  SELECT console_extension.list_presentation_preferences() INTO v_items;
  RETURN jsonb_build_object(
    'items', v_items,
    'observedAt', v_updated_at,
    'authority', 'ConsoleExtensionPresentation'
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.write_presentation_preferences(uuid, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.write_presentation_preferences(uuid, text, jsonb, text)
  TO console_extension_controller;

COMMENT ON COLUMN console_extension.revocation.replacement_image_ref
  IS 'Optional exact same-repository replacement digest declared when this immutable revocation was accepted.';
COMMENT ON FUNCTION console_extension.apply_revocation(uuid, bigint, bigint, uuid, text, text)
  IS 'Applies one exact-digest revocation and its optional replacement under the current C_EXT claim fence.';
COMMENT ON FUNCTION console_extension.write_presentation_preferences(uuid, text, jsonb, text)
  IS 'Validates and atomically stores icon, label, band and order navigation preferences with audit evidence.';
