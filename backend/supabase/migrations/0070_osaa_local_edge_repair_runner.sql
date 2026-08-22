\set ON_ERROR_STOP on

-- PLAN-014 local-edge Engineering Remediation activation. The human operator
-- approves one exact patch-bound work unit; the OSAA service principal is the
-- requester, and a short-lived Windows Docker Desktop runner performs only the
-- registered Console component workflow.

ALTER TABLE osaa.engineering_remediation_request
  ADD COLUMN IF NOT EXISTS operator_id uuid,
  ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'two-stage'
    CHECK (approval_mode IN ('two-stage','local-edge-supervised')),
  ADD COLUMN IF NOT EXISTS verification_profile text NOT NULL DEFAULT 'authenticated-health'
    CHECK (verification_profile IN ('authenticated-health','manual-route','registry-plugins','osaa-admin')),
  ADD COLUMN IF NOT EXISTS verification_route text NOT NULL DEFAULT '/'
    CHECK (verification_route IN ('/','/manual','/manage/extensions/plugins','/manage/osaa'));

UPDATE osaa.engineering_remediation_request request SET operator_id=operation.actor_id
FROM console.module_operation operation
WHERE operation.operation_id=request.operation_id AND request.operator_id IS NULL;
ALTER TABLE osaa.engineering_remediation_request ALTER COLUMN operator_id SET NOT NULL;

ALTER TABLE osaa.build_evidence ALTER COLUMN sbom_digest DROP NOT NULL;
ALTER TABLE osaa.build_evidence ALTER COLUMN signature_digest DROP NOT NULL;

CREATE TABLE IF NOT EXISTS osaa.engineering_remediation_runner (
  runner_id text PRIMARY KEY CHECK (runner_id ~ '^local-edge-[a-z0-9][a-z0-9-]{7,80}$'),
  claim_epoch bigint NOT NULL CHECK (claim_epoch>0),
  host_digest text NOT NULL CHECK (host_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  repository text NOT NULL CHECK (repository='https://github.com/opensphere-platform/OpenSphere-console.git'),
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at>last_seen_at AND expires_at<=last_seen_at+interval '45 seconds')
);

