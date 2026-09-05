-- CON-FR-010/007: reuse the C_EXT operation and fenced outbox; Git adds a gate.
-- No approval is copied or fabricated, no role/table/queue or Kubernetes grant is added.
ALTER TABLE console_operation.operation ADD COLUMN declaration_binding jsonb;
ALTER TABLE console_operation.operation ADD COLUMN declaration_merge_revision text
  CHECK (declaration_merge_revision IS NULL OR declaration_merge_revision ~ '^[0-9a-f]{40,64}$');

CREATE OR REPLACE FUNCTION console_operation.accept_gitea_module(p_input jsonb)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation
AS $$
DECLARE
 b jsonb := p_input->'declarationBinding';
 d jsonb := b->'desiredState';
 v record;
 o console_operation.operation;
BEGIN
 IF b IS NULL OR b->>'schemaVersion' IS DISTINCT FROM '1.0'
   OR b->>'authority' IS DISTINCT FROM 'Gitea'
   OR b->>'repository' IS DISTINCT FROM 'opensphere/platform-declarations'
   OR b->>'defaultBranch' IS DISTINCT FROM 'main'
   OR b->>'consumerId' IS DISTINCT FROM 'console-modules'
   OR b->>'action' IS DISTINCT FROM 'apply'
   OR b->>'target' IS DISTINCT FROM 'extension.cluster-manager'
   OR b->>'templateId' IS DISTINCT FROM 'console-cluster-manager-install'
   OR (SELECT count(*) FROM jsonb_object_keys(b)) <> 9
   OR d->>'contract' IS DISTINCT FROM 'opensphere.console.git-reviewed-module/v1'
   OR d->>'descriptorId' IS DISTINCT FROM 'extension.cluster-manager'
   OR COALESCE(d->>'catalogRevision','') !~ '^sha256:[a-f0-9]{64}$'
   OR COALESCE(d->>'image','') !~ '^ghcr[.]io/opensphere-platform/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$'
   OR (SELECT count(*) FROM jsonb_object_keys(d)) <> 4
   OR p_input->>'actionId' IS DISTINCT FROM 'console.extension.install'
   OR p_input->>'actionVersion' IS DISTINCT FROM '1.0'
   OR p_input->>'ownerRef' IS DISTINCT FROM 'C_EXT'
   OR p_input->>'requiredPermission' IS DISTINCT FROM 'console.extension.install'
   OR p_input->>'risk' IS DISTINCT FROM 'R2'
   OR p_input->>'approvalRequired' IS DISTINCT FROM 'true'
   OR p_input->>'targetRef' IS DISTINCT FROM d->>'image'
   OR p_input->>'sourceRevision' IS NOT NULL
   OR p_input->'executionPlan' IS DISTINCT FROM jsonb_build_object(
     'schemaVersion','1.0','authority','OpenSphereRegistry','descriptorId',d->>'descriptorId',
     'catalogRevision',d->>'catalogRevision','image',d->>'image')
   OR p_input->'expectedPostcondition' IS DISTINCT FROM jsonb_build_object('declaration',b) THEN
   RAISE EXCEPTION 'only the closed Git-reviewed Cluster Manager installation is supported'
     USING ERRCODE='42501', DETAIL='PolicyRejected';
 END IF;
 -- The underlying RPC repeats session/revision/AAL/install authorization checks.
 IF NOT EXISTS (SELECT 1 FROM console_identity.permission_grant
   WHERE subject_id=(p_input->>'actorRef')::uuid AND permission='console.git.change'
     AND grant_revision <= (p_input->>'expectedPermissionRevision')::bigint AND revoked_at IS NULL) THEN
   RAISE EXCEPTION 'Git change permission is required' USING ERRCODE='42501', DETAIL='PermissionDenied';
 END IF;
 IF p_input->>'localDevelopmentModuleInstall' = 'true' THEN
   SELECT * INTO v FROM console_operation.accept_development_module_install((p_input->>'sessionId')::uuid,
     (p_input->>'actorRef')::uuid,
     (p_input->>'expectedPermissionRevision')::bigint,
     (p_input->>'expectedRevokeEpoch')::bigint,
     (p_input->>'requiredPermission')::text,
     (p_input->>'actionId')::text,
     (p_input->>'actionVersion')::text,
     (p_input->>'targetRef')::text,
     (p_input->>'payloadDigest')::text,
     (p_input->>'risk')::text,
     (p_input->>'reason')::text,
     (p_input->>'planRevision')::text,
     (p_input->>'approvalRequired')::boolean,
     (p_input->>'idempotencyKey')::text,
     (p_input->>'correlationId')::text,
     (p_input->>'sourceRevision')::text,
     (p_input->>'ownerRef')::text,
     p_input->'expectedPostcondition',
     p_input->'executionPlan');
 ELSE
   SELECT * INTO v FROM console_operation.accept_operation((p_input->>'sessionId')::uuid,
     (p_input->>'actorRef')::uuid,
     (p_input->>'expectedPermissionRevision')::bigint,
     (p_input->>'expectedRevokeEpoch')::bigint,
     (p_input->>'requiredPermission')::text,
     (p_input->>'actionId')::text,
     (p_input->>'actionVersion')::text,
     (p_input->>'targetRef')::text,
     (p_input->>'payloadDigest')::text,
     (p_input->>'risk')::text,
     (p_input->>'reason')::text,
     (p_input->>'planRevision')::text,
     (p_input->>'approvalRequired')::boolean,
     (p_input->>'idempotencyKey')::text,
     (p_input->>'correlationId')::text,
     (p_input->>'sourceRevision')::text,
     (p_input->>'ownerRef')::text,
     p_input->'expectedPostcondition',
     p_input->'executionPlan');
 END IF;
 SELECT * INTO o FROM console_operation.operation
   WHERE operation_id=(v.operation_record->>'operation_id')::uuid FOR UPDATE;
 IF v.replayed AND o.declaration_binding IS DISTINCT FROM b THEN
   RAISE EXCEPTION 'idempotency key belongs to another dispatch boundary'
     USING ERRCODE='23505', DETAIL='IdempotencyMismatch';
 END IF;
 IF NOT v.replayed THEN
   UPDATE console_operation.operation SET declaration_binding=b
     WHERE operation_id=o.operation_id RETURNING * INTO o;
 END IF;
 RETURN QUERY SELECT to_jsonb(o), v.replayed;
