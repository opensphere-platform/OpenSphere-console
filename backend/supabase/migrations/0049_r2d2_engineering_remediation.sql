\set ON_ERROR_STOP on

-- Metacognitive self-model and Engineering Remediation evidence. These are
-- correlated projections/receipts; Incident and console.module_operation stay
-- the durable incident and execution ledgers.

CREATE TABLE IF NOT EXISTS oaa.self_model (
  cluster_id text PRIMARY KEY,
  observer_state text NOT NULL CHECK (observer_state IN ('disabled','starting','leader','standby','degraded','unavailable')),
  graph_state text NOT NULL CHECK (graph_state IN ('disabled','unknown','partial','fresh','stale','conflicting')),
  incident_state text NOT NULL CHECK (incident_state IN ('disabled','ready','degraded','unavailable')),
  operation_state text NOT NULL CHECK (operation_state IN ('disabled','ready','degraded','unavailable')),
  remediation_state text NOT NULL CHECK (remediation_state IN ('disabled','proposal-only','ready','degraded','unavailable')),
  coverage numeric(5,4) NOT NULL DEFAULT 0 CHECK (coverage BETWEEN 0 AND 1),
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blockers) = 'array'),
  capability_revision text NOT NULL,
  observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS oaa.mismatch (
  mismatch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid REFERENCES oaa.incident(incident_id) ON DELETE RESTRICT,
  cluster_id text NOT NULL,
  subject_node_id text NOT NULL,
  mismatch_type text NOT NULL,
  epistemic_state text NOT NULL CHECK (epistemic_state IN ('known','unknown','stale','conflicting','inferred','unobservable')),
  expected_digest text NOT NULL CHECK (expected_digest ~ '^sha256:[0-9a-f]{64}$'),
  actual_digest text NOT NULL CHECK (actual_digest ~ '^sha256:[0-9a-f]{64}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS mismatch_active_subject_type_idx
  ON oaa.mismatch(cluster_id,subject_node_id,mismatch_type)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS oaa.remediation_assessment (
  assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mismatch_id uuid NOT NULL REFERENCES oaa.mismatch(mismatch_id) ON DELETE RESTRICT,
  incident_id uuid REFERENCES oaa.incident(incident_id) ON DELETE RESTRICT,
  minimum_ladder_step integer NOT NULL CHECK (minimum_ladder_step BETWEEN 0 AND 6),
  lower_steps jsonb NOT NULL CHECK (jsonb_typeof(lower_steps) = 'array'),
  engineering_required boolean NOT NULL,
  rationale text NOT NULL,
  policy_revision text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS oaa.engineering_remediation_request (
  remediation_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES oaa.remediation_assessment(assessment_id) ON DELETE RESTRICT,
  incident_id uuid REFERENCES oaa.incident(incident_id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL REFERENCES console.module_operation(operation_id) ON DELETE RESTRICT,
  repository text NOT NULL CHECK (repository ~ '^https://[^/]+/[^/]+/[^/]+(?:\.git)?$'),
  base_revision text NOT NULL CHECK (base_revision ~ '^[0-9a-f]{40}$'),
  allowed_paths text[] NOT NULL CHECK (cardinality(allowed_paths) > 0),
  patch_digest text NOT NULL CHECK (patch_digest ~ '^sha256:[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 2000),
  risk_level text NOT NULL CHECK (risk_level IN ('R2','R3')),
  affected_components text[] NOT NULL,
  affected_images text[] NOT NULL,
  required_tests text[] NOT NULL CHECK (cardinality(required_tests) > 0),
  release_scope text NOT NULL CHECK (release_scope IN ('component','integrated')),
  full_release_justification text,
  target_channel text NOT NULL CHECK (target_channel IN ('edge','candidate','stable','ga')),
  build_authority text NOT NULL CHECK (build_authority IN ('localhost','github-actions')),
  rollback_revision text NOT NULL CHECK (rollback_revision ~ '^[0-9a-f]{40}$'),
  rollback_image_digests text[] NOT NULL,
  approval_binding_digest text NOT NULL CHECK (approval_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  approval_expires_at timestamptz NOT NULL,
  stage text NOT NULL DEFAULT 'proposed' CHECK (stage IN (
    'proposed','awaiting_approval','approved','sandboxed','patched','testing','test_failed','ready_to_commit',
    'committed','building','build_failed','built','awaiting_deploy_approval','deploying','verifying','succeeded',
    'rolling_back','rolled_back','failed','cancelled'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (release_scope='component' OR length(btrim(coalesce(full_release_justification,'')))>=20),
  CHECK ((target_channel='edge' AND build_authority='localhost') OR
         (target_channel IN ('candidate','stable','ga') AND build_authority='github-actions'))
);

CREATE TABLE IF NOT EXISTS oaa.build_evidence (
  build_evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remediation_request_id uuid NOT NULL REFERENCES oaa.engineering_remediation_request(remediation_request_id) ON DELETE RESTRICT,
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  patch_digest text NOT NULL CHECK (patch_digest ~ '^sha256:[0-9a-f]{64}$'),
  test_evidence jsonb NOT NULL CHECK (jsonb_typeof(test_evidence)='object'),
  sbom_digest text NOT NULL CHECK (sbom_digest ~ '^sha256:[0-9a-f]{64}$'),
  provenance_digest text NOT NULL CHECK (provenance_digest ~ '^sha256:[0-9a-f]{64}$'),
  signature_digest text NOT NULL CHECK (signature_digest ~ '^sha256:[0-9a-f]{64}$'),
  image_digests text[] NOT NULL CHECK (cardinality(image_digests)>0),
  build_authority text NOT NULL CHECK (build_authority IN ('localhost','github-actions')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(remediation_request_id,patch_digest,source_revision)
);

CREATE TABLE IF NOT EXISTS oaa.deployment_verification (
  verification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remediation_request_id uuid NOT NULL REFERENCES oaa.engineering_remediation_request(remediation_request_id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL REFERENCES console.module_operation(operation_id) ON DELETE RESTRICT,
  expected_image_digests text[] NOT NULL,
  observed_image_digests text[] NOT NULL,
  lock_digest text NOT NULL CHECK (lock_digest ~ '^sha256:[0-9a-f]{64}$'),
  api_postcondition jsonb NOT NULL CHECK (jsonb_typeof(api_postcondition)='object'),
  ui_postcondition jsonb NOT NULL CHECK (jsonb_typeof(ui_postcondition)='object'),
  rollback_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('succeeded','failed','inconclusive','rolled_back')),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'succeeded' OR (
    expected_image_digests @> observed_image_digests AND observed_image_digests @> expected_image_digests
    AND api_postcondition->>'passed'='true' AND ui_postcondition->>'passed'='true'
  ))
);

CREATE OR REPLACE FUNCTION oaa.invalidate_remediation_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa,console AS $$
BEGIN
  IF ROW(NEW.repository,NEW.base_revision,NEW.allowed_paths,NEW.patch_digest,NEW.reason,NEW.risk_level,
         NEW.affected_components,NEW.affected_images,NEW.required_tests,NEW.release_scope,
         NEW.full_release_justification,NEW.target_channel,NEW.build_authority,NEW.rollback_revision,
         NEW.rollback_image_digests,NEW.approval_expires_at)
     IS DISTINCT FROM
     ROW(OLD.repository,OLD.base_revision,OLD.allowed_paths,OLD.patch_digest,OLD.reason,OLD.risk_level,
         OLD.affected_components,OLD.affected_images,OLD.required_tests,OLD.release_scope,
         OLD.full_release_justification,OLD.target_channel,OLD.build_authority,OLD.rollback_revision,
         OLD.rollback_image_digests,OLD.approval_expires_at) THEN
    NEW.stage := 'awaiting_approval';
    NEW.approval_expires_at := clock_timestamp();
    UPDATE console.module_operation SET phase='AwaitingApproval',execution_state='awaiting_approval',
      approval_evidence_ref=NULL,updated_at=clock_timestamp() WHERE operation_id=NEW.operation_id;
    UPDATE console.module_operation_approval SET revoked_at=clock_timestamp()
      WHERE operation_id=NEW.operation_id AND revoked_at IS NULL;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS remediation_approval_invalidation ON oaa.engineering_remediation_request;
CREATE TRIGGER remediation_approval_invalidation BEFORE UPDATE ON oaa.engineering_remediation_request
  FOR EACH ROW EXECUTE FUNCTION oaa.invalidate_remediation_approval();

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
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS build_evidence_binding ON oaa.build_evidence;
CREATE TRIGGER build_evidence_binding BEFORE INSERT ON oaa.build_evidence
  FOR EACH ROW EXECUTE FUNCTION oaa.validate_build_evidence_binding();

DROP TRIGGER IF EXISTS build_evidence_append_only ON oaa.build_evidence;
CREATE TRIGGER build_evidence_append_only BEFORE UPDATE OR DELETE ON oaa.build_evidence
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.build_evidence ENABLE ALWAYS TRIGGER build_evidence_append_only;
DROP TRIGGER IF EXISTS deployment_verification_append_only ON oaa.deployment_verification;
CREATE TRIGGER deployment_verification_append_only BEFORE UPDATE OR DELETE ON oaa.deployment_verification
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.deployment_verification ENABLE ALWAYS TRIGGER deployment_verification_append_only;

CREATE OR REPLACE FUNCTION oaa.propose_engineering_remediation(
  p_remediation_request_id uuid,
  p_idempotency_key text,
  p_actor_id uuid,
  p_assurance text,
  p_auth_session_id uuid,
  p_authz_revision text,
  p_assessment_id uuid,
  p_incident_id uuid,
  p_repository text,
  p_base_revision text,
  p_allowed_paths text[],
  p_patch_digest text,
  p_reason text,
  p_risk_level text,
  p_affected_components text[],
  p_affected_images text[],
  p_required_tests text[],
  p_release_scope text,
  p_full_release_justification text,
  p_target_channel text,
  p_build_authority text,
  p_rollback_revision text,
  p_rollback_image_digests text[],
  p_approval_binding_digest text,
  p_approval_expires_at timestamptz
) RETURNS oaa.engineering_remediation_request
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa,console AS $$
DECLARE
  assessment oaa.remediation_assessment%ROWTYPE;
  mismatch oaa.mismatch%ROWTYPE;
  operation_id uuid;
  existing console.module_operation%ROWTYPE;
  created oaa.engineering_remediation_request%ROWTYPE;
  allowed_prefixes text[];
  allowed_components text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 82422));
  SELECT * INTO existing FROM console.module_operation WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.actor_id<>p_actor_id OR existing.action<>'engineering-remediation'
       OR existing.target_fingerprint<>p_approval_binding_digest THEN
      RAISE EXCEPTION 'idempotency key is bound to a different remediation proposal';
    END IF;
    SELECT * INTO created FROM oaa.engineering_remediation_request WHERE operation_id=existing.operation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'idempotent remediation proposal is incomplete'; END IF;
    RETURN created;
  END IF;

  SELECT * INTO assessment FROM oaa.remediation_assessment WHERE assessment_id=p_assessment_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'remediation assessment not found'; END IF;
  SELECT * INTO mismatch FROM oaa.mismatch WHERE mismatch_id=assessment.mismatch_id FOR SHARE;
  IF NOT FOUND OR mismatch.resolved_at IS NOT NULL OR mismatch.epistemic_state<>'known' THEN
    RAISE EXCEPTION 'fresh known unresolved mismatch is required';
  END IF;
  IF assessment.engineering_required IS NOT TRUE OR assessment.minimum_ladder_step<5 THEN
    RAISE EXCEPTION 'lower recovery ladder is not evidence-exhausted';
  END IF;
  IF assessment.incident_id IS DISTINCT FROM p_incident_id
     OR mismatch.incident_id IS DISTINCT FROM p_incident_id THEN
    RAISE EXCEPTION 'incident, mismatch and assessment correlation must match';
  END IF;
  IF p_approval_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'future approval expiry required'; END IF;

  CASE p_repository
    WHEN 'https://gitea.opensphere.local/opensphere/OpenSphere-console.git' THEN
      allowed_prefixes:=ARRAY['backend/','src/','nginx/','docs/'];
      allowed_components:=ARRAY['console','consoleBackend','oaaGateway'];
    WHEN 'https://gitea.opensphere.local/opensphere/OpenSphere-Setup-CLI.git' THEN
      allowed_prefixes:=ARRAY['src/','deploy/','tests/','docs/']; allowed_components:=ARRAY['setup'];
    WHEN 'https://gitea.opensphere.local/opensphere/OpenSphere-shell-clusterManager.git' THEN
      allowed_prefixes:=ARRAY['src/','backend/','tests/']; allowed_components:=ARRAY['clusterManager'];
    WHEN 'https://gitea.opensphere.local/opensphere/OpenSphere-shell-foundation.git' THEN
      allowed_prefixes:=ARRAY['src/','backend/','tests/']; allowed_components:=ARRAY['foundation'];
    ELSE RAISE EXCEPTION 'repository is not canonical or allowlisted';
  END CASE;
  IF cardinality(p_allowed_paths)<1 OR EXISTS (
    SELECT 1 FROM unnest(p_allowed_paths) path
    WHERE path LIKE '/%' OR path LIKE '%..%' OR NOT EXISTS (
      SELECT 1 FROM unnest(allowed_prefixes) prefix WHERE path LIKE prefix || '%'
    )
  ) THEN RAISE EXCEPTION 'allowed path is outside repository policy'; END IF;
  IF cardinality(p_affected_components)<1 OR EXISTS (
    SELECT 1 FROM unnest(p_affected_components) component WHERE NOT component=ANY(allowed_components)
  ) THEN RAISE EXCEPTION 'affected component is outside repository policy'; END IF;
  IF cardinality(p_affected_images)<1 OR EXISTS (
    SELECT 1 FROM unnest(p_affected_images) image WHERE image!~'^[a-z0-9][a-z0-9._-]{1,127}$'
  ) THEN RAISE EXCEPTION 'affected image must use a canonical image id'; END IF;
  IF cardinality(p_required_tests)<1 OR EXISTS (
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
    p_approval_binding_digest,'AwaitingApproval',p_incident_id,'engineering-remediation-v1',p_approval_binding_digest,
    'mismatch:'||mismatch.mismatch_id,p_risk_level,'aal2',p_assurance,p_auth_session_id,p_authz_revision,
    p_approval_expires_at,'awaiting_approval','not_required',
    jsonb_build_object('proposalOnly',true,'assessmentId',p_assessment_id,'mismatchId',mismatch.mismatch_id),
    jsonb_build_object('repositoryWrite',false,'build',false,'publish',false,'deploy',false)
  );

  INSERT INTO oaa.engineering_remediation_request(
    remediation_request_id,assessment_id,incident_id,operation_id,repository,base_revision,
    allowed_paths,patch_digest,reason,risk_level,affected_components,affected_images,required_tests,
    release_scope,full_release_justification,target_channel,build_authority,rollback_revision,
    rollback_image_digests,approval_binding_digest,approval_expires_at,stage
  ) VALUES(
    p_remediation_request_id,p_assessment_id,p_incident_id,operation_id,p_repository,p_base_revision,
    p_allowed_paths,p_patch_digest,p_reason,p_risk_level,p_affected_components,p_affected_images,p_required_tests,
    p_release_scope,p_full_release_justification,p_target_channel,p_build_authority,p_rollback_revision,
    p_rollback_image_digests,p_approval_binding_digest,p_approval_expires_at,'proposed'
  ) RETURNING * INTO created;
  RETURN created;
END $$;

ALTER TABLE oaa.self_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.mismatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.remediation_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.engineering_remediation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.build_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.deployment_verification ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA oaa TO opensphere_console_backend;
REVOKE ALL ON oaa.self_model,oaa.mismatch,oaa.remediation_assessment,oaa.engineering_remediation_request,
  oaa.build_evidence,oaa.deployment_verification FROM PUBLIC,anon,authenticated,service_role,opensphere_oaa_gateway;
GRANT SELECT ON oaa.self_model,oaa.mismatch,oaa.remediation_assessment,oaa.engineering_remediation_request,
  oaa.build_evidence,oaa.deployment_verification TO opensphere_oaa_api,opensphere_oaa_gateway;
GRANT SELECT,INSERT,UPDATE ON oaa.self_model,oaa.mismatch,oaa.remediation_assessment TO opensphere_oaa_observer;
GRANT SELECT,INSERT,UPDATE ON oaa.engineering_remediation_request TO opensphere_console_backend;
GRANT SELECT,INSERT ON oaa.build_evidence,oaa.deployment_verification TO opensphere_console_backend;
REVOKE ALL ON FUNCTION oaa.propose_engineering_remediation(uuid,text,uuid,text,uuid,text,uuid,uuid,text,text,text[],text,text,text,text[],text[],text[],text,text,text,text,text,text[],text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role,opensphere_oaa_observer,opensphere_oaa_api,opensphere_oaa_gateway;
GRANT EXECUTE ON FUNCTION oaa.propose_engineering_remediation(uuid,text,uuid,text,uuid,text,uuid,uuid,text,text,text[],text,text,text,text[],text[],text[],text,text,text,text,text,text[],text,timestamptz)
  TO opensphere_console_backend;
CREATE POLICY api_self_model ON oaa.self_model FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY api_mismatch ON oaa.mismatch FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY api_assessment ON oaa.remediation_assessment FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY api_remediation ON oaa.engineering_remediation_request FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY api_build_evidence ON oaa.build_evidence FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY api_deployment_verification ON oaa.deployment_verification FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY observer_self_model ON oaa.self_model FOR ALL TO opensphere_oaa_observer USING(true) WITH CHECK(true);
CREATE POLICY observer_mismatch ON oaa.mismatch FOR ALL TO opensphere_oaa_observer USING(true) WITH CHECK(true);
CREATE POLICY observer_assessment ON oaa.remediation_assessment FOR ALL TO opensphere_oaa_observer USING(true) WITH CHECK(true);
CREATE POLICY backend_remediation ON oaa.engineering_remediation_request FOR ALL TO opensphere_console_backend USING(true) WITH CHECK(true);
CREATE POLICY backend_build_evidence ON oaa.build_evidence FOR ALL TO opensphere_console_backend USING(true) WITH CHECK(true);
CREATE POLICY backend_deployment_verification ON oaa.deployment_verification FOR ALL TO opensphere_console_backend USING(true) WITH CHECK(true);

COMMENT ON TABLE oaa.engineering_remediation_request IS 'Patch-bound proposal/receipt correlated to the existing durable module operation; never arbitrary shell authority.';