CREATE TABLE IF NOT EXISTS osaa.engineering_browser_verification (
  verification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remediation_request_id uuid NOT NULL REFERENCES osaa.engineering_remediation_request(remediation_request_id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL,
  verification_profile text NOT NULL,
  verification_route text NOT NULL,
  observed_source_revision text NOT NULL CHECK (observed_source_revision ~ '^[0-9a-f]{40}$'),
  marker text NOT NULL CHECK (length(marker) BETWEEN 1 AND 240),
  console_error_count integer NOT NULL CHECK (console_error_count>=0),
  network_failure_count integer NOT NULL CHECK (network_failure_count>=0),
  passed boolean NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(remediation_request_id,evidence_digest)
);

CREATE OR REPLACE FUNCTION osaa.register_engineering_remediation_runner(
  p_runner_id text,p_claim_epoch bigint,p_host_digest text,p_source_revision text,p_repository text
) RETURNS osaa.engineering_remediation_runner
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,osaa AS $$
DECLARE registered osaa.engineering_remediation_runner%ROWTYPE;
BEGIN
  IF p_runner_id!~'^local-edge-[a-z0-9][a-z0-9-]{7,80}$' OR p_claim_epoch<1
     OR p_host_digest!~'^sha256:[0-9a-f]{64}$' OR p_source_revision!~'^[0-9a-f]{40}$'
     OR p_repository<>'https://github.com/opensphere-platform/OpenSphere-console.git' THEN
    RAISE EXCEPTION 'canonical local edge Repair Runner evidence required';
  END IF;
  INSERT INTO osaa.engineering_remediation_runner(
    runner_id,claim_epoch,host_digest,source_revision,repository,last_seen_at,expires_at
  ) VALUES(
    p_runner_id,p_claim_epoch,p_host_digest,p_source_revision,p_repository,
    clock_timestamp(),clock_timestamp()+interval '30 seconds'
  ) ON CONFLICT(runner_id) DO UPDATE SET
    claim_epoch=EXCLUDED.claim_epoch,host_digest=EXCLUDED.host_digest,
    source_revision=EXCLUDED.source_revision,repository=EXCLUDED.repository,
    last_seen_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 seconds'
  WHERE osaa.engineering_remediation_runner.claim_epoch<=EXCLUDED.claim_epoch
  RETURNING * INTO registered;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale Repair Runner epoch rejected'; END IF;
  RETURN registered;
END $$;

CREATE OR REPLACE FUNCTION osaa.engineering_remediation_runner_ready(p_repository text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,osaa AS $$
  SELECT EXISTS(
    SELECT 1 FROM osaa.engineering_remediation_runner
    WHERE repository=p_repository AND expires_at>clock_timestamp()
  )
$$;

-- Canonical source authority correction. Gitea is the declarative change
-- authority; GitHub is the canonical implementation source authority.
CREATE OR REPLACE FUNCTION osaa.propose_engineering_remediation(
  p_remediation_request_id uuid,p_idempotency_key text,p_actor_id uuid,p_assurance text,
  p_auth_session_id uuid,p_authz_revision text,p_assessment_id uuid,p_incident_id uuid,
  p_repository text,p_base_revision text,p_allowed_paths text[],p_patch_digest text,
  p_reason text,p_risk_level text,p_affected_components text[],p_affected_images text[],
  p_required_tests text[],p_release_scope text,p_full_release_justification text,
  p_target_channel text,p_build_authority text,p_rollback_revision text,
  p_rollback_image_digests text[],p_approval_binding_digest text,p_approval_expires_at timestamptz
) RETURNS osaa.engineering_remediation_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,osaa,console AS $$
DECLARE assessment osaa.remediation_assessment%ROWTYPE; mismatch osaa.mismatch%ROWTYPE;
  operation_id uuid; existing console.module_operation%ROWTYPE;
  created osaa.engineering_remediation_request%ROWTYPE;
  allowed_prefixes text[]; allowed_components text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key,82422));
  SELECT * INTO existing FROM console.module_operation WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.actor_id<>p_actor_id OR existing.action<>'engineering-remediation'
       OR existing.target_fingerprint<>p_approval_binding_digest THEN
      RAISE EXCEPTION 'idempotency key is bound to a different remediation proposal';
    END IF;
    SELECT * INTO created FROM osaa.engineering_remediation_request WHERE operation_id=existing.operation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'idempotent remediation proposal is incomplete'; END IF;
    RETURN created;
  END IF;
  SELECT * INTO assessment FROM osaa.remediation_assessment WHERE assessment_id=p_assessment_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'remediation assessment not found'; END IF;
  SELECT * INTO mismatch FROM osaa.mismatch WHERE mismatch_id=assessment.mismatch_id FOR SHARE;
  IF NOT FOUND OR mismatch.resolved_at IS NOT NULL OR mismatch.epistemic_state<>'known' THEN
    RAISE EXCEPTION 'fresh known unresolved mismatch is required';
  END IF;
  IF assessment.engineering_required IS NOT TRUE OR assessment.minimum_ladder_step<5 THEN
    RAISE EXCEPTION 'lower recovery ladder is not evidence-exhausted';
  END IF;
  IF assessment.incident_id IS DISTINCT FROM p_incident_id OR mismatch.incident_id IS DISTINCT FROM p_incident_id THEN
    RAISE EXCEPTION 'incident, mismatch and assessment correlation must match';
  END IF;
  IF p_approval_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'future approval expiry required'; END IF;
  CASE p_repository
    WHEN 'https://github.com/opensphere-platform/OpenSphere-console.git' THEN
      allowed_prefixes:=ARRAY['backend/','src/','nginx/','docs/'];
      allowed_components:=ARRAY['console','consoleBackend','osaaGateway'];
    WHEN 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git' THEN
      allowed_prefixes:=ARRAY['src/','deploy/','tests/','docs/']; allowed_components:=ARRAY['setup'];
    WHEN 'https://github.com/opensphere-platform/OpenSphere-shell-clusterManager.git' THEN
      allowed_prefixes:=ARRAY['src/','backend/','tests/']; allowed_components:=ARRAY['clusterManager'];
    WHEN 'https://github.com/opensphere-platform/OpenSphere-shell-foundation.git' THEN
      allowed_prefixes:=ARRAY['src/','backend/','tests/']; allowed_components:=ARRAY['foundation'];
    ELSE RAISE EXCEPTION 'repository is not canonical or allowlisted';
  END CASE;
  IF cardinality(p_allowed_paths)<1 OR EXISTS(
    SELECT 1 FROM unnest(p_allowed_paths) path WHERE path LIKE '/%' OR path LIKE '%..%'
      OR NOT EXISTS(SELECT 1 FROM unnest(allowed_prefixes) prefix WHERE path LIKE prefix||'%')
  ) THEN RAISE EXCEPTION 'allowed path is outside repository policy'; END IF;
  IF cardinality(p_affected_components)<1 OR EXISTS(
    SELECT 1 FROM unnest(p_affected_components) component WHERE NOT component=ANY(allowed_components)
  ) THEN RAISE EXCEPTION 'affected component is outside repository policy'; END IF;
  IF cardinality(p_affected_images)<1 OR EXISTS(
    SELECT 1 FROM unnest(p_affected_images) image WHERE image!~'^[a-z0-9][a-z0-9._-]{1,127}$'
  ) THEN RAISE EXCEPTION 'affected image must use a canonical image id'; END IF;
  IF cardinality(p_required_tests)<1 OR EXISTS(
    SELECT 1 FROM unnest(p_required_tests) test_id
    WHERE NOT test_id=ANY(ARRAY['unit','contract','integration','security','migration','ui-e2e','supply-chain'])
  ) THEN RAISE EXCEPTION 'required test is not registered'; END IF;
  operation_id:=gen_random_uuid();
  INSERT INTO console.module_operation(
    operation_id,idempotency_key,module_id,action,actor_id,reason,assurance,risk_class,
    target_fingerprint,phase,incident_id,descriptor_revision,descriptor_digest,target_uid,
    requested_risk_class,required_assurance,actor_assurance_at_accept,auth_session_id,
    authz_revision,deadline_at,execution_state,verification_state,precondition,expected_postcondition
  ) VALUES(
    operation_id,p_idempotency_key,'r2d2','engineering-remediation',p_actor_id,p_reason,p_assurance,p_risk_level,
    p_approval_binding_digest,'AwaitingApproval',p_incident_id,'engineering-remediation-v2',p_approval_binding_digest,
    'mismatch:'||mismatch.mismatch_id,p_risk_level,'aal2',p_assurance,p_auth_session_id,p_authz_revision,
    p_approval_expires_at,'awaiting_approval','not_required',
    jsonb_build_object('proposalOnly',true,'assessmentId',p_assessment_id,'mismatchId',mismatch.mismatch_id),
    jsonb_build_object('repositoryWrite',false,'build',false,'publish',false,'deploy',false)
  );
  INSERT INTO osaa.engineering_remediation_request(
    remediation_request_id,assessment_id,incident_id,operation_id,operator_id,repository,base_revision,
    allowed_paths,patch_digest,reason,risk_level,affected_components,affected_images,required_tests,
    release_scope,full_release_justification,target_channel,build_authority,rollback_revision,
    rollback_image_digests,approval_binding_digest,approval_expires_at,stage
  ) VALUES(
    p_remediation_request_id,p_assessment_id,p_incident_id,operation_id,p_actor_id,p_repository,p_base_revision,
    p_allowed_paths,p_patch_digest,p_reason,p_risk_level,p_affected_components,p_affected_images,p_required_tests,
    p_release_scope,p_full_release_justification,p_target_channel,p_build_authority,p_rollback_revision,
    p_rollback_image_digests,p_approval_binding_digest,p_approval_expires_at,'proposed'
  ) RETURNING * INTO created;
  RETURN created;
