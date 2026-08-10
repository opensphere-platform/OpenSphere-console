\set ON_ERROR_STOP on

-- Patch-bound Engineering Remediation execution remains default-off.  This
-- migration provides the durable, scoped approval and worker fencing substrate;
-- it does not grant repository, build, registry, or cluster credentials.

ALTER TABLE console.module_operation_approval
  ADD COLUMN IF NOT EXISTS approval_scope text NOT NULL DEFAULT 'operation',
  ADD COLUMN IF NOT EXISTS binding_digest text,
  ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz;

UPDATE console.module_operation_approval a SET binding_digest=coalesce(
  (SELECT coalesce(o.descriptor_digest,o.target_fingerprint) FROM console.module_operation o WHERE o.operation_id=a.operation_id),
  a.approval_digest
) WHERE binding_digest IS NULL;
ALTER TABLE console.module_operation_approval ALTER COLUMN binding_digest SET NOT NULL;
ALTER TABLE console.module_operation_approval DROP CONSTRAINT IF EXISTS module_operation_approval_scope_check;
ALTER TABLE console.module_operation_approval ADD CONSTRAINT module_operation_approval_scope_check
  CHECK (approval_scope IN ('operation','source_patch','deployment'));
ALTER TABLE console.module_operation_approval DROP CONSTRAINT IF EXISTS module_operation_approval_binding_digest_check;
ALTER TABLE console.module_operation_approval ADD CONSTRAINT module_operation_approval_binding_digest_check
  CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE console.module_operation_approval DROP CONSTRAINT IF EXISTS module_operation_approval_pkey;
ALTER TABLE console.module_operation_approval ADD PRIMARY KEY(operation_id,approver_id,approval_scope);

CREATE OR REPLACE FUNCTION console.bind_module_operation_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
BEGIN
  IF NEW.binding_digest IS NULL THEN
    SELECT coalesce(descriptor_digest,target_fingerprint,NEW.approval_digest) INTO NEW.binding_digest
      FROM console.module_operation WHERE operation_id=NEW.operation_id;
    NEW.binding_digest:=coalesce(NEW.binding_digest,NEW.approval_digest);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS module_operation_approval_binding ON console.module_operation_approval;
CREATE TRIGGER module_operation_approval_binding BEFORE INSERT OR UPDATE ON console.module_operation_approval
  FOR EACH ROW EXECUTE FUNCTION console.bind_module_operation_approval();

