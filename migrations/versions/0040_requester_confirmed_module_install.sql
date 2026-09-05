-- CON-FR-007/010/017. User decision 2026-09-05: requester confirmation, no second-person installation approval.
-- This changes only direct Registry -> C_EXT installation. Global Git protection is unchanged.
-- MFA remains mandatory except when the DBA-recorded HTTPS target is localhost AND channel=edge.
-- Existing immutable migration bytes, data, historical approvals and Git requests are preserved.
ALTER TABLE console_operation.module_installation_environment
  DROP CONSTRAINT module_installation_environment_auth_environment_check,
  DROP CONSTRAINT module_installation_environment_kube_context_check;
ALTER TABLE console_operation.operation DROP CONSTRAINT operation_module_aal;
ALTER TABLE console_operation.operation ADD CONSTRAINT operation_module_aal CHECK (
 risk NOT IN ('R2','R3') OR aal='aal2' OR (local_development_module_install
   AND risk='R2' AND action_id='console.extension.install' AND required_permission='console.extension.install'
   AND owner_ref='C_EXT'
   AND target_ref ~ '^ghcr[.]io/opensphere-platform/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$'));

CREATE OR REPLACE FUNCTION console_operation.accept_development_module_install(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_required_permission text,
  p_action_id text,
  p_action_version text,
  p_target_ref text,
  p_payload_digest text,
  p_risk text,
  p_reason text,
  p_plan_revision text,
  p_approval_required boolean,
  p_idempotency_key text,
  p_correlation_id text,
  p_source_revision text DEFAULT NULL,
  p_owner_ref text DEFAULT NULL,
  p_expected_postcondition jsonb DEFAULT NULL,
  p_execution_plan jsonb DEFAULT NULL
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_operation console_operation.operation;
  v_request_digest text;
  v_outbox_payload jsonb;
  v_outbox_event_type text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM console_operation.module_installation_environment
      WHERE singleton AND channel='edge'
        AND console_origin ~ '^https://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?$') THEN
    RAISE EXCEPTION 'local development installation environment is not enabled'
      USING ERRCODE='42501', DETAIL='StepUpRequired';
  END IF;
  IF p_payload_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid payload digest' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_risk NOT IN ('R0', 'R1', 'R2', 'R3') THEN
    RAISE EXCEPTION 'invalid operation risk' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_risk <> 'R0' AND length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'operation reason is required' USING ERRCODE = '22023', DETAIL = 'ReasonRequired';
  END IF;

  SELECT * INTO v_session
    FROM console_identity.browser_session
    WHERE session_id = p_session_id
    FOR UPDATE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required' USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;

  SELECT * INTO v_authority
    FROM console_identity.subject_authority
    WHERE subject_id = p_actor_ref
    FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale' USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
    WHERE subject_id = p_actor_ref
      AND permission = p_required_permission
      AND grant_revision <= v_authority.permission_revision
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  IF p_action_id IS DISTINCT FROM 'console.extension.install' OR p_risk IS DISTINCT FROM 'R2'
      OR p_required_permission IS DISTINCT FROM 'console.extension.install' OR p_owner_ref IS DISTINCT FROM 'C_EXT'
      OR p_approval_required IS DISTINCT FROM false
      OR p_target_ref IS NULL OR p_target_ref !~ '^ghcr[.]io/opensphere-platform/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'development exception is restricted to Cluster Manager installation'
      USING ERRCODE = '42501', DETAIL = 'PolicyRejected';
  END IF;

  v_request_digest := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'localDevelopmentModuleInstall', true,
    'actionId', p_action_id,
    'actionVersion', p_action_version,
    'targetRef', p_target_ref,
    'requiredPermission', p_required_permission,
    'payloadDigest', p_payload_digest,
    'risk', p_risk,
    'reason', COALESCE(p_reason, ''),
    'planRevision', p_plan_revision,
    'approvalRequired', p_approval_required,
    'sourceRevision', p_source_revision,
    'ownerRef', p_owner_ref,
    'expectedPostcondition', p_expected_postcondition,
    'executionPlan', p_execution_plan
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_ref::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE actor_ref = p_actor_ref AND idempotency_key = p_idempotency_key
    FOR UPDATE;
  IF FOUND THEN
    IF v_operation.request_digest <> v_request_digest THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request'
        USING ERRCODE = '23505', DETAIL = 'IdempotencyMismatch';
    END IF;
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;

  INSERT INTO console_operation.operation(
    action_id, action_version, actor_ref, target_ref, required_permission,
    payload_digest, request_digest, risk, reason, aal, permission_revision,
    plan_revision, approval_required, idempotency_key, correlation_id,
    source_revision, owner_ref, execution_plan, state, expected_postcondition, local_development_module_install
  ) VALUES (
    p_action_id, p_action_version, p_actor_ref, p_target_ref, p_required_permission,
    p_payload_digest, v_request_digest, p_risk, COALESCE(p_reason, ''), v_session.aal,
    v_authority.permission_revision, p_plan_revision, p_approval_required,
    p_idempotency_key, p_correlation_id, p_source_revision, p_owner_ref, p_execution_plan,
    CASE WHEN p_approval_required THEN 'Planned' ELSE 'Authorized' END,
    p_expected_postcondition, true
  ) RETURNING * INTO v_operation;

  v_outbox_event_type := CASE
    WHEN v_operation.approval_required THEN 'OperationAwaitingApproval'
    ELSE 'OperationReadyForDispatch'
  END;
  v_outbox_payload := jsonb_build_object(
    'schemaVersion', '1.0',
    'eventType', v_outbox_event_type,
    'operationId', v_operation.operation_id,
    'actionId', v_operation.action_id,
    'actionVersion', v_operation.action_version,
    'targetRef', v_operation.target_ref,
    'payloadDigest', v_operation.payload_digest,
    'risk', v_operation.risk,
    'approvalRequired', v_operation.approval_required,
    'correlationId', v_operation.correlation_id
  );
  INSERT INTO console_operation.outbox(operation_id, event_type, payload, payload_digest)
  VALUES (v_operation.operation_id, v_outbox_event_type, v_outbox_payload, v_operation.payload_digest);

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    v_operation.actor_ref::text,
    v_operation.action_id,
    v_operation.target_ref,
    'accepted',
    v_operation.reason,
    jsonb_build_object(
      'requestDigest', v_operation.request_digest,
      'payloadDigest', v_operation.payload_digest,
      'risk', v_operation.risk,
      'aal', v_operation.aal,
      'localDevelopmentModuleInstall', true,
      'permissionRevision', v_operation.permission_revision,
      'approvalRequired', v_operation.approval_required
    )
  );

  UPDATE console_identity.browser_session
    SET last_seen_at = statement_timestamp()
    WHERE session_id = v_session.session_id;

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;