END $$;

CREATE OR REPLACE FUNCTION osaa.propose_engineering_remediation_v3(
  p_remediation_request_id uuid,p_idempotency_key text,p_agent_actor_id uuid,p_operator_id uuid,p_assurance text,
  p_auth_session_id uuid,p_authz_revision text,p_assessment_id uuid,p_incident_id uuid,
  p_repository text,p_base_revision text,p_allowed_paths text[],p_patch_digest text,p_patch_text text,
  p_changed_paths text[],p_patch_evidence_digest text,p_reason text,p_risk_level text,
  p_affected_components text[],p_affected_images text[],p_required_tests text[],p_release_scope text,
  p_full_release_justification text,p_target_channel text,p_build_authority text,p_rollback_revision text,
  p_rollback_image_digests text[],p_approval_binding_digest text,p_approval_mode text,
  p_verification_profile text,p_verification_route text,p_approval_expires_at timestamptz
) RETURNS osaa.engineering_remediation_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,osaa,console,extensions AS $$
DECLARE created osaa.engineering_remediation_request%ROWTYPE; existing console.module_operation%ROWTYPE;
  computed_digest text;
BEGIN
  IF p_agent_actor_id<>'00000000-0000-4000-8000-000000000006'::uuid OR p_operator_id=p_agent_actor_id THEN
    RAISE EXCEPTION 'OSAA service requester and distinct human operator are required';
  END IF;
  IF p_approval_mode<>'local-edge-supervised' OR p_target_channel<>'edge' OR p_release_scope<>'component'
     OR p_repository<>'https://github.com/opensphere-platform/OpenSphere-console.git' OR p_risk_level<>'R2' THEN
    RAISE EXCEPTION 'Repair Runner v3 supports only supervised local edge Console R2 work';
  END IF;
  IF NOT ((p_verification_profile='authenticated-health' AND p_verification_route='/')
    OR (p_verification_profile='manual-route' AND p_verification_route='/manual')
    OR (p_verification_profile='registry-plugins' AND p_verification_route='/manage/extensions/plugins')
    OR (p_verification_profile='osaa-admin' AND p_verification_route='/manage/osaa')) THEN
    RAISE EXCEPTION 'registered browser verification profile and route required';
  END IF;
  SELECT * INTO existing FROM console.module_operation WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    SELECT * INTO created FROM osaa.engineering_remediation_request WHERE operation_id=existing.operation_id;
    IF NOT FOUND OR existing.actor_id<>p_agent_actor_id OR created.operator_id<>p_operator_id
       OR existing.target_fingerprint<>p_approval_binding_digest OR created.patch_digest<>p_patch_digest THEN
      RAISE EXCEPTION 'idempotency key is bound to a different Repair Runner work unit';
    END IF;
    RETURN created;
  END IF;
  computed_digest:='sha256:'||encode(extensions.digest(convert_to(p_patch_text,'UTF8'),'sha256'),'hex');
  IF computed_digest<>p_patch_digest OR octet_length(p_patch_text) NOT BETWEEN 1 AND 262144 THEN
    RAISE EXCEPTION 'patch artifact digest or byte length is invalid';
  END IF;
  IF p_patch_text~*'-----BEGIN [A-Z ]*PRIVATE KEY-----'
     OR p_patch_text~*'Bearer[[:space:]]+[A-Za-z0-9._~+/-]{12,}'
     OR p_patch_text~*'(password|passwd|api[_-]?key|client[_-]?secret)[[:space:]]*[:=][[:space:]]*[^[:space:]$<{]{8,}' THEN
    RAISE EXCEPTION 'patch artifact contains credential-like material';
  END IF;
  IF cardinality(p_changed_paths)<1 OR EXISTS(
    SELECT 1 FROM unnest(p_changed_paths) path WHERE path LIKE '/%' OR path LIKE '%..%'
      OR NOT path=ANY(p_allowed_paths) AND NOT EXISTS(
        SELECT 1 FROM unnest(p_allowed_paths) prefix WHERE path LIKE rtrim(prefix,'/')||'/%'
      )
  ) THEN RAISE EXCEPTION 'patch artifact changed path is outside approval'; END IF;
  SELECT * INTO created FROM osaa.propose_engineering_remediation(
    p_remediation_request_id,p_idempotency_key,p_operator_id,p_assurance,p_auth_session_id,p_authz_revision,
    p_assessment_id,p_incident_id,p_repository,p_base_revision,p_allowed_paths,p_patch_digest,p_reason,
    p_risk_level,p_affected_components,p_affected_images,p_required_tests,p_release_scope,
    p_full_release_justification,p_target_channel,p_build_authority,p_rollback_revision,
    p_rollback_image_digests,p_approval_binding_digest,p_approval_expires_at
  );
  INSERT INTO osaa.remediation_patch_artifact(
    remediation_request_id,patch_digest,patch_text,byte_length,changed_paths,evidence_digest,created_by
  ) VALUES(
    created.remediation_request_id,p_patch_digest,p_patch_text,octet_length(p_patch_text),p_changed_paths,
    p_patch_evidence_digest,p_operator_id
  );
  UPDATE osaa.engineering_remediation_request SET
    operator_id=p_operator_id,approval_mode=p_approval_mode,
    verification_profile=p_verification_profile,verification_route=p_verification_route
  WHERE remediation_request_id=created.remediation_request_id RETURNING * INTO created;
  UPDATE console.module_operation SET actor_id=p_agent_actor_id,
    descriptor_revision='engineering-remediation-v3',
    precondition=precondition||jsonb_build_object('operatorId',p_operator_id,'approvalMode',p_approval_mode,
      'verificationProfile',p_verification_profile,'verificationRoute',p_verification_route),
    expected_postcondition=expected_postcondition||jsonb_build_object(
      'repositoryWrite',true,'build',true,'publish',true,'deploy',true,'componentOnly',true
    ) WHERE operation_id=created.operation_id;
  INSERT INTO osaa.engineering_remediation_event(remediation_request_id,sequence,from_stage,to_stage,evidence,evidence_digest)
  VALUES(created.remediation_request_id,1,NULL,'proposed',
    jsonb_build_object('patchDigest',p_patch_digest,'changedPaths',p_changed_paths,'approvalMode',p_approval_mode),
    p_patch_evidence_digest);
  RETURN created;
