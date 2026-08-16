\set ON_ERROR_STOP on

BEGIN;

-- 0061 is already released.  This additive migration closes the remaining
-- multi-replica admission and owner kill-switch boundaries without rewriting
-- released history.
CREATE TABLE console.shell_control_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  actor_active_limit integer NOT NULL DEFAULT 2 CHECK(actor_active_limit BETWEEN 1 AND 10),
  global_active_limit integer NOT NULL DEFAULT 8 CHECK(global_active_limit BETWEEN 1 AND 1000),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 512),
  changed_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  changed_identity text NOT NULL CHECK(length(btrim(changed_identity)) BETWEEN 3 AND 256),
  operation_evidence jsonb NOT NULL CHECK(jsonb_typeof(operation_evidence)='object'),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  drain_completed_at timestamptz,
  operation_id uuid,
  operation_kind text CHECK(operation_kind IN ('Enable','Disable')),
  operation_phase text CHECK(operation_phase IN ('Draining','ScaleDownClaimed','Completed')),
  operation_identity text CHECK(operation_identity IS NULL OR length(btrim(operation_identity)) BETWEEN 3 AND 256),
  operation_started_at timestamptz,
  operation_completed_at timestamptz,
  scale_claim_token uuid,
  scale_claim_expires_at timestamptz,
  CHECK (
    (operation_id IS NULL AND operation_kind IS NULL AND operation_phase IS NULL AND operation_identity IS NULL
      AND operation_started_at IS NULL AND operation_completed_at IS NULL AND scale_claim_token IS NULL
      AND scale_claim_expires_at IS NULL)
    OR
    (operation_id IS NOT NULL AND operation_kind IS NOT NULL AND operation_phase IS NOT NULL
      AND operation_identity IS NOT NULL AND operation_started_at IS NOT NULL)
  ),
  CHECK ((scale_claim_token IS NULL)=(scale_claim_expires_at IS NULL)),
  CHECK (operation_phase='ScaleDownClaimed' OR (scale_claim_token IS NULL AND scale_claim_expires_at IS NULL))
);

INSERT INTO console.shell_control_state(singleton,enabled,reason,changed_identity,operation_evidence)
VALUES(true,false,'0062 requires an explicit AAL2 owner enable after exact component readiness',
  'migration:0062',jsonb_build_object('authority','migration','migrationId','0062'));