ALTER TABLE oaa.engineering_remediation_request
  ADD COLUMN IF NOT EXISTS deployment_binding_digest text
    CHECK (deployment_binding_digest IS NULL OR deployment_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS deployment_approval_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_owner text,
  ADD COLUMN IF NOT EXISTS claim_epoch bigint CHECK (claim_epoch IS NULL OR claim_epoch>0),
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
  ADD COLUMN IF NOT EXISTS last_error_code text;
ALTER TABLE oaa.engineering_remediation_request DROP CONSTRAINT IF EXISTS engineering_remediation_request_stage_check;
ALTER TABLE oaa.engineering_remediation_request ADD CONSTRAINT engineering_remediation_request_stage_check CHECK (stage IN (
  'proposed','awaiting_approval','approved','sandboxed','patched','testing','test_failed','ready_to_commit',
  'committed','building','build_failed','built','awaiting_deploy_approval','deploying','verifying','inconclusive',
  'succeeded','rolling_back','rolled_back','failed','cancelled'
));

ALTER TABLE oaa.build_evidence
  ADD COLUMN IF NOT EXISTS release_lock_digest text
    CHECK (release_lock_digest IS NULL OR release_lock_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE oaa.deployment_verification
  ADD COLUMN IF NOT EXISTS expected_lock_digest text
    CHECK (expected_lock_digest IS NULL OR expected_lock_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE oaa.deployment_verification ALTER COLUMN lock_digest DROP NOT NULL;
ALTER TABLE oaa.deployment_verification DROP CONSTRAINT IF EXISTS deployment_verification_exact_lock_check;
ALTER TABLE oaa.deployment_verification ADD CONSTRAINT deployment_verification_exact_lock_check CHECK (
  status<>'succeeded' OR (expected_lock_digest IS NOT NULL AND lock_digest IS NOT NULL AND expected_lock_digest=lock_digest)
);

CREATE OR REPLACE FUNCTION oaa.validate_build_evidence_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa AS $$
DECLARE request oaa.engineering_remediation_request%ROWTYPE;
BEGIN
  SELECT * INTO request FROM oaa.engineering_remediation_request
    WHERE remediation_request_id=NEW.remediation_request_id FOR SHARE;
  IF NOT FOUND OR request.patch_digest<>NEW.patch_digest OR request.build_authority<>NEW.build_authority THEN
    RAISE EXCEPTION 'build evidence is not bound to the approved patch and authority';
  END IF;
  IF request.stage NOT IN ('approved','sandboxed','patched','testing','ready_to_commit','committed','building','built')
     OR request.approval_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'active patch-bound approval required before build evidence';
  END IF;
  IF NEW.release_lock_digest IS NULL THEN RAISE EXCEPTION 'exact release lock digest evidence required'; END IF;
  RETURN NEW;
END $$;

CREATE TABLE IF NOT EXISTS oaa.remediation_patch_artifact (
  remediation_request_id uuid PRIMARY KEY REFERENCES oaa.engineering_remediation_request(remediation_request_id) ON DELETE RESTRICT,
  patch_digest text NOT NULL CHECK (patch_digest ~ '^sha256:[0-9a-f]{64}$'),
  patch_text text NOT NULL CHECK (octet_length(patch_text) BETWEEN 1 AND 262144),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 262144),
  changed_paths text[] NOT NULL CHECK (cardinality(changed_paths)>0),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (byte_length=octet_length(patch_text))
);

CREATE TABLE IF NOT EXISTS oaa.engineering_remediation_event (
  remediation_request_id uuid NOT NULL REFERENCES oaa.engineering_remediation_request(remediation_request_id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence>0),
  from_stage text,
  to_stage text NOT NULL,
  worker_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(remediation_request_id,sequence)
);

CREATE OR REPLACE FUNCTION oaa.propose_engineering_remediation_v2(
  p_remediation_request_id uuid, p_idempotency_key text, p_actor_id uuid, p_assurance text,
  p_auth_session_id uuid, p_authz_revision text, p_assessment_id uuid, p_incident_id uuid,
  p_repository text, p_base_revision text, p_allowed_paths text[], p_patch_digest text,
  p_patch_text text, p_changed_paths text[], p_patch_evidence_digest text,
  p_reason text, p_risk_level text, p_affected_components text[], p_affected_images text[],
  p_required_tests text[], p_release_scope text, p_full_release_justification text,
  p_target_channel text, p_build_authority text, p_rollback_revision text,
  p_rollback_image_digests text[], p_approval_binding_digest text, p_approval_expires_at timestamptz
) RETURNS oaa.engineering_remediation_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa,console,public AS $$
DECLARE created oaa.engineering_remediation_request%ROWTYPE; computed_digest text;
BEGIN
  computed_digest:='sha256:'||encode(extensions.digest(convert_to(p_patch_text,'UTF8'),'sha256'),'hex');
  IF computed_digest<>p_patch_digest OR octet_length(p_patch_text) NOT BETWEEN 1 AND 262144 THEN
    RAISE EXCEPTION 'patch artifact digest or byte length is invalid';
  END IF;
  IF p_patch_text~*'-----BEGIN [A-Z ]*PRIVATE KEY-----'
     OR p_patch_text~*'Bearer[[:space:]]+[A-Za-z0-9._~+/-]{12,}'
     OR p_patch_text~*'(password|passwd|api[_-]?key|client[_-]?secret)[[:space:]]*[:=][[:space:]]*[^[:space:]$<{]{8,}' THEN
    RAISE EXCEPTION 'patch artifact contains credential-like material';
  END IF;
  IF cardinality(p_changed_paths)<1 OR EXISTS (
    SELECT 1 FROM unnest(p_changed_paths) path
    WHERE path LIKE '/%' OR path LIKE '%..%' OR NOT path=ANY(p_allowed_paths) AND NOT EXISTS (
      SELECT 1 FROM unnest(p_allowed_paths) prefix WHERE path LIKE rtrim(prefix,'/')||'/%'
    )
  ) THEN RAISE EXCEPTION 'patch artifact changed path is outside approval'; END IF;

  SELECT * INTO created FROM oaa.propose_engineering_remediation(
    p_remediation_request_id,p_idempotency_key,p_actor_id,p_assurance,p_auth_session_id,p_authz_revision,
    p_assessment_id,p_incident_id,p_repository,p_base_revision,p_allowed_paths,p_patch_digest,p_reason,
    p_risk_level,p_affected_components,p_affected_images,p_required_tests,p_release_scope,
    p_full_release_justification,p_target_channel,p_build_authority,p_rollback_revision,
    p_rollback_image_digests,p_approval_binding_digest,p_approval_expires_at
  );
  INSERT INTO oaa.remediation_patch_artifact(
    remediation_request_id,patch_digest,patch_text,byte_length,changed_paths,evidence_digest,created_by
  ) VALUES(
    created.remediation_request_id,p_patch_digest,p_patch_text,octet_length(p_patch_text),p_changed_paths,
    p_patch_evidence_digest,p_actor_id
  ) ON CONFLICT(remediation_request_id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM oaa.remediation_patch_artifact
    WHERE remediation_request_id=created.remediation_request_id AND patch_digest=p_patch_digest) THEN
    RAISE EXCEPTION 'idempotent proposal is bound to a different patch artifact';
  END IF;
  INSERT INTO oaa.engineering_remediation_event(remediation_request_id,sequence,from_stage,to_stage,evidence,evidence_digest)
    VALUES(created.remediation_request_id,1,NULL,'proposed',
      jsonb_build_object('patchDigest',p_patch_digest,'changedPaths',p_changed_paths),p_patch_evidence_digest)
    ON CONFLICT DO NOTHING;
  RETURN created;
END $$;

CREATE OR REPLACE FUNCTION oaa.record_engineering_remediation_approval(
  p_remediation_request_id uuid, p_scope text, p_approver_id uuid, p_assurance text,
  p_binding_digest text, p_approval_digest text, p_expires_at timestamptz
) RETURNS oaa.engineering_remediation_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa,console AS $$
DECLARE request oaa.engineering_remediation_request%ROWTYPE; op console.module_operation%ROWTYPE;
  expected text; required integer; actual integer; prior text; seq bigint;
BEGIN
  SELECT * INTO request FROM oaa.engineering_remediation_request
    WHERE remediation_request_id=p_remediation_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engineering Remediation request not found'; END IF;
  SELECT * INTO op FROM console.module_operation WHERE operation_id=request.operation_id FOR UPDATE;
  IF p_assurance<>'aal2' OR p_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'active AAL2 approval required'; END IF;
  IF p_scope='source_patch' THEN
    expected:=request.approval_binding_digest;
    IF request.stage NOT IN ('proposed','awaiting_approval') OR p_expires_at>request.approval_expires_at THEN
      RAISE EXCEPTION 'source patch is not awaiting a valid approval';
    END IF;
  ELSIF p_scope='deployment' THEN
    expected:=request.deployment_binding_digest;
    IF request.stage<>'awaiting_deploy_approval' OR expected IS NULL THEN
      RAISE EXCEPTION 'exact deployment is not awaiting approval';
    END IF;
    request.deployment_approval_expires_at:=p_expires_at;
  ELSE RAISE EXCEPTION 'unsupported Engineering Remediation approval scope'; END IF;
  IF p_binding_digest IS DISTINCT FROM expected THEN RAISE EXCEPTION 'approval binding changed'; END IF;
  INSERT INTO console.module_operation_approval(
    operation_id,approver_id,assurance,approval_digest,approval_scope,binding_digest,approval_expires_at,revoked_at
  ) VALUES(op.operation_id,p_approver_id,p_assurance,p_approval_digest,p_scope,p_binding_digest,p_expires_at,NULL)
  ON CONFLICT(operation_id,approver_id,approval_scope) DO UPDATE SET
    assurance=EXCLUDED.assurance,approval_digest=EXCLUDED.approval_digest,binding_digest=EXCLUDED.binding_digest,
    approval_expires_at=EXCLUDED.approval_expires_at,approved_at=clock_timestamp(),revoked_at=NULL;
  required:=CASE WHEN request.risk_level='R3' THEN 2 ELSE 1 END;
  SELECT count(DISTINCT approver_id) INTO actual FROM console.module_operation_approval
    WHERE operation_id=op.operation_id AND approval_scope=p_scope AND binding_digest=p_binding_digest
      AND assurance='aal2' AND revoked_at IS NULL AND approval_expires_at>clock_timestamp();
  IF actual>=required THEN
    prior:=request.stage;
    request.stage:=CASE WHEN p_scope='source_patch' THEN 'approved' ELSE 'deploying' END;
    UPDATE oaa.engineering_remediation_request SET stage=request.stage,
      deployment_approval_expires_at=CASE WHEN p_scope='deployment' THEN p_expires_at ELSE deployment_approval_expires_at END,
      updated_at=clock_timestamp() WHERE remediation_request_id=request.remediation_request_id RETURNING * INTO request;
    UPDATE console.module_operation SET phase=CASE WHEN p_scope='source_patch' THEN 'Queued' ELSE 'Running' END,
      execution_state=CASE WHEN p_scope='source_patch' THEN 'accepted' ELSE 'executing' END,
      updated_at=clock_timestamp() WHERE operation_id=op.operation_id;
    SELECT coalesce(max(sequence),0)+1 INTO seq FROM oaa.engineering_remediation_event WHERE remediation_request_id=request.remediation_request_id;
    INSERT INTO oaa.engineering_remediation_event(remediation_request_id,sequence,from_stage,to_stage,evidence,evidence_digest)
      VALUES(request.remediation_request_id,seq,prior,request.stage,
        jsonb_build_object('scope',p_scope,'approverCount',actual,'required',required),p_approval_digest);
  END IF;
  RETURN request;
END $$;

CREATE OR REPLACE FUNCTION oaa.claim_engineering_remediation(
  p_worker text,p_claim_epoch bigint,p_limit integer DEFAULT 5
) RETURNS SETOF oaa.engineering_remediation_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa AS $$
BEGIN
  IF length(btrim(coalesce(p_worker,'')))<3 OR p_claim_epoch<1 THEN RAISE EXCEPTION 'worker and epoch required'; END IF;
  RETURN QUERY WITH candidates AS (
    SELECT remediation_request_id FROM oaa.engineering_remediation_request
    WHERE stage IN ('approved','deploying')
      AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp())
    ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,20))
  ) UPDATE oaa.engineering_remediation_request r SET
    claim_owner=p_worker,claim_epoch=p_claim_epoch,lease_expires_at=clock_timestamp()+interval '30 seconds',
    heartbeat_at=clock_timestamp(),attempt=attempt+1,updated_at=clock_timestamp()
  FROM candidates c WHERE r.remediation_request_id=c.remediation_request_id RETURNING r.*;