END $$;

-- One supervised edge work-unit approval covers patch, registered tests,
-- component publication, exact-digest deploy, verification and rollback.
CREATE OR REPLACE FUNCTION osaa.advance_engineering_remediation(
  p_remediation_request_id uuid,p_worker text,p_claim_epoch bigint,p_expected_stage text,p_next_stage text,
  p_evidence jsonb,p_evidence_digest text
) RETURNS osaa.engineering_remediation_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,osaa,console AS $$
DECLARE request osaa.engineering_remediation_request%ROWTYPE; seq bigint; valid boolean;
BEGIN
  SELECT * INTO request FROM osaa.engineering_remediation_request
    WHERE remediation_request_id=p_remediation_request_id FOR UPDATE;
  IF NOT FOUND OR request.claim_owner IS DISTINCT FROM p_worker OR request.claim_epoch IS DISTINCT FROM p_claim_epoch
     OR request.lease_expires_at<=clock_timestamp() OR request.stage<>p_expected_stage THEN
    RAISE EXCEPTION 'Engineering Remediation claim or expected stage was lost';
  END IF;
  valid:=CASE request.stage
    WHEN 'approved' THEN p_next_stage IN ('sandboxed','failed','cancelled')
    WHEN 'sandboxed' THEN p_next_stage IN ('patched','failed')
    WHEN 'patched' THEN p_next_stage IN ('testing','failed')
    WHEN 'testing' THEN p_next_stage IN ('test_failed','ready_to_commit','failed')
    WHEN 'ready_to_commit' THEN p_next_stage IN ('committed','failed')
    WHEN 'committed' THEN p_next_stage IN ('building','failed')
    WHEN 'building' THEN p_next_stage IN ('build_failed','built','failed')
    WHEN 'built' THEN p_next_stage='awaiting_deploy_approval'
      OR (request.approval_mode='local-edge-supervised' AND p_next_stage='deploying')
    WHEN 'deploying' THEN p_next_stage IN ('verifying','rolling_back','failed')
    WHEN 'verifying' THEN p_next_stage IN ('succeeded','inconclusive','rolling_back','failed')
    WHEN 'rolling_back' THEN p_next_stage IN ('rolled_back','failed')
    ELSE false END;
  IF NOT valid THEN RAISE EXCEPTION 'invalid Engineering Remediation stage transition % -> %',request.stage,p_next_stage; END IF;
  SELECT coalesce(max(sequence),0)+1 INTO seq FROM osaa.engineering_remediation_event
    WHERE remediation_request_id=p_remediation_request_id;
  INSERT INTO osaa.engineering_remediation_event(remediation_request_id,sequence,from_stage,to_stage,worker_id,evidence,evidence_digest)
    VALUES(p_remediation_request_id,seq,request.stage,p_next_stage,p_worker,coalesce(p_evidence,'{}'),p_evidence_digest);
  IF p_next_stage IN ('awaiting_deploy_approval','deploying')
     AND coalesce(p_evidence->>'deploymentBindingDigest','')!~'^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'exact deployment binding evidence is required';
  END IF;
  UPDATE osaa.engineering_remediation_request SET stage=p_next_stage,
    deployment_binding_digest=CASE WHEN p_next_stage IN ('awaiting_deploy_approval','deploying')
      THEN p_evidence->>'deploymentBindingDigest' ELSE deployment_binding_digest END,
    claim_owner=CASE WHEN p_next_stage IN ('test_failed','build_failed','awaiting_deploy_approval','succeeded','inconclusive','rolled_back','failed','cancelled') THEN NULL ELSE claim_owner END,
    claim_epoch=CASE WHEN p_next_stage IN ('test_failed','build_failed','awaiting_deploy_approval','succeeded','inconclusive','rolled_back','failed','cancelled') THEN NULL ELSE claim_epoch END,
    lease_expires_at=CASE WHEN p_next_stage IN ('test_failed','build_failed','awaiting_deploy_approval','succeeded','inconclusive','rolled_back','failed','cancelled') THEN NULL ELSE lease_expires_at END,
    last_error_code=CASE WHEN p_next_stage IN ('build_failed','test_failed','inconclusive','failed') THEN p_evidence->>'code' ELSE last_error_code END,
    updated_at=clock_timestamp() WHERE remediation_request_id=p_remediation_request_id RETURNING * INTO request;
  IF p_next_stage='deploying' THEN
    UPDATE console.module_operation SET phase='Running',execution_state='executing',updated_at=clock_timestamp()
    WHERE operation_id=request.operation_id;
  ELSIF p_next_stage IN ('test_failed','build_failed','succeeded','inconclusive','rolled_back','failed','cancelled') THEN
    UPDATE console.module_operation SET
      phase=CASE p_next_stage WHEN 'succeeded' THEN 'Succeeded' WHEN 'inconclusive' THEN 'Inconclusive'
        WHEN 'rolled_back' THEN 'RolledBack' WHEN 'cancelled' THEN 'Cancelled' ELSE 'Failed' END,
      execution_state=CASE p_next_stage WHEN 'succeeded' THEN 'complete' WHEN 'inconclusive' THEN 'complete'
        WHEN 'rolled_back' THEN 'rolled_back' WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END,
      verification_state=CASE p_next_stage WHEN 'succeeded' THEN 'succeeded' WHEN 'inconclusive' THEN 'inconclusive'
        WHEN 'rolled_back' THEN 'failed' WHEN 'cancelled' THEN 'not_required' ELSE 'failed' END,
      updated_at=clock_timestamp() WHERE operation_id=request.operation_id;
  END IF;
  RETURN request;