CREATE TABLE console.shell_control_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision bigint NOT NULL CHECK(revision>0),
  enabled boolean NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('Enabled','DisableRequested','DrainCompleted','ScaleDownClaimed','ScaleDownCompleted')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 512),
  actor_id uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  actor_identity text NOT NULL CHECK(length(btrim(actor_identity)) BETWEEN 3 AND 256),
  operation_evidence jsonb NOT NULL CHECK(jsonb_typeof(operation_evidence)='object'),
  affected_sessions integer NOT NULL DEFAULT 0 CHECK(affected_sessions>=0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION console.reject_shell_control_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,console AS $$
BEGIN
  RAISE EXCEPTION 'console.shell_control_event is append-only';
END $$;

CREATE TRIGGER shell_control_event_append_only
  BEFORE UPDATE OR DELETE ON console.shell_control_event
  FOR EACH ROW EXECUTE FUNCTION console.reject_shell_control_event_mutation();
ALTER TABLE console.shell_control_event ENABLE ALWAYS TRIGGER shell_control_event_append_only;
CREATE TRIGGER shell_control_event_no_truncate
  BEFORE TRUNCATE ON console.shell_control_event
  FOR EACH STATEMENT EXECUTE FUNCTION console.reject_shell_control_event_mutation();
ALTER TABLE console.shell_control_event ENABLE ALWAYS TRIGGER shell_control_event_no_truncate;

CREATE OR REPLACE FUNCTION console.shell_feature_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,console AS $$
  SELECT enabled FROM console.shell_control_state WHERE singleton=true
$$;

CREATE OR REPLACE FUNCTION console.shell_actor_has_permission(p_actor_id uuid,p_permission text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
  SELECT console.shell_feature_enabled() AND EXISTS(
    SELECT 1 FROM console.operator o
    JOIN console.operator_role ur ON ur.user_id=o.user_id
    JOIN console.role_permission rp ON rp.role_id=ur.role_id
    JOIN console.permission p ON p.id=rp.permission_id
    WHERE o.user_id=p_actor_id AND o.status='active' AND p.code=p_permission
      AND (ur.expires_at IS NULL OR ur.expires_at>clock_timestamp())
  )
$$;

CREATE OR REPLACE FUNCTION console.get_shell_feature_state()
RETURNS TABLE(enabled boolean,revision bigint,actor_active_limit integer,global_active_limit integer,
  reason text,changed_by uuid,changed_at timestamptz,drain_completed_at timestamptz,
  active_sessions bigint,active_tickets bigint,scale_down_allowed boolean,
  operation_id uuid,operation_kind text,operation_phase text,operation_identity text,
  operation_started_at timestamptz,operation_completed_at timestamptz,scale_claim_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_state console.shell_control_state%ROWTYPE; v_active bigint; v_tickets bigint; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO v_state FROM console.shell_control_state WHERE singleton=true FOR UPDATE;
  SELECT count(*) INTO v_active FROM console.shell_session
    WHERE desired_state='Running' OR observed_state<>'Terminated';
  IF NOT v_state.enabled AND v_active=0 AND v_state.drain_completed_at IS NULL THEN
    UPDATE console.shell_control_state SET drain_completed_at=v_now WHERE singleton=true RETURNING * INTO v_state;
    INSERT INTO console.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
      VALUES(v_state.revision,false,'DrainCompleted','All fenced shell runtimes reached Terminated',v_state.changed_by,
        v_state.changed_identity,v_state.operation_evidence,0);
  END IF;
  SELECT count(*) INTO v_tickets FROM console.shell_attach_ticket
    WHERE consumed_at IS NULL AND expires_at>v_now;
  RETURN QUERY SELECT v_state.enabled,v_state.revision,v_state.actor_active_limit,v_state.global_active_limit,
    v_state.reason,v_state.changed_by,v_state.changed_at,v_state.drain_completed_at,v_active,
    v_tickets,(NOT v_state.enabled AND v_active=0 AND v_tickets=0 AND v_state.drain_completed_at IS NOT NULL),
    v_state.operation_id,v_state.operation_kind,v_state.operation_phase,v_state.operation_identity,
    v_state.operation_started_at,v_state.operation_completed_at,v_state.scale_claim_expires_at;
END $$;

CREATE OR REPLACE FUNCTION console.apply_shell_feature_state(
  p_enabled boolean,p_expected_revision bigint,p_reason text,p_actor_id uuid,
  p_actor_identity text,p_operation_evidence jsonb
) RETURNS SETOF console.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_state console.shell_control_state%ROWTYPE; v_affected integer:=0; v_active bigint; v_tickets bigint;
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_enabled IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1
    OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 8 AND 512
    OR length(btrim(coalesce(p_actor_identity,''))) NOT BETWEEN 3 AND 256
    OR jsonb_typeof(p_operation_evidence)<>'object' THEN
    RAISE EXCEPTION 'ShellFeatureOperationInvalid';
  END IF;
  SELECT * INTO v_state FROM console.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'ShellFeatureRevisionConflict' USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO v_active FROM console.shell_session
    WHERE desired_state='Running' OR observed_state<>'Terminated';
  SELECT count(*) INTO v_tickets FROM console.shell_attach_ticket
    WHERE consumed_at IS NULL AND expires_at>v_now;
  -- A retry of the exact durable operation is idempotent. A same-boolean
  -- request carrying a new signed release intent is an authority refresh and
  -- must advance the revision/event. A disabled row with legacy active work
  -- must always re-enter drain even if its boolean already reads false.
  IF v_state.enabled=p_enabled AND v_state.changed_identity=btrim(p_actor_identity)
    AND v_state.operation_evidence=p_operation_evidence AND v_state.reason=btrim(p_reason)
    AND (p_enabled OR (v_active=0 AND v_tickets=0)) THEN
    RETURN NEXT v_state; RETURN;
  END IF;

  -- The gate changes before any session mutation in this same transaction.
  UPDATE console.shell_control_state SET enabled=p_enabled,revision=revision+1,reason=btrim(p_reason),
    changed_by=p_actor_id,changed_identity=btrim(p_actor_identity),operation_evidence=p_operation_evidence,
    changed_at=v_now,drain_completed_at=NULL
    WHERE singleton=true RETURNING * INTO v_state;
  IF NOT p_enabled THEN
    UPDATE console.shell_session SET desired_state='Terminated',
      termination_requested_at=coalesce(termination_requested_at,v_now),updated_at=v_now
      WHERE observed_state<>'Terminated' AND desired_state='Running';
    GET DIAGNOSTICS v_affected=ROW_COUNT;
    UPDATE console.shell_attach_ticket SET expires_at=least(expires_at,v_now)
      WHERE consumed_at IS NULL AND expires_at>v_now;
    INSERT INTO console.shell_session_event(
      session_id,actor_id,session_class,runtime_adapter_id,generation,fencing_epoch,
      event_type,result,reason_code,origin,permission_revision,aal,release_evidence_ref,
      manifest_sha256,key_id,runtime_image_digest,os_artifact_digest,session_policy_revision
    ) SELECT session_id,actor_id,session_class,runtime_adapter_id,generation,fencing_epoch,
      'PolicyDenied','Denied','ShellFeatureDisabled',origin,permission_revision,aal,release_evidence_ref,
      manifest_sha256,key_id,runtime_image_digest,os_artifact_digest,session_policy_revision
      FROM console.shell_session WHERE observed_state<>'Terminated' AND termination_requested_at=v_now;
  END IF;
  INSERT INTO console.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
    VALUES(v_state.revision,p_enabled,CASE WHEN p_enabled THEN 'Enabled' ELSE 'DisableRequested' END,
      btrim(p_reason),p_actor_id,btrim(p_actor_identity),p_operation_evidence,v_affected);
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console.set_shell_feature_state(
  p_enabled boolean,p_expected_revision bigint,p_reason text,p_actor_id uuid
) RETURNS SETOF console.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_state console.shell_control_state%ROWTYPE;
BEGIN
  IF p_enabled THEN
    RAISE EXCEPTION 'ShellFeatureBrowserEnableRequiresVerifiedRelease'
      USING ERRCODE='28000',HINT='Use the signed release-controller enable workflow after exact component readiness.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM console.operator WHERE user_id=p_actor_id AND status='active') THEN
    RAISE EXCEPTION 'ShellFeatureActorInvalid' USING ERRCODE='28000';
  END IF;
  SELECT * INTO v_state FROM console.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.operation_phase IN ('Draining','ScaleDownClaimed') THEN
    RAISE EXCEPTION 'ShellFeatureOperationConflict' USING ERRCODE='40001';
  END IF;
  PERFORM * FROM console.apply_shell_feature_state(false,p_expected_revision,p_reason,p_actor_id,
    'operator:'||p_actor_id::text,jsonb_build_object('authority','browser-aal2'));
  UPDATE console.shell_control_state SET operation_id=NULL,operation_kind=NULL,operation_phase=NULL,
    operation_identity=NULL,operation_started_at=NULL,operation_completed_at=NULL,
    scale_claim_token=NULL,scale_claim_expires_at=NULL WHERE singleton=true RETURNING * INTO v_state;
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console.set_shell_feature_state_local_edge(
  p_enabled boolean,p_expected_revision bigint,p_reason text,p_actor_identity text,p_operation_evidence jsonb,
  p_operation_id uuid
) RETURNS SETOF console.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_state console.shell_control_state%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
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
    OR p_operation_evidence->>'latestMigrationId'<>'0062' THEN
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

CREATE OR REPLACE FUNCTION console.claim_shell_feature_scale_down(
  p_operation_id uuid,p_expected_revision bigint,p_actor_identity text,
  p_scale_claim_token uuid,p_lease_seconds integer DEFAULT 120
) RETURNS SETOF console.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_state console.shell_control_state%ROWTYPE; v_active bigint; v_tickets bigint; v_now timestamptz:=clock_timestamp();
  v_emit_claim boolean:=false;
BEGIN
  IF p_operation_id IS NULL OR p_scale_claim_token IS NULL OR p_expected_revision<1
    OR p_actor_identity<>'system:serviceaccount:opensphere-console:opensphere-local-edge-release'
    OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'ShellFeatureScaleDownClaimInvalid' USING ERRCODE='28000';
  END IF;
  SELECT * INTO v_state FROM console.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.revision<>p_expected_revision OR v_state.enabled
    OR v_state.operation_id<>p_operation_id OR v_state.operation_kind<>'Disable'
    OR v_state.operation_identity<>p_actor_identity OR v_state.operation_phase NOT IN ('Draining','ScaleDownClaimed') THEN
    RAISE EXCEPTION 'ShellFeatureScaleDownFenceLost' USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO v_active FROM console.shell_session
    WHERE desired_state='Running' OR observed_state<>'Terminated';
  SELECT count(*) INTO v_tickets FROM console.shell_attach_ticket
    WHERE consumed_at IS NULL AND expires_at>v_now;
  IF v_active<>0 OR v_tickets<>0 THEN RAISE EXCEPTION 'ShellFeatureDrainIncomplete' USING ERRCODE='40001'; END IF;
  IF v_state.drain_completed_at IS NULL THEN
    UPDATE console.shell_control_state SET drain_completed_at=v_now WHERE singleton=true RETURNING * INTO v_state;
    INSERT INTO console.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
      VALUES(v_state.revision,false,'DrainCompleted','All fenced shell runtimes reached Terminated',v_state.changed_by,
        v_state.changed_identity,v_state.operation_evidence,0);
  END IF;
  IF v_state.operation_phase='ScaleDownClaimed' AND v_state.scale_claim_token<>p_scale_claim_token
    AND v_state.scale_claim_expires_at>v_now THEN
    RAISE EXCEPTION 'ShellFeatureScaleDownClaimHeld' USING ERRCODE='40001';
  END IF;
  v_emit_claim:=v_state.operation_phase<>'ScaleDownClaimed' OR v_state.scale_claim_token IS DISTINCT FROM p_scale_claim_token;
  UPDATE console.shell_control_state SET operation_phase='ScaleDownClaimed',scale_claim_token=p_scale_claim_token,
    scale_claim_expires_at=v_now+make_interval(secs=>p_lease_seconds),operation_completed_at=NULL
    WHERE singleton=true RETURNING * INTO v_state;
  IF v_emit_claim THEN
    INSERT INTO console.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
      VALUES(v_state.revision,false,'ScaleDownClaimed','Exclusive fenced scale-down claim acquired',v_state.changed_by,
        v_state.changed_identity,v_state.operation_evidence,0);
  END IF;
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console.complete_shell_feature_scale_down(
  p_operation_id uuid,p_expected_revision bigint,p_actor_identity text,p_scale_claim_token uuid
) RETURNS SETOF console.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_state console.shell_control_state%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO v_state FROM console.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.revision<>p_expected_revision OR v_state.enabled OR v_state.operation_id<>p_operation_id
    OR v_state.operation_kind<>'Disable' OR v_state.operation_identity<>p_actor_identity
    OR v_state.operation_phase<>'ScaleDownClaimed' OR v_state.scale_claim_token<>p_scale_claim_token
    OR v_state.scale_claim_expires_at<=v_now THEN
    RAISE EXCEPTION 'ShellFeatureScaleDownFenceLost' USING ERRCODE='40001';
  END IF;
  UPDATE console.shell_control_state SET operation_phase='Completed',operation_completed_at=v_now,
    scale_claim_token=NULL,scale_claim_expires_at=NULL WHERE singleton=true RETURNING * INTO v_state;
  INSERT INTO console.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
    VALUES(v_state.revision,false,'ScaleDownCompleted','Exact control workloads reached replicas zero',v_state.changed_by,
      v_state.changed_identity,v_state.operation_evidence,0);
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console.create_shell_session(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,p_aal text,
  p_permission_revision text,p_runtime_template_revision text,p_idle_expires_at timestamptz,
  p_absolute_expires_at timestamptz,p_release_evidence jsonb
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE
  v_browser console.browser_session%ROWTYPE; v_existing console.shell_session%ROWTYPE;
  v_state console.shell_control_state%ROWTYPE; v_now timestamptz:=clock_timestamp();
  v_actor_active bigint; v_global_active bigint;
BEGIN
  SELECT * INTO v_state FROM console.shell_control_state WHERE singleton=true;
  IF NOT v_state.enabled THEN RAISE EXCEPTION 'ShellFeatureDisabled'; END IF;
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_browser FROM console.browser_session
    WHERE id=p_browser_session_id AND owner_id=p_actor_id FOR SHARE;
  IF NOT FOUND OR v_browser.status<>'active' OR v_browser.idle_expires_at<=v_now
    OR v_browser.absolute_expires_at<=v_now OR v_browser.assurance<>p_aal
    OR v_browser.credential_revision<>(SELECT credential_revision FROM console.operator WHERE user_id=p_actor_id) THEN
    RAISE EXCEPTION 'durable browser session is not active or assurance changed' USING ERRCODE='28000';
  END IF;
  IF p_idle_expires_at<=v_now OR p_absolute_expires_at<=v_now
    OR p_idle_expires_at>p_absolute_expires_at OR p_idle_expires_at>v_browser.idle_expires_at
    OR p_absolute_expires_at>v_browser.absolute_expires_at THEN
    RAISE EXCEPTION 'shell session expiry exceeds the durable browser session';
  END IF;
  IF jsonb_typeof(p_release_evidence)<>'object'
    OR NOT p_release_evidence?&ARRAY['releaseEvidenceRef','manifestSha256','keyId','runtimeImageDigest','osArtifactDigest','sessionPolicyRevision']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_release_evidence) AS release_key(key)
      WHERE key<>ALL(ARRAY['releaseEvidenceRef','manifestSha256','keyId','runtimeImageDigest','osArtifactDigest','sessionPolicyRevision'])) THEN
    RAISE EXCEPTION 'complete closed release evidence is required';
  END IF;

  -- Every API replica uses the same lock order.  The UUID is a deterministic
  -- projection of actor + browser session + client idempotency key.
  PERFORM pg_advisory_xact_lock(hashtextextended('opensphere.shell.global',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('opensphere.shell.actor:'||p_actor_id::text,0));
  SELECT * INTO v_state FROM console.shell_control_state WHERE singleton=true FOR SHARE;
  IF NOT v_state.enabled THEN RAISE EXCEPTION 'ShellFeatureDisabled'; END IF;

  SELECT * INTO v_existing FROM console.shell_session WHERE session_id=p_session_id;
  IF FOUND THEN
    IF v_existing.browser_session_id=p_browser_session_id AND v_existing.actor_id=p_actor_id
      AND v_existing.origin=p_origin AND v_existing.aal=p_aal
      AND v_existing.permission_revision=p_permission_revision
      AND v_existing.runtime_template_revision=p_runtime_template_revision
      AND v_existing.release_evidence_ref=p_release_evidence->>'releaseEvidenceRef'
      AND v_existing.manifest_sha256=p_release_evidence->>'manifestSha256'
      AND v_existing.key_id=p_release_evidence->>'keyId'
      AND v_existing.runtime_image_digest=p_release_evidence->>'runtimeImageDigest'
      AND v_existing.os_artifact_digest=p_release_evidence->>'osArtifactDigest'
      AND v_existing.session_policy_revision=p_release_evidence->>'sessionPolicyRevision' THEN
      RETURN NEXT v_existing; RETURN;
    END IF;
    RAISE EXCEPTION 'ShellSessionIdempotencyConflict' USING ERRCODE='40001';
  END IF;

  SELECT count(*) INTO v_global_active FROM console.shell_session
    WHERE desired_state='Running' AND observed_state<>'Terminated'
      AND idle_expires_at>v_now AND absolute_expires_at>v_now;
  IF v_global_active>=v_state.global_active_limit THEN RAISE EXCEPTION 'ShellGlobalSessionQuotaExceeded'; END IF;
  SELECT count(*) INTO v_actor_active FROM console.shell_session
    WHERE actor_id=p_actor_id AND desired_state='Running' AND observed_state<>'Terminated'
      AND idle_expires_at>v_now AND absolute_expires_at>v_now;
  IF v_actor_active>=v_state.actor_active_limit THEN RAISE EXCEPTION 'ShellActorSessionQuotaExceeded'; END IF;

  INSERT INTO console.shell_session(
    session_id,browser_session_id,actor_id,runtime_template_revision,origin,permission_revision,aal,
    idle_expires_at,absolute_expires_at,release_evidence_ref,manifest_sha256,key_id,
    runtime_image_digest,os_artifact_digest,session_policy_revision
  ) VALUES(
    p_session_id,p_browser_session_id,p_actor_id,p_runtime_template_revision,p_origin,p_permission_revision,p_aal,
    p_idle_expires_at,p_absolute_expires_at,p_release_evidence->>'releaseEvidenceRef',
    p_release_evidence->>'manifestSha256',p_release_evidence->>'keyId',
    p_release_evidence->>'runtimeImageDigest',p_release_evidence->>'osArtifactDigest',
    p_release_evidence->>'sessionPolicyRevision'
  );
  PERFORM console.append_shell_session_event(p_session_id,'SessionCreated','Succeeded','SessionIntentAccepted');
  RETURN QUERY SELECT * FROM console.shell_session WHERE session_id=p_session_id;
END $$;

CREATE OR REPLACE FUNCTION console.issue_shell_attach_ticket(
  p_ticket_hash text,p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text,p_expires_at timestamptz
) RETURNS SETOF console.shell_attach_ticket
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  IF NOT console.shell_feature_enabled() THEN RAISE EXCEPTION 'ShellFeatureDisabled'; END IF;
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.browser_session_id<>p_browser_session_id OR v_session.actor_id<>p_actor_id
    OR v_session.origin<>p_origin OR v_session.generation<>p_generation
    OR v_session.fencing_epoch<>p_fencing_epoch OR v_session.aal<>p_aal
    OR v_session.permission_revision<>p_permission_revision OR v_session.desired_state<>'Running'
    OR v_session.observed_state<>'Ready' OR v_session.idle_expires_at<=v_now
    OR v_session.absolute_expires_at<=v_now THEN
    RAISE EXCEPTION 'shell session binding is not attachable' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM console.browser_session b JOIN console.operator o ON o.user_id=b.owner_id
    WHERE b.id=p_browser_session_id AND b.owner_id=p_actor_id AND b.status='active'
      AND b.assurance=p_aal AND b.credential_revision=o.credential_revision
      AND b.idle_expires_at>v_now AND b.absolute_expires_at>v_now) THEN
    RAISE EXCEPTION 'durable browser session is no longer active' USING ERRCODE='28000';
  END IF;
  IF p_expires_at<=v_now OR p_expires_at>v_now+interval '30 seconds'
    OR p_expires_at>v_session.idle_expires_at OR p_expires_at>v_session.absolute_expires_at THEN
    RAISE EXCEPTION 'attach ticket TTL must be at most 30 seconds';
  END IF;
  INSERT INTO console.shell_attach_ticket(
    ticket_hash,session_id,browser_session_id,actor_id,origin,generation,fencing_epoch,
    permission_revision,aal,expires_at
  ) VALUES(p_ticket_hash,p_session_id,p_browser_session_id,p_actor_id,p_origin,p_generation,p_fencing_epoch,
    p_permission_revision,p_aal,p_expires_at);
  PERFORM console.append_shell_session_event(p_session_id,'AttachTicketIssued','Succeeded','AttachTicketBound');
  RETURN QUERY SELECT * FROM console.shell_attach_ticket WHERE ticket_hash=p_ticket_hash;
END $$;

CREATE OR REPLACE FUNCTION console.touch_shell_session_activity(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_browser console.browser_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  IF NOT console.shell_feature_enabled() THEN RETURN; END IF;
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR UPDATE;
  SELECT * INTO v_browser FROM console.browser_session
    WHERE id=p_browser_session_id AND owner_id=p_actor_id FOR SHARE;
  IF v_session.session_id IS NULL OR v_browser.id IS NULL
    OR v_session.browser_session_id<>p_browser_session_id OR v_session.actor_id<>p_actor_id
    OR v_session.origin<>p_origin OR v_session.generation<>p_generation
    OR v_session.fencing_epoch<>p_fencing_epoch OR v_session.aal<>p_aal
    OR v_session.permission_revision<>p_permission_revision OR v_session.desired_state<>'Running'
    OR v_session.observed_state<>'Ready' OR v_session.absolute_expires_at<=v_now
    OR v_browser.status<>'active' OR v_browser.assurance<>p_aal
    OR v_browser.idle_expires_at<=v_now OR v_browser.absolute_expires_at<=v_now THEN RETURN; END IF;
  UPDATE console.shell_session SET last_activity_at=v_now,
    idle_expires_at=least(v_now+interval '15 minutes',absolute_expires_at,
      v_browser.idle_expires_at,v_browser.absolute_expires_at),updated_at=v_now
    WHERE session_id=p_session_id RETURNING * INTO v_session;
  RETURN NEXT v_session;
END $$;

ALTER TABLE console.shell_control_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.shell_control_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE console.shell_control_state,console.shell_control_event
  FROM PUBLIC,anon,authenticated,service_role,authenticator,opensphere_console_backend,
    opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;
REVOKE ALL ON SEQUENCE console.shell_control_event_event_id_seq
  FROM PUBLIC,anon,authenticated,service_role,authenticator,opensphere_console_backend,
    opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;

REVOKE ALL ON FUNCTION console.shell_feature_enabled() FROM PUBLIC;
REVOKE ALL ON FUNCTION console.get_shell_feature_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION console.set_shell_feature_state(boolean,bigint,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.apply_shell_feature_state(boolean,bigint,text,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.set_shell_feature_state_local_edge(boolean,bigint,text,text,jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.claim_shell_feature_scale_down(uuid,bigint,text,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.complete_shell_feature_scale_down(uuid,bigint,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.touch_shell_session_activity(uuid,uuid,uuid,text,bigint,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console.shell_feature_enabled()
  TO opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler,opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.get_shell_feature_state()
  TO opensphere_shell_api,opensphere_shell_reconciler,opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.set_shell_feature_state(boolean,bigint,text,uuid)
  TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.set_shell_feature_state_local_edge(boolean,bigint,text,text,jsonb,uuid)
  TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.claim_shell_feature_scale_down(uuid,bigint,text,uuid,integer)
  TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.complete_shell_feature_scale_down(uuid,bigint,text,uuid)
  TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.touch_shell_session_activity(uuid,uuid,uuid,text,bigint,bigint,text,text)
  TO opensphere_shell_gateway;

COMMIT;