CREATE OR REPLACE FUNCTION console_extension.record_install_observation(
  p_worker_id uuid,
  p_outbox_id bigint,
  p_claim_epoch bigint,
  p_operation_id uuid,
  p_target_ref text,
  p_payload_digest text,
  p_applied_receipt_digest text,
  p_observation jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_extension, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_applied_receipt console_operation.execution_receipt;
  v_evidence jsonb;
  v_evidence_digest text;
BEGIN
  IF p_observation IS NULL OR jsonb_typeof(p_observation) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation)) <> 6
      OR jsonb_typeof(p_observation->'package') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'package')) <> 8
      OR jsonb_typeof(p_observation->'registration') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'registration')) <> 7
      OR jsonb_typeof(p_observation->'workload') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'workload')) <> 1
      OR jsonb_typeof(p_observation->'verification') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'verification')) <> 4
      OR jsonb_typeof(p_observation->'serving') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'serving')) <> 3
      OR jsonb_typeof(p_observation->'revalidation') <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_observation->'revalidation')) <> 1
      OR COALESCE(p_applied_receipt_digest, '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'package'->>'name', '') !~ '^[a-z0-9][a-z0-9-]{0,62}$'
      OR COALESCE(p_observation->'package'->>'resourceVersion', '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_observation->'package'->>'generation', '') !~ '^[1-9][0-9]{0,17}$'
      OR COALESCE(p_observation->'package'->>'digest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'package'->>'manifestDigest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'package'->>'sourceRevision', '') !~ '^[0-9a-f]{40}$'
      OR COALESCE(p_observation->'package'->>'compatibilityVersion', '') !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
      OR length(COALESCE(p_observation->'package'->>'keyId', '')) NOT BETWEEN 1 AND 256
      OR COALESCE(p_observation->'registration'->>'name', '') !~ '^[a-z0-9][a-z0-9-]{0,62}$'
      OR length(COALESCE(p_observation->'registration'->>'uid', '')) NOT BETWEEN 1 AND 128
      OR COALESCE(p_observation->'registration'->>'resourceVersion', '') !~ '^[0-9A-Za-z._:-]{1,128}$'
      OR COALESCE(p_observation->'registration'->>'generation', '') !~ '^[1-9][0-9]{0,17}$'
      OR COALESCE(p_observation->'registration'->>'observedGeneration', '') !~ '^[1-9][0-9]{0,17}$'
      OR NOT (
        (p_observation->'registration'->>'desiredState' = 'Installed'
          AND p_observation->'registration'->>'phase' = 'Ready')
        OR (p_observation->'registration'->>'desiredState' = 'Enabled'
          AND p_observation->'registration'->>'phase' = 'Activated')
      )
      OR (p_observation->'registration'->>'observedGeneration')::bigint
        < (p_observation->'registration'->>'generation')::bigint
      OR p_observation->'workload'->>'phase' <> 'Ready'
      OR p_observation->'verification'->>'manifest' <> 'Verified'
      OR p_observation->'verification'->>'signature' <> 'Verified'
      OR p_observation->'verification'->>'entryDigest' <> 'Verified'
      OR p_observation->'verification'->>'permissions' <> 'Approved'
      OR p_observation->'serving'->>'phase' <> 'Current'
      OR COALESCE(p_observation->'serving'->>'digest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR COALESCE(p_observation->'serving'->>'manifestDigest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR p_observation->'revalidation'->>'phase' <> 'Passed' THEN
    RAISE EXCEPTION 'invalid Extension install observation'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_outbox
    FROM console_operation.outbox
    WHERE outbox_id = p_outbox_id
    FOR UPDATE;
  IF NOT FOUND OR v_outbox.operation_id <> p_operation_id
      OR v_outbox.event_type <> 'ExtensionInstallObservationRequested'
      OR v_outbox.claim_owner <> p_worker_id
      OR v_outbox.claim_epoch <> p_claim_epoch
      OR v_outbox.delivered_at IS NOT NULL
      OR v_outbox.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'owner observation claim is stale or expired'
      USING ERRCODE = '40001', DETAIL = 'StaleClaim';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = p_operation_id
    FOR UPDATE;
  IF NOT FOUND OR v_operation.owner_ref <> 'C_EXT'
      OR v_operation.action_id <> 'console.extension.install'
      OR v_operation.action_version <> '1.0'
      OR v_operation.target_ref <> p_target_ref
      OR v_operation.payload_digest <> p_payload_digest
      OR v_operation.state <> 'Applied' THEN
    RAISE EXCEPTION 'observation claim does not match an Applied Extension install'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM console_extension.revocation
    WHERE image_ref = p_target_ref
  ) THEN
    RAISE EXCEPTION 'exact Extension image digest is revoked before ready observation'
      USING ERRCODE = '55000', DETAIL = 'ImageRevoked';
  END IF;

  SELECT * INTO v_applied_receipt
    FROM console_operation.execution_receipt
    WHERE operation_id = p_operation_id
      AND owner_ref = 'C_EXT'
      AND phase = 'Applied'
      AND evidence_digest = p_applied_receipt_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Applied install receipt is missing'
      USING ERRCODE = '55000', DETAIL = 'ObservationMissing';
  END IF;
  IF v_applied_receipt.evidence->>'authority' <> 'KubernetesUIPluginRegistration'
      OR v_applied_receipt.evidence->>'postcondition' <> 'RegistrationPresent'
      OR v_applied_receipt.evidence->>'operationId' <> p_operation_id::text
      OR v_applied_receipt.evidence->>'image' <> p_target_ref
      OR v_applied_receipt.evidence->>'registrationName' <> p_observation->'registration'->>'name'
      OR v_applied_receipt.evidence->>'registrationUid' <> p_observation->'registration'->>'uid'
      OR v_applied_receipt.evidence->>'packageResourceVersion' <> p_observation->'package'->>'resourceVersion'
      OR v_applied_receipt.evidence->>'packageGeneration' <> p_observation->'package'->>'generation'
      OR v_applied_receipt.evidence->>'manifestDigest' <> p_observation->'package'->>'manifestDigest'
      OR v_applied_receipt.evidence->>'sourceRevision' <> p_observation->'package'->>'sourceRevision'
      OR v_applied_receipt.evidence->>'compatibilityVersion' <> p_observation->'package'->>'compatibilityVersion'
      OR v_applied_receipt.evidence->>'keyId' <> p_observation->'package'->>'keyId'
      OR v_operation.execution_plan->>'descriptorId' <> ('extension.' || (p_observation->'package'->>'name'))
      OR split_part(p_target_ref, '@', 2) <> p_observation->'package'->>'digest'
      OR p_observation->'serving'->>'digest' <> p_observation->'package'->>'digest'
      OR p_observation->'serving'->>'manifestDigest' <> p_observation->'package'->>'manifestDigest' THEN
    RAISE EXCEPTION 'install observation does not match the Applied coordinates'
      USING ERRCODE = '55000', DETAIL = 'ObservationMismatch';
  END IF;

  v_evidence := jsonb_build_object(
    'schemaVersion', '1.0',
    'authority', 'KubernetesUIPluginRegistration',
    'operationId', p_operation_id,
    'image', p_target_ref,
    'appliedReceiptDigest', p_applied_receipt_digest,
    'package', p_observation->'package',
    'registration', p_observation->'registration',
    'workload', p_observation->'workload',
    'verification', p_observation->'verification',
    'serving', p_observation->'serving',
    'revalidation', p_observation->'revalidation',
    'postcondition', 'InstallReady'
  );
  v_evidence_digest := 'sha256:' || encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex');

  INSERT INTO console_operation.execution_receipt(
    operation_id, owner_ref, worker_id, claim_epoch, phase, evidence, evidence_digest
  ) VALUES (
    p_operation_id, 'C_EXT', p_worker_id, p_claim_epoch,
    'Verified', v_evidence, v_evidence_digest
  );
  UPDATE console_operation.outbox
    SET delivered_at = statement_timestamp()
    WHERE outbox_id = p_outbox_id;
  -- Direct installs need no second user or final verification click. The existing
  -- owner has already verified the exact image, signature, UID/generation, serving,
  -- fresh revocation check and workload readiness above. Do not change Git-bound requests.
  IF NOT v_operation.approval_required AND v_operation.declaration_binding IS NULL THEN
    UPDATE console_operation.operation
      SET state='Verified',state_version=state_version+1,
        observed_postcondition=v_evidence || jsonb_build_object('ownerObservationReceiptDigest',v_evidence_digest),
        updated_at=statement_timestamp()
      WHERE operation_id=p_operation_id RETURNING * INTO v_operation;
  END IF;
  PERFORM console_audit.append_event_internal(
    p_operation_id, v_operation.correlation_id, p_worker_id::text,
    'console.extension.install.observe', p_target_ref, 'succeeded', '',
    jsonb_build_object(
      'ownerRef', 'C_EXT', 'claimEpoch', p_claim_epoch,
      'evidenceDigest', v_evidence_digest, 'postcondition', 'InstallReady'
    )
  );
  RETURN jsonb_build_object(
    'operationRecord', to_jsonb(v_operation),
    'evidenceDigest', v_evidence_digest,
    'postcondition', 'InstallReady'
  );
END;
$$;

REVOKE ALL ON FUNCTION console_extension.record_install_observation(
  uuid, bigint, bigint, uuid, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.record_install_observation(
  uuid, bigint, bigint, uuid, text, text, text, jsonb
) TO console_extension_controller;