END $$;

ALTER TABLE osaa.engineering_remediation_runner ENABLE ROW LEVEL SECURITY;
ALTER TABLE osaa.engineering_browser_verification ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS engineering_browser_verification_append_only ON osaa.engineering_browser_verification;
CREATE TRIGGER engineering_browser_verification_append_only BEFORE UPDATE OR DELETE ON osaa.engineering_browser_verification
  FOR EACH ROW EXECUTE FUNCTION osaa.reject_evidence_mutation();
ALTER TABLE osaa.engineering_browser_verification ENABLE ALWAYS TRIGGER engineering_browser_verification_append_only;
REVOKE ALL ON osaa.engineering_remediation_runner,osaa.engineering_browser_verification
  FROM PUBLIC,anon,authenticated,service_role,opensphere_osaa_observer,opensphere_osaa_api,opensphere_osaa_gateway;
GRANT SELECT,INSERT,UPDATE ON osaa.engineering_remediation_runner TO opensphere_console_backend;
GRANT SELECT,INSERT ON osaa.engineering_browser_verification TO opensphere_console_backend;
CREATE POLICY backend_engineering_runner ON osaa.engineering_remediation_runner FOR ALL
  TO opensphere_console_backend USING(true) WITH CHECK(true);
CREATE POLICY backend_engineering_browser_verification ON osaa.engineering_browser_verification FOR ALL
  TO opensphere_console_backend USING(true) WITH CHECK(true);