END;
$$;
REVOKE ALL ON FUNCTION console_operation.accept_gitea_module(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.accept_gitea_module(jsonb) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.claim_owner_operation(
  p_worker_id uuid,
  p_owner_ref text,
  p_supported_actions text[],
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_audit
AS $$
DECLARE
  v_outbox console_operation.outbox;
  v_operation console_operation.operation;
  v_initial_state text;
BEGIN
  IF p_worker_id IS NULL OR length(btrim(COALESCE(p_owner_ref, ''))) < 1
      OR COALESCE(array_length(p_supported_actions, 1), 0) < 1
      OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid owner claim request' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  IF p_owner_ref <> 'C_EXT'
      OR p_supported_actions <> ARRAY[
        'console.extension.install', 'console.extension.remove', 'console.extension.revocation.create'
      ]::text[] THEN
    RAISE EXCEPTION 'worker role is outside its typed owner capability'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  SELECT dispatch.* INTO v_outbox
    FROM console_operation.outbox dispatch
    JOIN console_operation.operation operation_record USING (operation_id)
    WHERE dispatch.event_type IN (
      'OperationReadyForDispatch',
      'ExtensionInstallObservationRequested',
      'ExtensionRemovalObservationRequested'
    )
      AND dispatch.delivered_at IS NULL
      AND (dispatch.lease_expires_at IS NULL OR dispatch.lease_expires_at <= statement_timestamp())
      AND (operation_record.declaration_binding IS NULL OR operation_record.declaration_merge_revision IS NOT NULL)
      AND operation_record.owner_ref = p_owner_ref
      AND operation_record.action_id = ANY(p_supported_actions)
      AND (
        (dispatch.event_type = 'OperationReadyForDispatch'
          AND operation_record.state IN ('Authorized', 'Submitted', 'Reconciling', 'Unknown'))
        OR (dispatch.event_type = 'ExtensionInstallObservationRequested'
          AND operation_record.action_id = 'console.extension.install'
          AND operation_record.state = 'Applied')
        OR (dispatch.event_type = 'ExtensionRemovalObservationRequested'
          AND operation_record.action_id = 'console.extension.remove'
          AND operation_record.state = 'Applied')
      )
    ORDER BY dispatch.outbox_id
    FOR UPDATE OF dispatch SKIP LOCKED
    LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
    WHERE operation_id = v_outbox.operation_id
    FOR UPDATE;
  v_initial_state := v_operation.state;

  UPDATE console_operation.outbox
    SET claim_owner = p_worker_id,
        claim_epoch = claim_epoch + 1,
        claimed_at = statement_timestamp(),
        lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
        attempt_count = attempt_count + 1
    WHERE outbox_id = v_outbox.outbox_id
    RETURNING * INTO v_outbox;

  IF v_outbox.event_type = 'OperationReadyForDispatch' AND v_operation.state = 'Authorized' THEN
    UPDATE console_operation.operation
      SET state = 'Submitted', state_version = state_version + 1,
          updated_at = statement_timestamp()
      WHERE operation_id = v_operation.operation_id
      RETURNING * INTO v_operation;
  END IF;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    v_operation.correlation_id,
    p_worker_id::text,
    'console.operation.dispatch.claim',
    v_operation.target_ref,
    'accepted',
    '',
    jsonb_build_object(
      'ownerRef', p_owner_ref,
      'outboxId', v_outbox.outbox_id,
      'claimEpoch', v_outbox.claim_epoch,
      'attemptCount', v_outbox.attempt_count,
      'leaseExpiresAt', v_outbox.lease_expires_at,
      'resumeMode', CASE WHEN v_initial_state = 'Authorized' THEN 'apply' ELSE 'reconcile' END,
      'dispatchPhase', CASE WHEN v_outbox.event_type IN (
        'ExtensionInstallObservationRequested', 'ExtensionRemovalObservationRequested'
      ) THEN 'observe' ELSE 'apply' END
    )
  );

  RETURN jsonb_build_object(
    'schemaVersion', '1.0',
    'outboxId', v_outbox.outbox_id,
    'operationId', v_operation.operation_id,
    'actionId', v_operation.action_id,
    'actionVersion', v_operation.action_version,
    'actorRef', v_operation.actor_ref,
    'reason', v_operation.reason,
    'targetRef', v_operation.target_ref,
    'payloadDigest', v_operation.payload_digest,
    'executionPlan', v_operation.execution_plan,
    'ownerRef', v_operation.owner_ref,
    'claimEpoch', v_outbox.claim_epoch,
    'leaseExpiresAt', v_outbox.lease_expires_at,
    'attemptCount', v_outbox.attempt_count,
    'resumeMode', CASE WHEN v_initial_state = 'Authorized' THEN 'apply' ELSE 'reconcile' END,
    'dispatchPhase', CASE WHEN v_outbox.event_type IN (
      'ExtensionInstallObservationRequested', 'ExtensionRemovalObservationRequested'
    ) THEN 'observe' ELSE 'apply' END,
    'dispatchPayload', v_outbox.payload,
    'state', v_operation.state,
    'stateVersion', v_operation.state_version,
    'correlationId', v_operation.correlation_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_operation.get_gitea_bound_operation_for_approval(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_initiator_authority console_identity.subject_authority;
  v_operation console_operation.operation;
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session
   WHERE session_id = p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
   WHERE subject_id = p_actor_ref FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  SELECT * INTO v_operation FROM console_operation.operation
   WHERE operation_id = p_operation_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  IF ((v_session.aal <> 'aal2'
      OR v_session.last_reauthenticated_at IS NULL
      OR v_session.last_reauthenticated_at < statement_timestamp() - interval '5 minutes'
      OR v_session.last_reauthenticated_at > statement_timestamp() + interval '30 seconds'
      ) AND NOT (
        v_operation.local_development_module_install
        AND v_operation.action_id='console.extension.install' AND v_operation.owner_ref='C_EXT'
        AND v_operation.target_ref ~ '^ghcr[.]io/opensphere-platform/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$'
        AND COALESCE(v_operation.declaration_binding->>'templateId','')='console-cluster-manager-install'
        AND EXISTS (SELECT 1 FROM console_operation.module_installation_environment
          WHERE singleton AND channel='edge' AND auth_environment='development'
            AND kube_context='docker-desktop'
            AND console_origin ~ '^https://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?$')
      )) OR NOT EXISTS (
        SELECT 1 FROM console_identity.permission_grant
         WHERE subject_id = p_actor_ref
           AND permission = 'console.operation.approve'
           AND grant_revision <= v_authority.permission_revision
           AND revoked_at IS NULL
      ) THEN
    RAISE EXCEPTION 'recent approval authority is required'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;
  SELECT * INTO v_initiator_authority FROM console_identity.subject_authority
   WHERE subject_id = v_operation.actor_ref FOR SHARE;
  IF v_operation.actor_ref = p_actor_ref OR NOT FOUND
      OR v_initiator_authority.person_ref = v_authority.person_ref THEN
    RAISE EXCEPTION 'operation initiator cannot approve the same operation'
      USING ERRCODE = '42501', DETAIL = 'SelfApprovalDenied';
  END IF;
  IF NOT ((v_operation.action_id = 'console.platform.change.propose' AND v_operation.owner_ref = 'API_GIT')
      OR (v_operation.action_id = 'console.extension.install' AND v_operation.owner_ref = 'C_EXT'
          AND v_operation.declaration_binding IS NOT NULL AND v_operation.declaration_binding->>'templateId' = 'console-cluster-manager-install'))
      OR v_operation.action_version <> '1.0'
      OR v_operation.state NOT IN ('Planned', 'Authorized', 'Submitted') THEN
    RAISE EXCEPTION 'operation is outside the Gitea approval boundary'
      USING ERRCODE = '55000', DETAIL = 'InvalidOperationState';
  END IF;
  RETURN to_jsonb(v_operation);
END;
$$;

REVOKE ALL ON FUNCTION console_operation.get_gitea_bound_operation_for_approval(uuid, uuid, bigint, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.get_gitea_bound_operation_for_approval(uuid, uuid, bigint, bigint, uuid) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.record_gitea_proposal(
  p_operation_id uuid,
  p_desired_revision text,
  p_branch text,
  p_pull_number integer,
  p_correlation_id text
)
RETURNS TABLE(proposal_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_audit
AS $$
DECLARE
  v_operation console_operation.operation;
  v_evidence jsonb;
  v_existing jsonb;
  v_plan jsonb;
BEGIN
  IF p_operation_id IS NULL
      OR COALESCE(p_desired_revision, '') !~ '^[0-9a-f]{40,64}$'
      OR p_branch <> 'control/' || p_operation_id::text
      OR p_pull_number < 1
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'invalid Gitea proposal receipt'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
   WHERE operation_id = p_operation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  v_plan := COALESCE(v_operation.declaration_binding, v_operation.execution_plan);
  IF NOT ((v_operation.action_id = 'console.platform.change.propose' AND v_operation.owner_ref = 'API_GIT')
      OR (v_operation.action_id = 'console.extension.install' AND v_operation.owner_ref = 'C_EXT'
          AND v_operation.declaration_binding IS NOT NULL AND v_operation.declaration_binding->>'templateId' = 'console-cluster-manager-install'))
      OR v_operation.action_version <> '1.0'
      OR NOT v_operation.approval_required
      OR v_plan->>'authority' <> 'Gitea'
      OR v_plan->>'repository' <> 'opensphere/platform-declarations'
      OR v_plan->>'defaultBranch' <> 'main'
      OR v_operation.state NOT IN ('Planned', 'Authorized', 'Submitted') THEN
    RAISE EXCEPTION 'operation is outside the Gitea proposal receipt boundary'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  v_evidence := jsonb_build_object(
    'repository', v_plan->>'repository',
    'branch', p_branch,
    'pullNumber', p_pull_number,
    'desiredRevision', p_desired_revision
  );
  SELECT evidence INTO v_existing
    FROM console_audit.event
   WHERE operation_id = p_operation_id
     AND action = 'console.platform.change.proposal'
   ORDER BY sequence_id DESC
   LIMIT 1;
  IF FOUND THEN
    IF v_existing = v_evidence THEN
      RETURN QUERY SELECT v_existing, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'conflicting Gitea proposal receipt'
      USING ERRCODE = '55000', DETAIL = 'ReceiptConflict';
  END IF;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    p_correlation_id,
    'API_GIT',
    'console.platform.change.proposal',
    v_operation.target_ref,
    'succeeded',
    '',
    v_evidence
  );

  RETURN QUERY SELECT v_evidence, false;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.record_gitea_proposal(uuid, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.record_gitea_proposal(uuid, text, text, integer, text) TO console_api;

COMMENT ON FUNCTION console_operation.record_gitea_proposal(uuid, text, text, integer, text)
  IS 'Records one immutable Gitea pull-request coordinate set for an existing durable Console operation without creating another authority store.';
CREATE OR REPLACE FUNCTION console_operation.record_gitea_merge(
  p_operation_id uuid,
  p_source_revision text,
  p_branch text,
  p_pull_number integer,
  p_correlation_id text
)
RETURNS TABLE(operation_record jsonb, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_audit
AS $$
DECLARE
  v_operation console_operation.operation;
  v_plan jsonb;
  v_proposal jsonb;
BEGIN
  IF p_operation_id IS NULL
      OR COALESCE(p_source_revision, '') !~ '^[0-9a-f]{40,64}$'
      OR p_branch <> 'control/' || p_operation_id::text
      OR p_pull_number < 1
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'invalid Gitea merge receipt'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  SELECT * INTO v_operation
    FROM console_operation.operation
   WHERE operation_id = p_operation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation was not found'
      USING ERRCODE = 'P0002', DETAIL = 'NotFound';
  END IF;
  v_plan := COALESCE(v_operation.declaration_binding, v_operation.execution_plan);
  IF NOT ((v_operation.action_id = 'console.platform.change.propose' AND v_operation.owner_ref = 'API_GIT')
      OR (v_operation.action_id = 'console.extension.install' AND v_operation.owner_ref = 'C_EXT'
          AND v_operation.declaration_binding IS NOT NULL AND v_operation.declaration_binding->>'templateId' = 'console-cluster-manager-install'))
      OR v_operation.action_version <> '1.0'
      OR NOT v_operation.approval_required
      OR v_operation.approval_revision IS NULL
      OR v_plan->>'authority' <> 'Gitea'
      OR v_plan->>'repository' <> 'opensphere/platform-declarations'
      OR v_plan->>'defaultBranch' <> 'main' THEN
    RAISE EXCEPTION 'operation is outside the Gitea merge receipt boundary'
      USING ERRCODE = '42501', DETAIL = 'ClaimBindingMismatch';
  END IF;

  IF v_operation.declaration_binding IS NOT NULL THEN
    SELECT evidence INTO v_proposal FROM console_audit.event
      WHERE operation_id=p_operation_id AND action='console.platform.change.proposal'
      ORDER BY sequence_id DESC LIMIT 1;
    IF NOT FOUND OR v_proposal->>'branch' IS DISTINCT FROM p_branch
       OR (v_proposal->>'pullNumber')::integer IS DISTINCT FROM p_pull_number THEN
      RAISE EXCEPTION 'merge does not match the recorded proposal' USING ERRCODE='42501', DETAIL='ClaimBindingMismatch';
    END IF;
  END IF;
  IF (v_operation.state = 'Submitted' AND v_operation.source_revision = p_source_revision AND v_operation.declaration_binding IS NULL)
      OR (v_operation.declaration_binding IS NOT NULL AND v_operation.declaration_merge_revision = p_source_revision) THEN
    RETURN QUERY SELECT to_jsonb(v_operation), true;
    RETURN;
  END IF;
  IF v_operation.state <> 'Authorized'
      OR v_operation.source_revision IS NOT NULL THEN
    RAISE EXCEPTION 'operation is not awaiting a Gitea merge receipt'
      USING ERRCODE = '55000', DETAIL = 'InvalidOperationState';
  END IF;

  UPDATE console_operation.operation
     SET source_revision = CASE WHEN declaration_binding IS NULL THEN p_source_revision ELSE source_revision END,
         declaration_merge_revision = CASE WHEN declaration_binding IS NOT NULL THEN p_source_revision ELSE NULL END,
         state = 'Submitted',
         state_version = state_version + 1,
         updated_at = statement_timestamp()
   WHERE operation_id = p_operation_id
   RETURNING * INTO v_operation;

  PERFORM console_audit.append_event_internal(
    v_operation.operation_id,
    p_correlation_id,
    'API_GIT',
    'console.platform.change.merge',
    v_operation.target_ref,
    'succeeded',
    '',
    jsonb_build_object(
      'repository', v_plan->>'repository',
      'branch', p_branch,
      'pullNumber', p_pull_number,
      'sourceRevision', p_source_revision,
      'state', v_operation.state,
      'stateVersion', v_operation.state_version
    )
  );

  RETURN QUERY SELECT to_jsonb(v_operation), false;
END;
$$;

REVOKE ALL ON FUNCTION console_operation.record_gitea_merge(uuid, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.record_gitea_merge(uuid, text, text, integer, text) TO console_api;

CREATE OR REPLACE FUNCTION console_operation.list_gitea_changes(
  p_session_id uuid,
  p_actor_ref uuid,
  p_expected_permission_revision bigint,
  p_expected_revoke_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation, console_audit
AS $$
DECLARE
  v_session console_identity.browser_session;
  v_authority console_identity.subject_authority;
  v_items jsonb;
  v_observed_at timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO v_session FROM console_identity.browser_session
   WHERE session_id = p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.subject_id <> p_actor_ref OR v_session.revoked_at IS NOT NULL
      OR v_session.expires_at <= v_observed_at THEN
    RAISE EXCEPTION 'active Console session is required'
      USING ERRCODE = '28000', DETAIL = 'SessionInvalid';
  END IF;
  SELECT * INTO v_authority FROM console_identity.subject_authority
   WHERE subject_id = p_actor_ref FOR SHARE;
  IF NOT FOUND OR v_authority.permission_revision <> v_session.permission_revision
      OR v_authority.permission_revision <> p_expected_permission_revision
      OR v_authority.revoke_epoch <> v_session.revoke_epoch
      OR v_authority.revoke_epoch <> p_expected_revoke_epoch THEN
    RAISE EXCEPTION 'session authority revision is stale'
      USING ERRCODE = '28000', DETAIL = 'StaleAuthorityRevision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_identity.permission_grant
     WHERE subject_id = p_actor_ref
       AND permission = 'console.git.change'
       AND grant_revision <= v_authority.permission_revision
       AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'console.git.change permission is required'
      USING ERRCODE = '42501', DETAIL = 'PermissionDenied';
  END IF;

  WITH recent AS (
    SELECT operation.*
      FROM console_operation.operation
     WHERE action_version = '1.0' AND ((action_id = 'console.platform.change.propose' AND owner_ref = 'API_GIT')
       OR (action_id = 'console.extension.install' AND owner_ref = 'C_EXT' AND declaration_binding IS NOT NULL))
     ORDER BY created_at DESC, operation_id DESC
     LIMIT 100
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'operationId', recent.operation_id,
    'actorRef', recent.actor_ref,
    'action', COALESCE(recent.declaration_binding, recent.execution_plan)->>'action',
    'target', COALESCE(recent.declaration_binding, recent.execution_plan)->>'target',
    'reason', recent.reason,
    'repository', COALESCE(recent.declaration_binding, recent.execution_plan)->>'repository',
    'state', recent.state,
    'sourceRevision', CASE WHEN recent.declaration_binding IS NOT NULL THEN recent.declaration_merge_revision ELSE recent.source_revision END,
    'nativeOwner', CASE WHEN recent.declaration_binding IS NOT NULL THEN recent.owner_ref ELSE NULL END,
    'stateVersion', recent.state_version,
    'localDevelopmentModuleInstall', recent.local_development_module_install AND EXISTS (SELECT 1 FROM console_operation.module_installation_environment WHERE singleton AND channel='edge' AND auth_environment='development' AND kube_context='docker-desktop'),
    'observedPostcondition', recent.observed_postcondition,
    'ownerReceipts', COALESCE(owner_receipts.items, '[]'::jsonb),
    'errorCode', recent.error->>'code',
    'createdAt', recent.created_at,
    'updatedAt', recent.updated_at,
    'proposal', proposal.evidence,
    'approvals', COALESCE(approvals.items, '[]'::jsonb),
    'outbox', outbox.item
  ) ORDER BY recent.created_at DESC, recent.operation_id DESC), '[]'::jsonb)
    INTO v_items
    FROM recent
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', e.execution_receipt_id, 'phase', e.phase,
        'owner', e.owner_ref, 'digest', e.evidence_digest, 'createdAt', e.created_at,
        'postcondition', e.evidence->>'postcondition') ORDER BY e.created_at) AS items
      FROM console_operation.execution_receipt e WHERE e.operation_id=recent.operation_id
    ) owner_receipts ON true
    LEFT JOIN LATERAL (
      SELECT event.evidence
        FROM console_audit.event
       WHERE event.operation_id = recent.operation_id
         AND event.action = 'console.platform.change.proposal'
       ORDER BY event.sequence_id DESC
       LIMIT 1
    ) proposal ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'approverId', approval.actor_ref,
        'createdAt', approval.created_at
      ) ORDER BY approval.created_at) AS items
        FROM console_operation.approval
       WHERE approval.operation_id = recent.operation_id
    ) approvals ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'eventType', pending.event_type,
        'attemptCount', pending.attempt_count,
        'claimedAt', pending.claimed_at,
        'leaseExpiresAt', pending.lease_expires_at,
        'deliveredAt', pending.delivered_at,
        'createdAt', pending.created_at
      ) AS item
        FROM console_operation.outbox pending
       WHERE pending.operation_id = recent.operation_id
       ORDER BY pending.created_at DESC, pending.outbox_id DESC
       LIMIT 1
    ) outbox ON true;

  RETURN jsonb_build_object('observedAt', v_observed_at, 'items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION console_operation.list_gitea_changes(uuid, uuid, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.list_gitea_changes(uuid, uuid, bigint, bigint) TO console_api;

COMMENT ON FUNCTION console_operation.list_gitea_changes(uuid, uuid, bigint, bigint)
  IS 'Returns a permission-gated bounded Gitea change inventory from existing operation, approval, outbox and immutable audit evidence.';