END $$;

CREATE OR REPLACE FUNCTION oaa.heartbeat_engineering_remediation(
  p_remediation_request_id uuid,p_worker text,p_claim_epoch bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa AS $$
DECLARE affected integer;
BEGIN
  UPDATE oaa.engineering_remediation_request SET
    lease_expires_at=clock_timestamp()+interval '30 seconds',heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE remediation_request_id=p_remediation_request_id AND claim_owner=p_worker AND claim_epoch=p_claim_epoch
    AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected=1;
END $$;

CREATE OR REPLACE FUNCTION oaa.advance_engineering_remediation(
  p_remediation_request_id uuid,p_worker text,p_claim_epoch bigint,p_expected_stage text,p_next_stage text,
  p_evidence jsonb,p_evidence_digest text
) RETURNS oaa.engineering_remediation_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa,console AS $$
DECLARE request oaa.engineering_remediation_request%ROWTYPE; seq bigint; valid boolean;
BEGIN
  SELECT * INTO request FROM oaa.engineering_remediation_request
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
    WHEN 'deploying' THEN p_next_stage IN ('verifying','rolling_back','failed')
    WHEN 'verifying' THEN p_next_stage IN ('succeeded','inconclusive','rolling_back','failed')
    WHEN 'rolling_back' THEN p_next_stage IN ('rolled_back','failed')
    ELSE false END;
  IF NOT valid THEN RAISE EXCEPTION 'invalid Engineering Remediation stage transition % -> %',request.stage,p_next_stage; END IF;
  SELECT coalesce(max(sequence),0)+1 INTO seq FROM oaa.engineering_remediation_event
    WHERE remediation_request_id=p_remediation_request_id;
  INSERT INTO oaa.engineering_remediation_event(remediation_request_id,sequence,from_stage,to_stage,worker_id,evidence,evidence_digest)
    VALUES(p_remediation_request_id,seq,request.stage,p_next_stage,p_worker,coalesce(p_evidence,'{}'),p_evidence_digest);
  IF p_next_stage='awaiting_deploy_approval' AND coalesce(p_evidence->>'deploymentBindingDigest','')!~'^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'exact deployment approval binding is required';
  END IF;
  UPDATE oaa.engineering_remediation_request SET stage=p_next_stage,
    deployment_binding_digest=CASE WHEN p_next_stage='awaiting_deploy_approval'
      THEN p_evidence->>'deploymentBindingDigest' ELSE deployment_binding_digest END,
    claim_owner=CASE WHEN p_next_stage IN ('test_failed','build_failed','awaiting_deploy_approval','succeeded','inconclusive','rolled_back','failed','cancelled') THEN NULL ELSE claim_owner END,
    claim_epoch=CASE WHEN p_next_stage IN ('test_failed','build_failed','awaiting_deploy_approval','succeeded','inconclusive','rolled_back','failed','cancelled') THEN NULL ELSE claim_epoch END,
    lease_expires_at=CASE WHEN p_next_stage IN ('test_failed','build_failed','awaiting_deploy_approval','succeeded','inconclusive','rolled_back','failed','cancelled') THEN NULL ELSE lease_expires_at END,
    last_error_code=CASE WHEN p_next_stage IN ('build_failed','test_failed','inconclusive','failed') THEN p_evidence->>'code' ELSE last_error_code END,
    updated_at=clock_timestamp() WHERE remediation_request_id=p_remediation_request_id RETURNING * INTO request;
  IF p_next_stage IN ('test_failed','build_failed','succeeded','inconclusive','rolled_back','failed','cancelled') THEN
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

CREATE OR REPLACE FUNCTION oaa.record_engineering_build_evidence(
  p_remediation_request_id uuid,p_worker text,p_claim_epoch bigint,p_source_revision text,p_patch_digest text,
  p_test_evidence jsonb,p_sbom_digest text,p_provenance_digest text,p_signature_digest text,
  p_image_digests text[],p_build_authority text,p_release_lock_digest text
) RETURNS oaa.build_evidence
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa AS $$
DECLARE request oaa.engineering_remediation_request%ROWTYPE; created oaa.build_evidence%ROWTYPE;
BEGIN
  SELECT * INTO request FROM oaa.engineering_remediation_request
    WHERE remediation_request_id=p_remediation_request_id FOR UPDATE;
  IF NOT FOUND OR request.claim_owner IS DISTINCT FROM p_worker OR request.claim_epoch IS DISTINCT FROM p_claim_epoch
     OR request.lease_expires_at<=clock_timestamp() OR request.stage<>'building' THEN
    RAISE EXCEPTION 'Engineering Remediation build evidence claim was lost';
  END IF;
  INSERT INTO oaa.build_evidence(
    remediation_request_id,source_revision,patch_digest,test_evidence,sbom_digest,provenance_digest,
    signature_digest,image_digests,build_authority,release_lock_digest
  ) VALUES(
    p_remediation_request_id,p_source_revision,p_patch_digest,p_test_evidence,p_sbom_digest,p_provenance_digest,
    p_signature_digest,p_image_digests,p_build_authority,p_release_lock_digest
  ) RETURNING * INTO created;
  RETURN created;
END $$;

CREATE OR REPLACE FUNCTION oaa.record_engineering_deployment_verification(
  p_remediation_request_id uuid,p_worker text,p_claim_epoch bigint,p_operation_id uuid,
  p_expected_image_digests text[],p_observed_image_digests text[],p_expected_lock_digest text,p_lock_digest text,
  p_api_postcondition jsonb,p_ui_postcondition jsonb,p_rollback_verified boolean,p_status text
) RETURNS oaa.deployment_verification
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa AS $$
DECLARE request oaa.engineering_remediation_request%ROWTYPE; created oaa.deployment_verification%ROWTYPE;
BEGIN
  SELECT * INTO request FROM oaa.engineering_remediation_request
    WHERE remediation_request_id=p_remediation_request_id FOR UPDATE;
  IF NOT FOUND OR request.operation_id IS DISTINCT FROM p_operation_id
     OR request.claim_owner IS DISTINCT FROM p_worker OR request.claim_epoch IS DISTINCT FROM p_claim_epoch
     OR request.lease_expires_at<=clock_timestamp() OR request.stage NOT IN ('verifying','rolling_back') THEN
    RAISE EXCEPTION 'Engineering Remediation deployment verification claim was lost';
  END IF;
  INSERT INTO oaa.deployment_verification(
    remediation_request_id,operation_id,expected_image_digests,observed_image_digests,
    expected_lock_digest,lock_digest,api_postcondition,ui_postcondition,rollback_verified,status
  ) VALUES(
    p_remediation_request_id,p_operation_id,p_expected_image_digests,p_observed_image_digests,
    p_expected_lock_digest,p_lock_digest,p_api_postcondition,p_ui_postcondition,p_rollback_verified,p_status
  ) RETURNING * INTO created;
  RETURN created;
END $$;

DROP TRIGGER IF EXISTS remediation_patch_artifact_append_only ON oaa.remediation_patch_artifact;
CREATE TRIGGER remediation_patch_artifact_append_only BEFORE UPDATE OR DELETE ON oaa.remediation_patch_artifact
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.remediation_patch_artifact ENABLE ALWAYS TRIGGER remediation_patch_artifact_append_only;
DROP TRIGGER IF EXISTS engineering_remediation_event_append_only ON oaa.engineering_remediation_event;
CREATE TRIGGER engineering_remediation_event_append_only BEFORE UPDATE OR DELETE ON oaa.engineering_remediation_event
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.engineering_remediation_event ENABLE ALWAYS TRIGGER engineering_remediation_event_append_only;

ALTER TABLE oaa.remediation_patch_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.engineering_remediation_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON oaa.remediation_patch_artifact,oaa.engineering_remediation_event
  FROM PUBLIC,anon,authenticated,service_role,opensphere_oaa_observer,opensphere_oaa_api,opensphere_oaa_gateway;
GRANT SELECT,INSERT ON oaa.remediation_patch_artifact,oaa.engineering_remediation_event TO opensphere_console_backend;
GRANT SELECT ON oaa.engineering_remediation_event TO opensphere_oaa_api,opensphere_oaa_gateway;
CREATE POLICY backend_patch_artifact ON oaa.remediation_patch_artifact FOR ALL TO opensphere_console_backend USING(true) WITH CHECK(true);
CREATE POLICY backend_remediation_event ON oaa.engineering_remediation_event FOR ALL TO opensphere_console_backend USING(true) WITH CHECK(true);
CREATE POLICY api_remediation_event ON oaa.engineering_remediation_event FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);