REVOKE ALL ON FUNCTION osaa.register_engineering_remediation_runner(text,bigint,text,text,text),
  osaa.engineering_remediation_runner_ready(text),
  osaa.propose_engineering_remediation_v3(uuid,text,uuid,uuid,text,uuid,text,uuid,uuid,text,text,text[],text,text,text[],text,text,text,text[],text[],text[],text,text,text,text,text,text[],text,text,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role,opensphere_osaa_observer,opensphere_osaa_api,opensphere_osaa_gateway;
GRANT EXECUTE ON FUNCTION osaa.register_engineering_remediation_runner(text,bigint,text,text,text),
  osaa.engineering_remediation_runner_ready(text),
  osaa.propose_engineering_remediation_v3(uuid,text,uuid,uuid,text,uuid,text,uuid,uuid,text,text,text[],text,text,text[],text,text,text,text[],text[],text[],text,text,text,text,text,text[],text,text,text,text,timestamptz)
  TO opensphere_console_backend;

COMMENT ON TABLE osaa.engineering_remediation_runner IS 'Short-lived Windows Docker Desktop Repair Runner presence; never a host command queue.';
COMMENT ON FUNCTION osaa.propose_engineering_remediation_v3(uuid,text,uuid,uuid,text,uuid,text,uuid,uuid,text,text,text[],text,text,text[],text,text,text,text[],text[],text[],text,text,text,text,text,text[],text,text,text,text,timestamptz)
  IS 'OSAA-requested, human-approved, exact patch-bound local edge component work unit.';