REVOKE ALL ON FUNCTION oaa.propose_engineering_remediation_v2(uuid,text,uuid,text,uuid,text,uuid,uuid,text,text,text[],text,text,text[],text,text,text,text[],text[],text[],text,text,text,text,text,text[],text,timestamptz),
  oaa.record_engineering_remediation_approval(uuid,text,uuid,text,text,text,timestamptz),
  oaa.claim_engineering_remediation(text,bigint,integer),
  oaa.heartbeat_engineering_remediation(uuid,text,bigint),
  oaa.advance_engineering_remediation(uuid,text,bigint,text,text,jsonb,text),
  oaa.record_engineering_build_evidence(uuid,text,bigint,text,text,jsonb,text,text,text,text[],text,text),
  oaa.record_engineering_deployment_verification(uuid,text,bigint,uuid,text[],text[],text,text,jsonb,jsonb,boolean,text)
  FROM PUBLIC,anon,authenticated,service_role,opensphere_oaa_observer,opensphere_oaa_api,opensphere_oaa_gateway;
GRANT EXECUTE ON FUNCTION oaa.propose_engineering_remediation_v2(uuid,text,uuid,text,uuid,text,uuid,uuid,text,text,text[],text,text,text[],text,text,text,text[],text[],text[],text,text,text,text,text,text[],text,timestamptz),
  oaa.record_engineering_remediation_approval(uuid,text,uuid,text,text,text,timestamptz),
  oaa.claim_engineering_remediation(text,bigint,integer),
  oaa.heartbeat_engineering_remediation(uuid,text,bigint),
  oaa.advance_engineering_remediation(uuid,text,bigint,text,text,jsonb,text),
  oaa.record_engineering_build_evidence(uuid,text,bigint,text,text,jsonb,text,text,text,text[],text,text),
  oaa.record_engineering_deployment_verification(uuid,text,bigint,uuid,text[],text[],text,text,jsonb,jsonb,boolean,text)
  TO opensphere_console_backend;

COMMENT ON TABLE oaa.remediation_patch_artifact IS 'Append-only, exact-digest unified diff; never a command or credential carrier.';
COMMENT ON FUNCTION oaa.claim_engineering_remediation(text,bigint,integer) IS 'Dedicated fenced worker lane, isolated from generic owner-facade operations.';
