-- CON-FR-019: native OS Shell authority over current console_identity.
-- Reuses bounded lifecycle/fencing/ticket invariants, not the retired identity DB.
-- References reviewed for reconstruction (not executable installation history):
-- 0061_shell_session_ledger.sql sha256:5bb566c70e0ebdb50aa3cab9498dbdc3d8f291c7ca963c341b6896fe0b4804d9
-- 0062_shell_session_quota_and_kill_switch.sql sha256:ed59833e6de7cbe309e1734696af46198351cbf94cd3490262dce848f1ba22af
-- 0064_shell_feature_release_ledger_contract.sql sha256:3157ea33d445c6325601752d832c07f650fff90ed1ac9d89260dbac5d4e9e667
-- Five native lifecycle/control tables; no parallel identity or permission store.
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['opensphere_shell_api','opensphere_shell_gateway','opensphere_shell_reconciler'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
 EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOBYPASSRLS',role_name); END IF;
 END LOOP;
END $$;
CREATE SCHEMA console_shell;
REVOKE ALL ON SCHEMA console_shell FROM PUBLIC;
GRANT USAGE ON SCHEMA console_shell TO console_api;

CREATE OR REPLACE FUNCTION console_identity.managed_role_permissions(p_role text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE p_role
    WHEN 'console-admins' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.extension.install',
      'console.extension.remove',
      'console.extension.revoke',
      'console.git.change',
      'console.identity.manage',
      'console.operation.approve',
      'console.operation.verify',
      'console.registry.manage',
      'console.role.admin',
      'session:attach'
    ]::text[]
    WHEN 'console-operators' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.extension.install',
      'console.extension.remove',
      'console.extension.revoke',
      'console.git.change',
      'console.operation.verify',
      'console.registry.manage',
      'console.role.operator',
      'session:attach'
    ]::text[]
    WHEN 'console-viewers' THEN ARRAY[
      'console.audit.read',
      'console.data_identity.read',
      'console.role.viewer'
    ]::text[]
    ELSE ARRAY[]::text[]
  END;
$$;

DO $$
DECLARE
  v_subject console_identity.subject_authority;
  v_next_revision bigint;
BEGIN
  FOR v_subject IN
    SELECT authority.*
      FROM console_identity.subject_authority AS authority
     WHERE EXISTS (
       SELECT 1
         FROM console_identity.permission_grant AS role_grant
        WHERE role_grant.subject_id = authority.subject_id
          AND role_grant.permission IN ('console.role.admin', 'console.role.operator')
          AND role_grant.grant_revision <= authority.permission_revision
          AND role_grant.revoked_at IS NULL
     )
       AND NOT EXISTS (
       SELECT 1
         FROM console_identity.permission_grant AS change_grant
        WHERE change_grant.subject_id = authority.subject_id
          AND change_grant.permission = 'session:attach'
          AND change_grant.grant_revision <= authority.permission_revision
          AND change_grant.revoked_at IS NULL
     )
     ORDER BY authority.subject_id
     FOR UPDATE
  LOOP
    v_next_revision := v_subject.permission_revision + 1;
    INSERT INTO console_identity.permission_grant(
      subject_id, permission, grant_revision, granted_by
    ) VALUES (
      v_subject.subject_id, 'session:attach', v_next_revision, v_subject.subject_id
    );
    UPDATE console_identity.subject_authority
       SET permission_revision = v_next_revision,
           revoke_epoch = revoke_epoch + 1,
           updated_at = statement_timestamp()
     WHERE subject_id = v_subject.subject_id;
    UPDATE console_identity.browser_session
       SET revoked_at = statement_timestamp(),
           revoke_reason = 'native-shell-policy-upgrade'
     WHERE subject_id = v_subject.subject_id
       AND revoked_at IS NULL;
  END LOOP;
END;
$$;

CREATE TABLE console_shell.shell_session (
  session_id uuid PRIMARY KEY,
  browser_session_id uuid NOT NULL REFERENCES console_identity.browser_session(session_id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  session_class text NOT NULL DEFAULT 'operator-interactive'
    CHECK(session_class='operator-interactive'),
  runtime_adapter_id text NOT NULL DEFAULT 'cbss.kubernetes-pod'
    CHECK(runtime_adapter_id='cbss.kubernetes-pod'),
  runtime_template_revision text NOT NULL
    CHECK(runtime_template_revision~'^[a-z0-9][a-z0-9._:-]{0,127}$'),
  network_profile text NOT NULL DEFAULT 'console-only' CHECK(network_profile='console-only'),
  origin text NOT NULL CHECK(
    origin~'^https://[^/?#]+$'
    OR origin~'^http://localhost(:[0-9]+)?$'
    OR origin~'^http://127[.]0[.]0[.]1(:[0-9]+)?$'
  ),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  fencing_epoch bigint NOT NULL DEFAULT 1 CHECK(fencing_epoch>0),
  desired_state text NOT NULL DEFAULT 'Running' CHECK(desired_state IN ('Running','Terminated')),
  observed_state text NOT NULL DEFAULT 'Pending'
    CHECK(observed_state IN ('Pending','Provisioning','Ready','Terminating','Terminated','Failed')),
  permission_revision text NOT NULL CHECK(permission_revision~'^sha256:[a-f0-9]{64}$'),
  aal text NOT NULL CHECK(aal IN ('aal1','aal2')),
  runtime_uid text CHECK(runtime_uid IS NULL OR length(runtime_uid) BETWEEN 1 AND 256),
  runtime_resource_version text
    CHECK(runtime_resource_version IS NULL OR length(runtime_resource_version) BETWEEN 1 AND 256),
  observed_generation bigint CHECK(observed_generation IS NULL OR observed_generation>0),
  runtime_key_id text CHECK(runtime_key_id IS NULL OR runtime_key_id~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  runtime_public_key_pem text CHECK(runtime_public_key_pem IS NULL OR length(runtime_public_key_pem) BETWEEN 64 AND 4096),
  runtime_tls_certificate_sha256 text CHECK(runtime_tls_certificate_sha256 IS NULL OR runtime_tls_certificate_sha256~'^sha256:[a-f0-9]{64}$'),
  runtime_attach_endpoint text CHECK(runtime_attach_endpoint IS NULL OR runtime_attach_endpoint~'^wss://[^/?#]+:8443/v1/runtime/attach$'),
  runtime_credential_hash text CHECK(runtime_credential_hash IS NULL OR runtime_credential_hash~'^sha256:[a-f0-9]{64}$'),
  runtime_credential_expires_at timestamptz,
  runtime_registered_at timestamptz,
  runtime_projection_started_at timestamptz,
  lease_owner text CHECK(lease_owner IS NULL OR length(btrim(lease_owner)) BETWEEN 3 AND 128),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  release_evidence_ref text NOT NULL CHECK(length(release_evidence_ref) BETWEEN 1 AND 512),
  manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^sha256:[a-f0-9]{64}$'),
  key_id text NOT NULL CHECK(key_id~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  runtime_image_digest text NOT NULL CHECK(runtime_image_digest~'^sha256:[a-f0-9]{64}$'),
  os_artifact_digest text NOT NULL CHECK(os_artifact_digest~'^sha256:[a-f0-9]{64}$'),
  session_policy_revision text NOT NULL
    CHECK(session_policy_revision~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  termination_requested_at timestamptz,
  terminated_at timestamptz,
  last_error_code text CHECK(last_error_code IS NULL OR last_error_code~'^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  CHECK(idle_expires_at>created_at AND absolute_expires_at>created_at AND idle_expires_at<=absolute_expires_at),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)),
  CHECK((observed_state='Terminated')=(terminated_at IS NOT NULL)),
  CHECK(desired_state<>'Terminated' OR termination_requested_at IS NOT NULL),
  CHECK((runtime_registered_at IS NULL AND runtime_key_id IS NULL AND runtime_public_key_pem IS NULL
      AND runtime_tls_certificate_sha256 IS NULL AND runtime_attach_endpoint IS NULL
      AND runtime_credential_hash IS NULL AND runtime_credential_expires_at IS NULL)
    OR (runtime_registered_at IS NOT NULL AND runtime_key_id IS NOT NULL AND runtime_public_key_pem IS NOT NULL
      AND runtime_tls_certificate_sha256 IS NOT NULL AND runtime_attach_endpoint IS NOT NULL
      AND runtime_credential_hash IS NOT NULL AND runtime_credential_expires_at>runtime_registered_at))
);

CREATE INDEX shell_session_actor_active_idx
  ON console_shell.shell_session(actor_id,updated_at DESC) WHERE observed_state<>'Terminated';

CREATE INDEX shell_session_reconcile_idx
  ON console_shell.shell_session(lease_expires_at,updated_at)
  WHERE observed_state<>'Terminated';

CREATE TABLE console_shell.shell_attach_ticket (
  ticket_hash text PRIMARY KEY CHECK(ticket_hash~'^sha256:[a-f0-9]{64}$'),
  session_id uuid NOT NULL REFERENCES console_shell.shell_session(session_id) ON DELETE RESTRICT,
  browser_session_id uuid NOT NULL REFERENCES console_identity.browser_session(session_id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  origin text NOT NULL,
  generation bigint NOT NULL CHECK(generation>0),
  fencing_epoch bigint NOT NULL CHECK(fencing_epoch>0),
  permission_revision text NOT NULL CHECK(permission_revision~'^sha256:[a-f0-9]{64}$'),
  aal text NOT NULL CHECK(aal IN ('aal1','aal2')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text CHECK(consumed_by IS NULL OR length(btrim(consumed_by)) BETWEEN 3 AND 128),
  runtime_authorized_at timestamptz,
  runtime_authorized_by text CHECK(runtime_authorized_by IS NULL OR length(btrim(runtime_authorized_by)) BETWEEN 3 AND 256),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 seconds'),
  CHECK((consumed_at IS NULL)=(consumed_by IS NULL)),
  CHECK((runtime_authorized_at IS NULL)=(runtime_authorized_by IS NULL)),
  CHECK(runtime_authorized_at IS NULL OR consumed_at IS NOT NULL)
);

CREATE INDEX shell_attach_ticket_unconsumed_idx
  ON console_shell.shell_attach_ticket(expires_at,session_id) WHERE consumed_at IS NULL;

CREATE TABLE console_shell.shell_session_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES console_shell.shell_session(session_id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  session_class text NOT NULL CHECK(session_class='operator-interactive'),
  runtime_adapter_id text NOT NULL CHECK(runtime_adapter_id='cbss.kubernetes-pod'),
  generation bigint NOT NULL CHECK(generation>0),
  fencing_epoch bigint NOT NULL CHECK(fencing_epoch>0),
  event_type text NOT NULL CHECK(event_type IN (
    'SessionCreated','RuntimeClaimed','RuntimeProvisioning','RuntimeRegistered','RuntimeReprojected','RuntimeReady','AttachTicketIssued',
    'SessionAttached','SessionRevalidated','TeardownRequested','RuntimeTerminating',
    'SessionTerminated','SessionFailed','PolicyDenied'
  )),
  result text NOT NULL CHECK(result IN ('Succeeded','Denied','Failed')),
  reason_code text NOT NULL CHECK(reason_code~'^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  origin text NOT NULL,
  permission_revision text NOT NULL CHECK(permission_revision~'^sha256:[a-f0-9]{64}$'),
  aal text NOT NULL CHECK(aal IN ('aal1','aal2')),
  release_evidence_ref text NOT NULL,
  manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^sha256:[a-f0-9]{64}$'),
  key_id text NOT NULL,
  runtime_image_digest text NOT NULL CHECK(runtime_image_digest~'^sha256:[a-f0-9]{64}$'),
  os_artifact_digest text NOT NULL CHECK(os_artifact_digest~'^sha256:[a-f0-9]{64}$'),
  session_policy_revision text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX shell_session_event_session_idx
  ON console_shell.shell_session_event(session_id,event_id);

CREATE TABLE console_shell.shell_control_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  actor_active_limit integer NOT NULL DEFAULT 2 CHECK(actor_active_limit BETWEEN 1 AND 10),
  global_active_limit integer NOT NULL DEFAULT 8 CHECK(global_active_limit BETWEEN 1 AND 1000),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 512),
  changed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
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

INSERT INTO console_shell.shell_control_state(singleton,enabled,reason,changed_identity,operation_evidence)
VALUES(true,false,'Requires verified native release activation after exact component readiness',
  'migration:console.shell.native_authority',jsonb_build_object('authority','migration','migrationId','opensphere-console/20260903/0029'));

CREATE TABLE console_shell.shell_control_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision bigint NOT NULL CHECK(revision>0),
  enabled boolean NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('Enabled','DisableRequested','DrainCompleted','ScaleDownClaimed','ScaleDownCompleted')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 512),
  actor_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_identity text NOT NULL CHECK(length(btrim(actor_identity)) BETWEEN 3 AND 256),
  operation_evidence jsonb NOT NULL CHECK(jsonb_typeof(operation_evidence)='object'),
  affected_sessions integer NOT NULL DEFAULT 0 CHECK(affected_sessions>=0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION console_shell.reject_shell_session_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,console_shell AS $$
BEGIN
  RAISE EXCEPTION 'console_shell.shell_session_event is append-only';
END $$;

CREATE OR REPLACE FUNCTION console_shell.guard_shell_session_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,console_shell AS $$
BEGIN
  IF NEW.session_id<>OLD.session_id OR NEW.browser_session_id<>OLD.browser_session_id
    OR NEW.actor_id<>OLD.actor_id OR NEW.session_class<>OLD.session_class
    OR NEW.runtime_adapter_id<>OLD.runtime_adapter_id
    OR NEW.runtime_template_revision<>OLD.runtime_template_revision
    OR NEW.network_profile<>OLD.network_profile OR NEW.origin<>OLD.origin
    OR NEW.release_evidence_ref<>OLD.release_evidence_ref
    OR NEW.manifest_sha256<>OLD.manifest_sha256 OR NEW.key_id<>OLD.key_id
    OR NEW.runtime_image_digest<>OLD.runtime_image_digest
    OR NEW.os_artifact_digest<>OLD.os_artifact_digest
    OR NEW.session_policy_revision<>OLD.session_policy_revision THEN
    RAISE EXCEPTION 'immutable shell session binding changed' USING ERRCODE='40001';
  END IF;
  IF NEW.generation<OLD.generation OR NEW.fencing_epoch<OLD.fencing_epoch THEN
    RAISE EXCEPTION 'stale shell generation or fencing epoch' USING ERRCODE='40001';
  END IF;
  IF OLD.runtime_uid IS NOT NULL AND NEW.runtime_uid IS DISTINCT FROM OLD.runtime_uid
    AND NEW.generation=OLD.generation THEN
    RAISE EXCEPTION 'runtime UID changed without a new generation' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION console_shell.current_shell_permission_revision(p_actor_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_authority console_identity.subject_authority; v_permissions text;
BEGIN
 SELECT * INTO v_authority FROM console_identity.subject_authority WHERE subject_id=p_actor_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'shell actor authority is unavailable' USING ERRCODE='28000'; END IF;
 SELECT coalesce(string_agg(permission,E'\x1f' ORDER BY permission COLLATE "C"),'') INTO v_permissions
 FROM (SELECT DISTINCT permission FROM console_identity.permission_grant WHERE subject_id=p_actor_id
   AND grant_revision<=v_authority.permission_revision AND revoked_at IS NULL) AS grants;
 RETURN 'sha256:'||encode(sha256(convert_to('permissionRevision='||v_authority.permission_revision::text
   ||E'\nrevokeEpoch='||v_authority.revoke_epoch::text||E'\npermissions='||v_permissions,'UTF8')),'hex');
END $$;

CREATE OR REPLACE FUNCTION console_shell.shell_feature_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
  SELECT enabled FROM console_shell.shell_control_state WHERE singleton=true
$$;

CREATE OR REPLACE FUNCTION console_shell.shell_actor_has_permission(p_actor_id uuid,p_permission text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT console_shell.shell_feature_enabled() AND EXISTS(SELECT 1 FROM console_identity.subject_authority a
 JOIN console_identity.permission_grant g ON g.subject_id=a.subject_id
 WHERE a.subject_id=p_actor_id AND g.permission=p_permission AND g.grant_revision<=a.permission_revision AND g.revoked_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION console_shell.assert_shell_authority(p_actor_id uuid,p_permission_revision text,p_require_attach boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM 1 FROM console_identity.subject_authority WHERE subject_id=p_actor_id FOR SHARE;
 PERFORM 1 FROM console_identity.permission_grant WHERE subject_id=p_actor_id FOR SHARE;
 IF p_permission_revision IS DISTINCT FROM console_shell.current_shell_permission_revision(p_actor_id) THEN
  RAISE EXCEPTION 'shell permission revision changed' USING ERRCODE='40001'; END IF;
 IF p_require_attach AND NOT console_shell.shell_actor_has_permission(p_actor_id,'session:attach') THEN
  RAISE EXCEPTION 'session:attach permission is required' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION console_shell.append_shell_session_event(
  p_session_id uuid,p_event_type text,p_result text,p_reason_code text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
BEGIN
  INSERT INTO console_shell.shell_session_event(
    session_id,actor_id,session_class,runtime_adapter_id,generation,fencing_epoch,
    event_type,result,reason_code,origin,permission_revision,aal,release_evidence_ref,
    manifest_sha256,key_id,runtime_image_digest,os_artifact_digest,session_policy_revision
  ) SELECT session_id,actor_id,session_class,runtime_adapter_id,generation,fencing_epoch,
    p_event_type,p_result,p_reason_code,origin,permission_revision,aal,release_evidence_ref,
    manifest_sha256,key_id,runtime_image_digest,os_artifact_digest,session_policy_revision
  FROM console_shell.shell_session WHERE session_id=p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'shell session not found'; END IF;
END $$;

CREATE OR REPLACE FUNCTION console_shell.create_shell_session(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,p_aal text,
  p_permission_revision text,p_runtime_template_revision text,p_idle_expires_at timestamptz,
  p_absolute_expires_at timestamptz,p_release_evidence jsonb
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE
  v_browser console_identity.browser_session%ROWTYPE; v_existing console_shell.shell_session%ROWTYPE;
  v_state console_shell.shell_control_state%ROWTYPE; v_now timestamptz:=clock_timestamp();
  v_actor_active bigint; v_global_active bigint;
BEGIN
  SELECT * INTO v_state FROM console_shell.shell_control_state WHERE singleton=true;
  IF NOT v_state.enabled THEN RAISE EXCEPTION 'ShellFeatureDisabled'; END IF;
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_browser FROM console_identity.browser_session
    WHERE session_id=p_browser_session_id AND subject_id=p_actor_id FOR SHARE;
  IF NOT FOUND OR v_browser.revoked_at IS NOT NULL OR v_browser.expires_at<=v_now
    OR v_browser.absolute_expires_at<=v_now OR v_browser.aal<>p_aal
    OR v_browser.permission_revision<>(SELECT permission_revision FROM console_identity.subject_authority WHERE subject_id=p_actor_id)
    OR v_browser.revoke_epoch<>(SELECT revoke_epoch FROM console_identity.subject_authority WHERE subject_id=p_actor_id) THEN
    RAISE EXCEPTION 'durable browser session is not active or assurance changed' USING ERRCODE='28000';
  END IF;
  IF p_idle_expires_at<=v_now OR p_absolute_expires_at<=v_now
    OR p_idle_expires_at>p_absolute_expires_at OR p_idle_expires_at>v_browser.expires_at
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
  SELECT * INTO v_state FROM console_shell.shell_control_state WHERE singleton=true FOR SHARE;
  IF NOT v_state.enabled THEN RAISE EXCEPTION 'ShellFeatureDisabled'; END IF;

  SELECT * INTO v_existing FROM console_shell.shell_session WHERE session_id=p_session_id;
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

  SELECT count(*) INTO v_global_active FROM console_shell.shell_session
    WHERE desired_state='Running' AND observed_state<>'Terminated'
      AND idle_expires_at>v_now AND absolute_expires_at>v_now;
  IF v_global_active>=v_state.global_active_limit THEN RAISE EXCEPTION 'ShellGlobalSessionQuotaExceeded'; END IF;
  SELECT count(*) INTO v_actor_active FROM console_shell.shell_session
    WHERE actor_id=p_actor_id AND desired_state='Running' AND observed_state<>'Terminated'
      AND idle_expires_at>v_now AND absolute_expires_at>v_now;
  IF v_actor_active>=v_state.actor_active_limit THEN RAISE EXCEPTION 'ShellActorSessionQuotaExceeded'; END IF;

  INSERT INTO console_shell.shell_session(
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
  PERFORM console_shell.append_shell_session_event(p_session_id,'SessionCreated','Succeeded','SessionIntentAccepted');
  RETURN QUERY SELECT * FROM console_shell.shell_session WHERE session_id=p_session_id;
END $$;

CREATE OR REPLACE FUNCTION console_shell.get_shell_session(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_permission_revision text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,false);
  RETURN QUERY SELECT * FROM console_shell.shell_session s
    WHERE s.session_id=p_session_id AND s.browser_session_id=p_browser_session_id AND s.actor_id=p_actor_id;
END $$;

CREATE OR REPLACE FUNCTION console_shell.list_shell_sessions(
  p_browser_session_id uuid,p_actor_id uuid,p_permission_revision text,p_limit integer DEFAULT 50
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,false);
  RETURN QUERY SELECT * FROM console_shell.shell_session s
    WHERE s.browser_session_id=p_browser_session_id AND s.actor_id=p_actor_id
    ORDER BY s.created_at DESC LIMIT greatest(1,least(coalesce(p_limit,50),100));
END $$;

CREATE OR REPLACE FUNCTION console_shell.issue_shell_attach_ticket(
  p_ticket_hash text,p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text,p_expires_at timestamptz
) RETURNS SETOF console_shell.shell_attach_ticket
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  IF NOT console_shell.shell_feature_enabled() THEN RAISE EXCEPTION 'ShellFeatureDisabled'; END IF;
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.browser_session_id<>p_browser_session_id OR v_session.actor_id<>p_actor_id
    OR v_session.origin<>p_origin OR v_session.generation<>p_generation
    OR v_session.fencing_epoch<>p_fencing_epoch OR v_session.aal<>p_aal
    OR v_session.permission_revision<>p_permission_revision OR v_session.desired_state<>'Running'
    OR v_session.observed_state<>'Ready' OR v_session.idle_expires_at<=v_now
    OR v_session.absolute_expires_at<=v_now THEN
    RAISE EXCEPTION 'shell session binding is not attachable' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM console_identity.browser_session b JOIN console_identity.subject_authority o ON o.subject_id=b.subject_id
    WHERE b.session_id=p_browser_session_id AND b.subject_id=p_actor_id AND b.revoked_at IS NULL
      AND b.aal=p_aal AND b.permission_revision=o.permission_revision AND b.revoke_epoch=o.revoke_epoch
      AND b.expires_at>v_now AND b.absolute_expires_at>v_now) THEN
    RAISE EXCEPTION 'durable browser session is no longer active' USING ERRCODE='28000';
  END IF;
  IF p_expires_at<=v_now OR p_expires_at>v_now+interval '30 seconds'
    OR p_expires_at>v_session.idle_expires_at OR p_expires_at>v_session.absolute_expires_at THEN
    RAISE EXCEPTION 'attach ticket TTL must be at most 30 seconds';
  END IF;
  INSERT INTO console_shell.shell_attach_ticket(
    ticket_hash,session_id,browser_session_id,actor_id,origin,generation,fencing_epoch,
    permission_revision,aal,expires_at
  ) VALUES(p_ticket_hash,p_session_id,p_browser_session_id,p_actor_id,p_origin,p_generation,p_fencing_epoch,
    p_permission_revision,p_aal,p_expires_at);
  PERFORM console_shell.append_shell_session_event(p_session_id,'AttachTicketIssued','Succeeded','AttachTicketBound');
  RETURN QUERY SELECT * FROM console_shell.shell_attach_ticket WHERE ticket_hash=p_ticket_hash;
END $$;

CREATE OR REPLACE FUNCTION console_shell.resolve_shell_attach_binding(
  p_ticket_hash text,p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_aal text,p_permission_revision text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,true);
  RETURN QUERY SELECT s.* FROM console_shell.shell_attach_ticket t JOIN console_shell.shell_session s
    ON s.session_id=t.session_id JOIN console_identity.browser_session b ON b.session_id=s.browser_session_id
    JOIN console_identity.subject_authority o ON o.subject_id=s.actor_id
    WHERE t.ticket_hash=p_ticket_hash AND t.session_id=p_session_id
      AND t.browser_session_id=p_browser_session_id AND t.actor_id=p_actor_id AND t.origin=p_origin
      AND t.aal=p_aal AND t.permission_revision=p_permission_revision AND t.consumed_at IS NULL
      AND t.expires_at>v_now AND s.generation=t.generation AND s.fencing_epoch=t.fencing_epoch
      AND s.permission_revision=p_permission_revision AND s.aal=p_aal AND s.origin=p_origin
      AND s.desired_state='Running' AND s.observed_state='Ready'
      AND s.runtime_registered_at IS NOT NULL AND s.runtime_credential_expires_at>v_now
      AND s.idle_expires_at>v_now AND s.absolute_expires_at>v_now
      AND b.revoked_at IS NULL AND b.aal=p_aal AND b.permission_revision=o.permission_revision AND b.revoke_epoch=o.revoke_epoch
      AND b.expires_at>v_now AND b.absolute_expires_at>v_now;
END $$;

CREATE OR REPLACE FUNCTION console_shell.consume_shell_attach_ticket(
  p_ticket_hash text,p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text,p_consumer text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_affected integer; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.browser_session_id<>p_browser_session_id OR v_session.actor_id<>p_actor_id
    OR v_session.origin<>p_origin OR v_session.generation<>p_generation
    OR v_session.fencing_epoch<>p_fencing_epoch OR v_session.aal<>p_aal
    OR v_session.permission_revision<>p_permission_revision OR v_session.desired_state<>'Running'
    OR v_session.observed_state<>'Ready' OR v_session.idle_expires_at<=v_now
    OR v_session.absolute_expires_at<=v_now THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM console_identity.browser_session b
    JOIN console_identity.subject_authority o ON o.subject_id=b.subject_id
    WHERE b.session_id=p_browser_session_id AND b.subject_id=p_actor_id AND b.revoked_at IS NULL
      AND b.aal=p_aal AND b.permission_revision=o.permission_revision AND b.revoke_epoch=o.revoke_epoch
      AND b.expires_at>v_now AND b.absolute_expires_at>v_now) THEN RETURN; END IF;
  UPDATE console_shell.shell_attach_ticket SET consumed_at=v_now,consumed_by=p_consumer
  WHERE ticket_hash=p_ticket_hash AND session_id=p_session_id AND browser_session_id=p_browser_session_id
    AND actor_id=p_actor_id AND origin=p_origin AND generation=p_generation
    AND fencing_epoch=p_fencing_epoch AND aal=p_aal AND permission_revision=p_permission_revision
    AND consumed_at IS NULL AND expires_at>v_now;
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  IF v_affected<>1 THEN RETURN; END IF;
  UPDATE console_shell.shell_session SET last_activity_at=v_now,updated_at=v_now WHERE session_id=p_session_id;
  PERFORM console_shell.append_shell_session_event(p_session_id,'SessionAttached','Succeeded','AttachTicketConsumed');
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console_shell.revalidate_shell_session(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,true);
  RETURN QUERY SELECT s.* FROM console_shell.shell_session s JOIN console_identity.browser_session b
    ON b.session_id=s.browser_session_id AND b.subject_id=s.actor_id
    JOIN console_identity.subject_authority o ON o.subject_id=s.actor_id
    WHERE s.session_id=p_session_id AND s.browser_session_id=p_browser_session_id
      AND s.actor_id=p_actor_id AND s.origin=p_origin AND s.generation=p_generation
      AND s.fencing_epoch=p_fencing_epoch AND s.aal=p_aal
      AND s.permission_revision=p_permission_revision AND s.desired_state='Running'
      AND s.observed_state='Ready' AND s.idle_expires_at>v_now AND s.absolute_expires_at>v_now
      AND b.revoked_at IS NULL AND b.aal=p_aal AND b.permission_revision=o.permission_revision AND b.revoke_epoch=o.revoke_epoch
      AND b.expires_at>v_now AND b.absolute_expires_at>v_now;
END $$;

CREATE OR REPLACE FUNCTION console_shell.authorize_shell_runtime_attach(
  p_runtime_credential_hash text,p_ticket_hash text,p_session_id uuid,p_runtime_uid text,
  p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_affected integer; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.runtime_credential_hash<>p_runtime_credential_hash
    OR v_session.runtime_credential_expires_at<=v_now OR v_session.runtime_uid<>p_runtime_uid
    OR v_session.generation<>p_generation OR v_session.fencing_epoch<>p_fencing_epoch
    OR v_session.desired_state<>'Running' OR v_session.observed_state<>'Ready'
    OR v_session.permission_revision<>console_shell.current_shell_permission_revision(v_session.actor_id)
    OR NOT console_shell.shell_actor_has_permission(v_session.actor_id,'session:attach') THEN RETURN; END IF;
  UPDATE console_shell.shell_attach_ticket SET runtime_authorized_at=v_now,runtime_authorized_by=p_runtime_uid
    WHERE ticket_hash=p_ticket_hash AND session_id=p_session_id AND generation=p_generation
      AND fencing_epoch=p_fencing_epoch AND consumed_at IS NOT NULL AND runtime_authorized_at IS NULL
      AND expires_at>v_now;
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  IF v_affected<>1 THEN RETURN; END IF;
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console_shell.revalidate_shell_runtime(
  p_runtime_credential_hash text,p_session_id uuid,p_runtime_uid text,p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  RETURN QUERY SELECT s.* FROM console_shell.shell_session s JOIN console_identity.browser_session b
    ON b.session_id=s.browser_session_id JOIN console_identity.subject_authority o ON o.subject_id=s.actor_id
    WHERE s.session_id=p_session_id AND s.runtime_credential_hash=p_runtime_credential_hash
      AND s.runtime_credential_expires_at>v_now AND s.runtime_uid=p_runtime_uid
      AND s.generation=p_generation AND s.fencing_epoch=p_fencing_epoch
      AND s.desired_state='Running' AND s.observed_state='Ready'
      AND s.permission_revision=console_shell.current_shell_permission_revision(s.actor_id)
      AND console_shell.shell_actor_has_permission(s.actor_id,'session:attach')
      AND s.idle_expires_at>v_now AND s.absolute_expires_at>v_now
      AND b.revoked_at IS NULL AND b.aal=s.aal AND b.permission_revision=o.permission_revision AND b.revoke_epoch=o.revoke_epoch
      AND b.expires_at>v_now AND b.absolute_expires_at>v_now;
END $$;

CREATE OR REPLACE FUNCTION console_shell.resolve_shell_delegation(
  p_session_id uuid,p_actor_id uuid,p_generation bigint,p_fencing_epoch bigint,p_permission_revision text,p_aal text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,true);
  RETURN QUERY SELECT s.* FROM console_shell.shell_session s JOIN console_identity.browser_session b ON b.session_id=s.browser_session_id
    JOIN console_identity.subject_authority o ON o.subject_id=s.actor_id WHERE s.session_id=p_session_id AND s.actor_id=p_actor_id
      AND s.generation=p_generation AND s.fencing_epoch=p_fencing_epoch AND s.permission_revision=p_permission_revision
      AND s.aal=p_aal AND s.desired_state='Running' AND s.observed_state='Ready'
      AND s.runtime_registered_at IS NOT NULL AND s.runtime_credential_expires_at>v_now
      AND s.idle_expires_at>v_now AND s.absolute_expires_at>v_now
      AND b.revoked_at IS NULL AND b.aal=p_aal AND b.permission_revision=o.permission_revision AND b.revoke_epoch=o.revoke_epoch
      AND b.expires_at>v_now AND b.absolute_expires_at>v_now;
END $$;

CREATE OR REPLACE FUNCTION console_shell.request_shell_session_teardown(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_permission_revision text,p_reason_code text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,false);
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.browser_session_id<>p_browser_session_id OR v_session.actor_id<>p_actor_id
    OR v_session.origin<>p_origin THEN RETURN; END IF;
  UPDATE console_shell.shell_session SET desired_state='Terminated',permission_revision=p_permission_revision,
    termination_requested_at=coalesce(termination_requested_at,v_now),updated_at=v_now
    WHERE session_id=p_session_id RETURNING * INTO v_session;
  UPDATE console_shell.shell_attach_ticket SET expires_at=least(expires_at,v_now)
    WHERE session_id=p_session_id AND consumed_at IS NULL AND expires_at>v_now;
  PERFORM console_shell.append_shell_session_event(p_session_id,'TeardownRequested','Succeeded',p_reason_code);
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console_shell.claim_shell_sessions(p_worker text,p_limit integer DEFAULT 5)
RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE;
BEGIN
  IF length(btrim(coalesce(p_worker,''))) NOT BETWEEN 3 AND 128 THEN RAISE EXCEPTION 'worker identity required'; END IF;
  FOR v_session IN WITH candidates AS (
    SELECT session_id FROM console_shell.shell_session
    WHERE observed_state<>'Terminated' AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
    ORDER BY CASE WHEN desired_state='Terminated' THEN 0 ELSE 1 END,updated_at,session_id
    FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(coalesce(p_limit,5),20))
  ) UPDATE console_shell.shell_session s SET lease_owner=p_worker,fencing_epoch=s.fencing_epoch+1,
    lease_expires_at=clock_timestamp()+interval '15 seconds',heartbeat_at=clock_timestamp(),
    updated_at=clock_timestamp()
  FROM candidates c WHERE s.session_id=c.session_id RETURNING s.*
  LOOP
    PERFORM console_shell.append_shell_session_event(v_session.session_id,'RuntimeClaimed','Succeeded','LeaseClaimed');
    RETURN NEXT v_session;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION console_shell.heartbeat_shell_session(
  p_session_id uuid,p_actor_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,
  p_permission_revision text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_affected integer;
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,false);
  UPDATE console_shell.shell_session s SET lease_expires_at=clock_timestamp()+interval '15 seconds',
    heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),
    desired_state=CASE WHEN s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM console_identity.browser_session b WHERE b.session_id=s.browser_session_id
        AND b.subject_id=s.actor_id AND b.revoked_at IS NULL AND b.expires_at>clock_timestamp()
        AND b.absolute_expires_at>clock_timestamp()) THEN 'Terminated' ELSE s.desired_state END,
    termination_requested_at=CASE WHEN s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM console_identity.browser_session b WHERE b.session_id=s.browser_session_id
        AND b.subject_id=s.actor_id AND b.revoked_at IS NULL AND b.expires_at>clock_timestamp()
        AND b.absolute_expires_at>clock_timestamp()) THEN coalesce(s.termination_requested_at,clock_timestamp()) ELSE s.termination_requested_at END
  WHERE session_id=p_session_id AND actor_id=p_actor_id AND lease_owner=p_worker
    AND generation=p_generation AND fencing_epoch=p_fencing_epoch
    AND permission_revision=p_permission_revision AND lease_expires_at>clock_timestamp()
    AND observed_state<>'Terminated';
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  RETURN v_affected=1;
END $$;

CREATE OR REPLACE FUNCTION console_shell.classify_shell_runtime_registration(
  p_session_id uuid,p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console_shell.shell_session
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
  SELECT * FROM console_shell.shell_session s WHERE s.session_id=p_session_id AND s.generation=p_generation
    AND s.fencing_epoch=p_fencing_epoch AND s.desired_state='Running' AND s.lease_expires_at>clock_timestamp()
    AND s.observed_state IN ('Pending','Provisioning','Ready')
$$;

CREATE OR REPLACE FUNCTION console_shell.resolve_shell_runtime_registration(
  p_session_id uuid,p_runtime_uid text,p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console_shell.shell_session
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
  SELECT * FROM console_shell.shell_session s WHERE s.session_id=p_session_id
    AND s.runtime_uid=p_runtime_uid AND s.generation=p_generation AND s.fencing_epoch=p_fencing_epoch
    AND s.desired_state='Running' AND s.observed_state='Provisioning'
    AND s.lease_expires_at>clock_timestamp() AND s.runtime_registered_at IS NULL
$$;

CREATE OR REPLACE FUNCTION console_shell.inspect_shell_claim(
  p_session_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console_shell.shell_session
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
  SELECT * FROM console_shell.shell_session s WHERE s.session_id=p_session_id AND s.lease_owner=p_worker
    AND s.generation=p_generation AND s.fencing_epoch=p_fencing_epoch
    AND s.lease_expires_at>clock_timestamp() AND s.observed_state<>'Terminated'
$$;

CREATE OR REPLACE FUNCTION console_shell.reproject_shell_runtime(
  p_session_id uuid,p_actor_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,
  p_expected_runtime_uid text,p_reason_code text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.actor_id<>p_actor_id OR v_session.lease_owner<>p_worker
    OR v_session.generation<>p_generation OR v_session.fencing_epoch<>p_fencing_epoch
    OR v_session.lease_expires_at<=v_now OR v_session.desired_state<>'Running'
    OR v_session.observed_state NOT IN ('Provisioning','Ready','Failed')
    OR v_session.runtime_uid IS DISTINCT FROM p_expected_runtime_uid THEN
    RAISE EXCEPTION 'runtime reprojection fence or deletion evidence changed' USING ERRCODE='40001';
  END IF;
  UPDATE console_shell.shell_session SET generation=generation+1,observed_state='Pending',runtime_uid=NULL,
    runtime_resource_version=NULL,observed_generation=NULL,runtime_key_id=NULL,runtime_public_key_pem=NULL,
    runtime_tls_certificate_sha256=NULL,runtime_attach_endpoint=NULL,runtime_credential_hash=NULL,
    runtime_credential_expires_at=NULL,runtime_registered_at=NULL,runtime_projection_started_at=NULL,
    last_error_code=NULL,updated_at=v_now
    WHERE session_id=p_session_id RETURNING * INTO v_session;
  UPDATE console_shell.shell_attach_ticket SET expires_at=least(expires_at,v_now)
    WHERE session_id=p_session_id AND runtime_authorized_at IS NULL AND expires_at>v_now;
  PERFORM console_shell.append_shell_session_event(p_session_id,'RuntimeReprojected','Succeeded',p_reason_code);
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console_shell.register_shell_runtime(
  p_session_id uuid,p_actor_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,
  p_permission_revision text,p_runtime_uid text,p_runtime_resource_version text,p_runtime_key_id text,
  p_runtime_public_key_pem text,p_runtime_tls_certificate_sha256 text,p_runtime_attach_endpoint text,
  p_runtime_credential_hash text,p_runtime_credential_expires_at timestamptz
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF FOUND AND v_session.runtime_registered_at IS NOT NULL THEN
    IF v_session.actor_id=p_actor_id AND v_session.lease_owner=p_worker
      AND v_session.lease_expires_at>v_now AND v_session.permission_revision=p_permission_revision
      AND v_session.generation=p_generation AND v_session.fencing_epoch=p_fencing_epoch
      AND v_session.runtime_uid=p_runtime_uid AND v_session.runtime_key_id=p_runtime_key_id
      AND v_session.runtime_public_key_pem=p_runtime_public_key_pem
      AND v_session.runtime_tls_certificate_sha256=p_runtime_tls_certificate_sha256
      AND v_session.runtime_attach_endpoint=p_runtime_attach_endpoint
      AND v_session.runtime_credential_hash=p_runtime_credential_hash
      AND v_session.runtime_credential_expires_at>v_now AND v_session.desired_state='Running'
      AND v_session.observed_state IN ('Provisioning','Ready') THEN RETURN NEXT v_session; RETURN; END IF;
    RAISE EXCEPTION 'runtime registration replay changed immutable binding' USING ERRCODE='40001';
  END IF;
  IF NOT FOUND OR v_session.actor_id<>p_actor_id OR v_session.lease_owner<>p_worker
    OR v_session.generation<>p_generation OR v_session.fencing_epoch<>p_fencing_epoch
    OR v_session.lease_expires_at<=v_now OR v_session.permission_revision<>p_permission_revision
    OR v_session.runtime_uid<>p_runtime_uid OR v_session.observed_state<>'Provisioning'
    OR v_session.desired_state<>'Running' OR v_session.runtime_registered_at IS NOT NULL THEN
    RAISE EXCEPTION 'runtime registration fence was lost or already consumed' USING ERRCODE='40001';
  END IF;
  IF p_runtime_tls_certificate_sha256!~'^sha256:[a-f0-9]{64}$'
    OR p_runtime_attach_endpoint!~'^wss://[^/?#]+:8443/v1/runtime/attach$'
    OR p_runtime_credential_hash!~'^sha256:[a-f0-9]{64}$'
    OR p_runtime_credential_expires_at<=v_now OR p_runtime_credential_expires_at>least(v_session.absolute_expires_at,v_now+interval '60 minutes') THEN
    RAISE EXCEPTION 'runtime registration material is invalid';
  END IF;
  UPDATE console_shell.shell_session SET runtime_resource_version=p_runtime_resource_version,
    runtime_key_id=p_runtime_key_id,runtime_public_key_pem=p_runtime_public_key_pem,
    runtime_tls_certificate_sha256=p_runtime_tls_certificate_sha256,
    runtime_attach_endpoint=p_runtime_attach_endpoint,runtime_credential_hash=p_runtime_credential_hash,
    runtime_credential_expires_at=p_runtime_credential_expires_at,runtime_registered_at=v_now,
    updated_at=v_now WHERE session_id=p_session_id RETURNING * INTO v_session;
  PERFORM console_shell.append_shell_session_event(p_session_id,'RuntimeRegistered','Succeeded','BootstrapTokenReviewed');
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console_shell.revoke_shell_session_authority(
  p_session_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,p_reason_code text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp(); v_revision text;
BEGIN
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.lease_owner<>p_worker OR v_session.generation<>p_generation
    OR v_session.fencing_epoch<>p_fencing_epoch OR v_session.lease_expires_at<=v_now
    OR v_session.observed_state='Terminated' THEN
    RAISE EXCEPTION 'shell authority revocation fence was lost' USING ERRCODE='40001';
  END IF;
  v_revision:=console_shell.current_shell_permission_revision(v_session.actor_id);
  UPDATE console_shell.shell_session SET desired_state='Terminated',permission_revision=v_revision,
    termination_requested_at=coalesce(termination_requested_at,v_now),updated_at=v_now
    WHERE session_id=p_session_id RETURNING * INTO v_session;
  UPDATE console_shell.shell_attach_ticket SET expires_at=least(expires_at,v_now)
    WHERE session_id=p_session_id AND runtime_authorized_at IS NULL AND expires_at>v_now;
  PERFORM console_shell.append_shell_session_event(p_session_id,'PolicyDenied','Denied',p_reason_code);
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console_shell.transition_shell_session(
  p_session_id uuid,p_actor_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,
  p_expected_state text,p_next_state text,p_permission_revision text,p_runtime_uid text,
  p_runtime_resource_version text,p_reason_code text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_valid boolean; v_now timestamptz:=clock_timestamp(); v_event text;
BEGIN
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,false);
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.actor_id<>p_actor_id OR v_session.lease_owner<>p_worker
    OR v_session.generation<>p_generation OR v_session.fencing_epoch<>p_fencing_epoch
    OR v_session.lease_expires_at<=v_now OR v_session.observed_state<>p_expected_state THEN
    RAISE EXCEPTION 'shell claim, generation, epoch, lease, or expected state was lost' USING ERRCODE='40001';
  END IF;
  IF v_session.permission_revision<>p_permission_revision AND p_next_state NOT IN ('Terminating','Terminated') THEN
    RAISE EXCEPTION 'shell permission revision changed before runtime transition' USING ERRCODE='40001';
  END IF;
  v_valid:=CASE p_expected_state
    WHEN 'Pending' THEN p_next_state IN ('Provisioning','Terminating','Failed')
    WHEN 'Provisioning' THEN p_next_state IN ('Ready','Terminating','Failed')
    WHEN 'Ready' THEN p_next_state IN ('Terminating','Failed')
    WHEN 'Failed' THEN p_next_state IN ('Terminating','Terminated')
    WHEN 'Terminating' THEN p_next_state IN ('Terminated','Failed')
    ELSE false END;
  IF NOT v_valid THEN RAISE EXCEPTION 'invalid shell transition % -> %',p_expected_state,p_next_state; END IF;
  IF p_next_state='Ready' AND v_session.desired_state<>'Running' THEN
    RAISE EXCEPTION 'terminated shell intent cannot become Ready' USING ERRCODE='40001';
  END IF;
  IF p_next_state='Ready' AND v_session.runtime_registered_at IS NULL THEN
    RAISE EXCEPTION 'runtime cannot become Ready before fenced registration' USING ERRCODE='40001';
  END IF;
  IF v_session.runtime_uid IS NOT NULL AND p_runtime_uid IS NOT NULL
    AND v_session.runtime_uid<>p_runtime_uid THEN
    RAISE EXCEPTION 'runtime UID binding changed' USING ERRCODE='40001';
  END IF;
  UPDATE console_shell.shell_session SET observed_state=p_next_state,
    desired_state=CASE WHEN p_next_state IN ('Terminating','Terminated') THEN 'Terminated' ELSE desired_state END,
    permission_revision=p_permission_revision,
    runtime_uid=coalesce(runtime_uid,p_runtime_uid),
    runtime_resource_version=coalesce(p_runtime_resource_version,runtime_resource_version),
    observed_generation=greatest(coalesce(observed_generation,0),p_generation),
    runtime_projection_started_at=CASE WHEN p_next_state='Provisioning' THEN v_now ELSE runtime_projection_started_at END,
    termination_requested_at=CASE WHEN p_next_state IN ('Terminating','Terminated')
      THEN coalesce(termination_requested_at,v_now) ELSE termination_requested_at END,
    terminated_at=CASE WHEN p_next_state='Terminated' THEN v_now ELSE NULL END,
    last_error_code=CASE WHEN p_next_state='Failed' THEN p_reason_code ELSE last_error_code END,
    lease_owner=CASE WHEN p_next_state IN ('Terminated','Failed') THEN NULL ELSE lease_owner END,
    lease_expires_at=CASE WHEN p_next_state IN ('Terminated','Failed') THEN NULL ELSE lease_expires_at END,
    heartbeat_at=CASE WHEN p_next_state IN ('Terminated','Failed') THEN NULL ELSE heartbeat_at END,
    updated_at=v_now WHERE session_id=p_session_id RETURNING * INTO v_session;
  v_event:=CASE p_next_state WHEN 'Provisioning' THEN 'RuntimeProvisioning' WHEN 'Ready' THEN 'RuntimeReady'
    WHEN 'Terminating' THEN 'RuntimeTerminating' WHEN 'Terminated' THEN 'SessionTerminated'
    ELSE 'SessionFailed' END;
  PERFORM console_shell.append_shell_session_event(p_session_id,v_event,
    CASE WHEN p_next_state='Failed' THEN 'Failed' ELSE 'Succeeded' END,p_reason_code);
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console_shell.reject_shell_control_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,console_shell AS $$
BEGIN
  RAISE EXCEPTION 'console_shell.shell_control_event is append-only';
END $$;

CREATE OR REPLACE FUNCTION console_shell.get_shell_feature_state()
RETURNS TABLE(enabled boolean,revision bigint,actor_active_limit integer,global_active_limit integer,
  reason text,changed_by uuid,changed_at timestamptz,drain_completed_at timestamptz,
  active_sessions bigint,active_tickets bigint,scale_down_allowed boolean,
  operation_id uuid,operation_kind text,operation_phase text,operation_identity text,
  operation_started_at timestamptz,operation_completed_at timestamptz,scale_claim_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_state console_shell.shell_control_state%ROWTYPE; v_active bigint; v_tickets bigint; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO v_state FROM console_shell.shell_control_state WHERE singleton=true FOR UPDATE;
  SELECT count(*) INTO v_active FROM console_shell.shell_session
    WHERE desired_state='Running' OR observed_state<>'Terminated';
  IF NOT v_state.enabled AND v_active=0 AND v_state.drain_completed_at IS NULL THEN
    UPDATE console_shell.shell_control_state SET drain_completed_at=v_now WHERE singleton=true RETURNING * INTO v_state;
    INSERT INTO console_shell.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
      VALUES(v_state.revision,false,'DrainCompleted','All fenced shell runtimes reached Terminated',v_state.changed_by,
        v_state.changed_identity,v_state.operation_evidence,0);
  END IF;
  SELECT count(*) INTO v_tickets FROM console_shell.shell_attach_ticket
    WHERE consumed_at IS NULL AND expires_at>v_now;
  RETURN QUERY SELECT v_state.enabled,v_state.revision,v_state.actor_active_limit,v_state.global_active_limit,
    v_state.reason,v_state.changed_by,v_state.changed_at,v_state.drain_completed_at,v_active,
    v_tickets,(NOT v_state.enabled AND v_active=0 AND v_tickets=0 AND v_state.drain_completed_at IS NOT NULL),
    v_state.operation_id,v_state.operation_kind,v_state.operation_phase,v_state.operation_identity,
    v_state.operation_started_at,v_state.operation_completed_at,v_state.scale_claim_expires_at;
END $$;

CREATE OR REPLACE FUNCTION console_shell.apply_shell_feature_state(
  p_enabled boolean,p_expected_revision bigint,p_reason text,p_actor_id uuid,
  p_actor_identity text,p_operation_evidence jsonb
) RETURNS SETOF console_shell.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_state console_shell.shell_control_state%ROWTYPE; v_affected integer:=0; v_active bigint; v_tickets bigint;
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_enabled IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1
    OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 8 AND 512
    OR length(btrim(coalesce(p_actor_identity,''))) NOT BETWEEN 3 AND 256
    OR jsonb_typeof(p_operation_evidence)<>'object' THEN
    RAISE EXCEPTION 'ShellFeatureOperationInvalid';
  END IF;
  SELECT * INTO v_state FROM console_shell.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'ShellFeatureRevisionConflict' USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO v_active FROM console_shell.shell_session
    WHERE desired_state='Running' OR observed_state<>'Terminated';
  SELECT count(*) INTO v_tickets FROM console_shell.shell_attach_ticket
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
  UPDATE console_shell.shell_control_state SET enabled=p_enabled,revision=revision+1,reason=btrim(p_reason),
    changed_by=p_actor_id,changed_identity=btrim(p_actor_identity),operation_evidence=p_operation_evidence,
    changed_at=v_now,drain_completed_at=NULL
    WHERE singleton=true RETURNING * INTO v_state;
  IF NOT p_enabled THEN
    UPDATE console_shell.shell_session SET desired_state='Terminated',
      termination_requested_at=coalesce(termination_requested_at,v_now),updated_at=v_now
      WHERE observed_state<>'Terminated' AND desired_state='Running';
    GET DIAGNOSTICS v_affected=ROW_COUNT;
    UPDATE console_shell.shell_attach_ticket SET expires_at=least(expires_at,v_now)
      WHERE consumed_at IS NULL AND expires_at>v_now;
    INSERT INTO console_shell.shell_session_event(
      session_id,actor_id,session_class,runtime_adapter_id,generation,fencing_epoch,
      event_type,result,reason_code,origin,permission_revision,aal,release_evidence_ref,
      manifest_sha256,key_id,runtime_image_digest,os_artifact_digest,session_policy_revision
    ) SELECT session_id,actor_id,session_class,runtime_adapter_id,generation,fencing_epoch,
      'PolicyDenied','Denied','ShellFeatureDisabled',origin,permission_revision,aal,release_evidence_ref,
      manifest_sha256,key_id,runtime_image_digest,os_artifact_digest,session_policy_revision
      FROM console_shell.shell_session WHERE observed_state<>'Terminated' AND termination_requested_at=v_now;
  END IF;
  INSERT INTO console_shell.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
    VALUES(v_state.revision,p_enabled,CASE WHEN p_enabled THEN 'Enabled' ELSE 'DisableRequested' END,
      btrim(p_reason),p_actor_id,btrim(p_actor_identity),p_operation_evidence,v_affected);
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console_shell.set_shell_feature_state(
  p_enabled boolean,p_expected_revision bigint,p_reason text,p_actor_id uuid
) RETURNS SETOF console_shell.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_state console_shell.shell_control_state%ROWTYPE;
BEGIN
  IF p_enabled THEN
    RAISE EXCEPTION 'ShellFeatureBrowserEnableRequiresVerifiedRelease'
      USING ERRCODE='28000',HINT='Use the signed release-controller enable workflow after exact component readiness.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM console_identity.subject_authority WHERE subject_id=p_actor_id) THEN
    RAISE EXCEPTION 'ShellFeatureActorInvalid' USING ERRCODE='28000';
  END IF;
  SELECT * INTO v_state FROM console_shell.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.operation_phase IN ('Draining','ScaleDownClaimed') THEN
    RAISE EXCEPTION 'ShellFeatureOperationConflict' USING ERRCODE='40001';
  END IF;
  PERFORM * FROM console_shell.apply_shell_feature_state(false,p_expected_revision,p_reason,p_actor_id,
    'operator:'||p_actor_id::text,jsonb_build_object('authority','browser-aal2'));
  UPDATE console_shell.shell_control_state SET operation_id=NULL,operation_kind=NULL,operation_phase=NULL,
    operation_identity=NULL,operation_started_at=NULL,operation_completed_at=NULL,
    scale_claim_token=NULL,scale_claim_expires_at=NULL WHERE singleton=true RETURNING * INTO v_state;
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console_shell.set_shell_feature_state_local_edge(
  p_enabled boolean,p_expected_revision bigint,p_reason text,p_actor_identity text,p_operation_evidence jsonb,
  p_operation_id uuid
) RETURNS SETOF console_shell.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE
  v_state console_shell.shell_control_state%ROWTYPE;
  v_now timestamptz:=clock_timestamp();
  v_latest_migration_id text;
  v_latest_source_revision text;
BEGIN
  SELECT split_part(global_id,'/',3),source_revision
    INTO v_latest_migration_id,v_latest_source_revision
    FROM console_migration.applied_migration
    ORDER BY applied_sequence DESC
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
    OR p_operation_evidence->>'migrationSetDigest' IS DISTINCT FROM (SELECT migration_set_digest FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1)
    OR p_operation_evidence->>'latestMigrationId' IS DISTINCT FROM v_latest_migration_id
    OR p_operation_evidence->>'sourceRevision' IS DISTINCT FROM v_latest_source_revision THEN
    RAISE EXCEPTION 'ShellFeatureLocalEdgeEvidenceInvalid' USING ERRCODE='28000';
  END IF;

  SELECT * INTO v_state FROM console_shell.shell_control_state WHERE singleton=true FOR UPDATE;
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
  PERFORM * FROM console_shell.apply_shell_feature_state(p_enabled,p_expected_revision,p_reason,NULL,
    p_actor_identity,p_operation_evidence);
  UPDATE console_shell.shell_control_state SET operation_id=p_operation_id,
    operation_kind=CASE WHEN p_enabled THEN 'Enable' ELSE 'Disable' END,
    operation_phase=CASE WHEN p_enabled THEN 'Completed' ELSE 'Draining' END,
    operation_identity=p_actor_identity,operation_started_at=v_now,
    operation_completed_at=CASE WHEN p_enabled THEN v_now ELSE NULL END,
    scale_claim_token=NULL,scale_claim_expires_at=NULL
    WHERE singleton=true RETURNING * INTO v_state;
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console_shell.claim_shell_feature_scale_down(
  p_operation_id uuid,p_expected_revision bigint,p_actor_identity text,
  p_scale_claim_token uuid,p_lease_seconds integer DEFAULT 120
) RETURNS SETOF console_shell.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_state console_shell.shell_control_state%ROWTYPE; v_active bigint; v_tickets bigint; v_now timestamptz:=clock_timestamp();
  v_emit_claim boolean:=false;
BEGIN
  IF p_operation_id IS NULL OR p_scale_claim_token IS NULL OR p_expected_revision<1
    OR p_actor_identity<>'system:serviceaccount:opensphere-console:opensphere-local-edge-release'
    OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'ShellFeatureScaleDownClaimInvalid' USING ERRCODE='28000';
  END IF;
  SELECT * INTO v_state FROM console_shell.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.revision<>p_expected_revision OR v_state.enabled
    OR v_state.operation_id<>p_operation_id OR v_state.operation_kind<>'Disable'
    OR v_state.operation_identity<>p_actor_identity OR v_state.operation_phase NOT IN ('Draining','ScaleDownClaimed') THEN
    RAISE EXCEPTION 'ShellFeatureScaleDownFenceLost' USING ERRCODE='40001';
  END IF;
  SELECT count(*) INTO v_active FROM console_shell.shell_session
    WHERE desired_state='Running' OR observed_state<>'Terminated';
  SELECT count(*) INTO v_tickets FROM console_shell.shell_attach_ticket
    WHERE consumed_at IS NULL AND expires_at>v_now;
  IF v_active<>0 OR v_tickets<>0 THEN RAISE EXCEPTION 'ShellFeatureDrainIncomplete' USING ERRCODE='40001'; END IF;
  IF v_state.drain_completed_at IS NULL THEN
    UPDATE console_shell.shell_control_state SET drain_completed_at=v_now WHERE singleton=true RETURNING * INTO v_state;
    INSERT INTO console_shell.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
      VALUES(v_state.revision,false,'DrainCompleted','All fenced shell runtimes reached Terminated',v_state.changed_by,
        v_state.changed_identity,v_state.operation_evidence,0);
  END IF;
  IF v_state.operation_phase='ScaleDownClaimed' AND v_state.scale_claim_token<>p_scale_claim_token
    AND v_state.scale_claim_expires_at>v_now THEN
    RAISE EXCEPTION 'ShellFeatureScaleDownClaimHeld' USING ERRCODE='40001';
  END IF;
  v_emit_claim:=v_state.operation_phase<>'ScaleDownClaimed' OR v_state.scale_claim_token IS DISTINCT FROM p_scale_claim_token;
  UPDATE console_shell.shell_control_state SET operation_phase='ScaleDownClaimed',scale_claim_token=p_scale_claim_token,
    scale_claim_expires_at=v_now+make_interval(secs=>p_lease_seconds),operation_completed_at=NULL
    WHERE singleton=true RETURNING * INTO v_state;
  IF v_emit_claim THEN
    INSERT INTO console_shell.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
      VALUES(v_state.revision,false,'ScaleDownClaimed','Exclusive fenced scale-down claim acquired',v_state.changed_by,
        v_state.changed_identity,v_state.operation_evidence,0);
  END IF;
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console_shell.complete_shell_feature_scale_down(
  p_operation_id uuid,p_expected_revision bigint,p_actor_identity text,p_scale_claim_token uuid
) RETURNS SETOF console_shell.shell_control_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_state console_shell.shell_control_state%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO v_state FROM console_shell.shell_control_state WHERE singleton=true FOR UPDATE;
  IF v_state.revision<>p_expected_revision OR v_state.enabled OR v_state.operation_id<>p_operation_id
    OR v_state.operation_kind<>'Disable' OR v_state.operation_identity<>p_actor_identity
    OR v_state.operation_phase<>'ScaleDownClaimed' OR v_state.scale_claim_token<>p_scale_claim_token
    OR v_state.scale_claim_expires_at<=v_now THEN
    RAISE EXCEPTION 'ShellFeatureScaleDownFenceLost' USING ERRCODE='40001';
  END IF;
  UPDATE console_shell.shell_control_state SET operation_phase='Completed',operation_completed_at=v_now,
    scale_claim_token=NULL,scale_claim_expires_at=NULL WHERE singleton=true RETURNING * INTO v_state;
  INSERT INTO console_shell.shell_control_event(revision,enabled,event_type,reason,actor_id,actor_identity,operation_evidence,affected_sessions)
    VALUES(v_state.revision,false,'ScaleDownCompleted','Exact control workloads reached replicas zero',v_state.changed_by,
      v_state.changed_identity,v_state.operation_evidence,0);
  RETURN NEXT v_state;
END $$;

CREATE OR REPLACE FUNCTION console_shell.touch_shell_session_activity(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text
) RETURNS SETOF console_shell.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE v_session console_shell.shell_session%ROWTYPE; v_browser console_identity.browser_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  IF NOT console_shell.shell_feature_enabled() THEN RETURN; END IF;
  PERFORM console_shell.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_session FROM console_shell.shell_session WHERE session_id=p_session_id FOR UPDATE;
  SELECT * INTO v_browser FROM console_identity.browser_session
    WHERE session_id=p_browser_session_id AND subject_id=p_actor_id FOR SHARE;
  IF v_session.session_id IS NULL OR v_browser.session_id IS NULL
    OR v_session.browser_session_id<>p_browser_session_id OR v_session.actor_id<>p_actor_id
    OR v_session.origin<>p_origin OR v_session.generation<>p_generation
    OR v_session.fencing_epoch<>p_fencing_epoch OR v_session.aal<>p_aal
    OR v_session.permission_revision<>p_permission_revision OR v_session.desired_state<>'Running'
    OR v_session.observed_state<>'Ready' OR v_session.absolute_expires_at<=v_now
    OR v_browser.revoked_at IS NOT NULL OR v_browser.aal<>p_aal
    OR v_browser.expires_at<=v_now OR v_browser.absolute_expires_at<=v_now THEN RETURN; END IF;
  UPDATE console_shell.shell_session SET last_activity_at=v_now,
    idle_expires_at=least(v_now+interval '15 minutes',absolute_expires_at,
      v_browser.expires_at,v_browser.absolute_expires_at),updated_at=v_now
    WHERE session_id=p_session_id RETURNING * INTO v_session;
  RETURN NEXT v_session;
END $$;

DROP TRIGGER IF EXISTS shell_session_event_append_only ON console_shell.shell_session_event;

CREATE TRIGGER shell_session_event_append_only
  BEFORE UPDATE OR DELETE ON console_shell.shell_session_event
  FOR EACH ROW EXECUTE FUNCTION console_shell.reject_shell_session_event_mutation();

ALTER TABLE console_shell.shell_session_event ENABLE ALWAYS TRIGGER shell_session_event_append_only;

DROP TRIGGER IF EXISTS shell_session_event_no_truncate ON console_shell.shell_session_event;

CREATE TRIGGER shell_session_event_no_truncate
  BEFORE TRUNCATE ON console_shell.shell_session_event
  FOR EACH STATEMENT EXECUTE FUNCTION console_shell.reject_shell_session_event_mutation();

ALTER TABLE console_shell.shell_session_event ENABLE ALWAYS TRIGGER shell_session_event_no_truncate;

DROP TRIGGER IF EXISTS shell_session_monotonic_guard ON console_shell.shell_session;

CREATE TRIGGER shell_session_monotonic_guard
  BEFORE UPDATE ON console_shell.shell_session
  FOR EACH ROW EXECUTE FUNCTION console_shell.guard_shell_session_mutation();

ALTER TABLE console_shell.shell_session ENABLE ALWAYS TRIGGER shell_session_monotonic_guard;

ALTER TABLE console_shell.shell_session ENABLE ROW LEVEL SECURITY;

ALTER TABLE console_shell.shell_attach_ticket ENABLE ROW LEVEL SECURITY;

ALTER TABLE console_shell.shell_session_event ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE console_shell.shell_session,console_shell.shell_attach_ticket,console_shell.shell_session_event
  FROM PUBLIC,anon,authenticated,service_role,authenticator,console_api,
    opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;

REVOKE ALL ON SEQUENCE console_shell.shell_session_event_event_id_seq
  FROM PUBLIC,anon,authenticated,service_role,authenticator,console_api,
    opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;

REVOKE ALL ON FUNCTION console_shell.current_shell_permission_revision(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.shell_actor_has_permission(uuid,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.assert_shell_authority(uuid,text,boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.append_shell_session_event(uuid,text,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.create_shell_session(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.get_shell_session(uuid,uuid,uuid,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.list_shell_sessions(uuid,uuid,text,integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.issue_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.resolve_shell_attach_binding(text,uuid,uuid,uuid,text,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.consume_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.revalidate_shell_session(uuid,uuid,uuid,text,bigint,bigint,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.authorize_shell_runtime_attach(text,text,uuid,text,bigint,bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.revalidate_shell_runtime(text,uuid,text,bigint,bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.resolve_shell_delegation(uuid,uuid,bigint,bigint,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.request_shell_session_teardown(uuid,uuid,uuid,text,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.claim_shell_sessions(text,integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.heartbeat_shell_session(uuid,uuid,text,bigint,bigint,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.resolve_shell_runtime_registration(uuid,text,bigint,bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.classify_shell_runtime_registration(uuid,bigint,bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.inspect_shell_claim(uuid,text,bigint,bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.reproject_shell_runtime(uuid,uuid,text,bigint,bigint,text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.register_shell_runtime(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text,text,text,timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.revoke_shell_session_authority(uuid,text,bigint,bigint,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.transition_shell_session(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text) FROM PUBLIC;

GRANT USAGE ON SCHEMA console_shell TO opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;

GRANT EXECUTE ON FUNCTION console_shell.current_shell_permission_revision(uuid)
  TO opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;

GRANT EXECUTE ON FUNCTION console_shell.create_shell_session(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,jsonb),
  console_shell.get_shell_session(uuid,uuid,uuid,text),
  console_shell.list_shell_sessions(uuid,uuid,text,integer),
  console_shell.issue_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,timestamptz),
  console_shell.request_shell_session_teardown(uuid,uuid,uuid,text,text,text)
  TO opensphere_shell_api;

GRANT EXECUTE ON FUNCTION console_shell.consume_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,text),
  console_shell.resolve_shell_attach_binding(text,uuid,uuid,uuid,text,text,text),
  console_shell.revalidate_shell_session(uuid,uuid,uuid,text,bigint,bigint,text,text)
  TO opensphere_shell_gateway;

GRANT EXECUTE ON FUNCTION console_shell.authorize_shell_runtime_attach(text,text,uuid,text,bigint,bigint),
  console_shell.revalidate_shell_runtime(text,uuid,text,bigint,bigint)
  TO opensphere_shell_api;

GRANT EXECUTE ON FUNCTION console_shell.resolve_shell_delegation(uuid,uuid,bigint,bigint,text,text)
  TO console_api;

GRANT EXECUTE ON FUNCTION console_shell.claim_shell_sessions(text,integer),
  console_shell.heartbeat_shell_session(uuid,uuid,text,bigint,bigint,text),
  console_shell.resolve_shell_runtime_registration(uuid,text,bigint,bigint),
  console_shell.classify_shell_runtime_registration(uuid,bigint,bigint),
  console_shell.inspect_shell_claim(uuid,text,bigint,bigint),
  console_shell.reproject_shell_runtime(uuid,uuid,text,bigint,bigint,text,text),
  console_shell.register_shell_runtime(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text,text,text,timestamptz),
  console_shell.revoke_shell_session_authority(uuid,text,bigint,bigint,text),
  console_shell.transition_shell_session(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text)
  TO opensphere_shell_reconciler;

CREATE TRIGGER shell_control_event_append_only
  BEFORE UPDATE OR DELETE ON console_shell.shell_control_event
  FOR EACH ROW EXECUTE FUNCTION console_shell.reject_shell_control_event_mutation();

ALTER TABLE console_shell.shell_control_event ENABLE ALWAYS TRIGGER shell_control_event_append_only;

CREATE TRIGGER shell_control_event_no_truncate
  BEFORE TRUNCATE ON console_shell.shell_control_event
  FOR EACH STATEMENT EXECUTE FUNCTION console_shell.reject_shell_control_event_mutation();

ALTER TABLE console_shell.shell_control_event ENABLE ALWAYS TRIGGER shell_control_event_no_truncate;

ALTER TABLE console_shell.shell_control_state ENABLE ROW LEVEL SECURITY;

ALTER TABLE console_shell.shell_control_event ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE console_shell.shell_control_state,console_shell.shell_control_event
  FROM PUBLIC,anon,authenticated,service_role,authenticator,console_api,
    opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;

REVOKE ALL ON SEQUENCE console_shell.shell_control_event_event_id_seq
  FROM PUBLIC,anon,authenticated,service_role,authenticator,console_api,
    opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;

REVOKE ALL ON FUNCTION console_shell.shell_feature_enabled() FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.get_shell_feature_state() FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.set_shell_feature_state(boolean,bigint,text,uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.apply_shell_feature_state(boolean,bigint,text,uuid,text,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.set_shell_feature_state_local_edge(boolean,bigint,text,text,jsonb,uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.claim_shell_feature_scale_down(uuid,bigint,text,uuid,integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.complete_shell_feature_scale_down(uuid,bigint,text,uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION console_shell.touch_shell_session_activity(uuid,uuid,uuid,text,bigint,bigint,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION console_shell.shell_feature_enabled()
  TO opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler,console_api;

GRANT EXECUTE ON FUNCTION console_shell.get_shell_feature_state()
  TO opensphere_shell_api,opensphere_shell_reconciler,console_api;

GRANT EXECUTE ON FUNCTION console_shell.set_shell_feature_state(boolean,bigint,text,uuid)
  TO console_api;

GRANT EXECUTE ON FUNCTION console_shell.set_shell_feature_state_local_edge(boolean,bigint,text,text,jsonb,uuid)
  TO console_api;

GRANT EXECUTE ON FUNCTION console_shell.claim_shell_feature_scale_down(uuid,bigint,text,uuid,integer)
  TO console_api;

GRANT EXECUTE ON FUNCTION console_shell.complete_shell_feature_scale_down(uuid,bigint,text,uuid)
  TO console_api;

GRANT EXECUTE ON FUNCTION console_shell.touch_shell_session_activity(uuid,uuid,uuid,text,bigint,bigint,text,text)
  TO opensphere_shell_gateway;

COMMENT ON FUNCTION console_shell.set_shell_feature_state_local_edge(boolean,bigint,text,text,jsonb,uuid) IS
  'Release-only OS Shell gate owner; evidence must match the actual latest append-only migration ID and source revision.';

-- Current C_API projection: no browser tokens, password material or runtime bearer hashes.
CREATE FUNCTION console_shell.resolve_native_shell_authority(
 p_session_id uuid,p_actor_id uuid,p_generation bigint,p_fencing_epoch bigint,p_permission_revision text,p_aal text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s console_shell.shell_session; b console_identity.browser_session; a console_identity.subject_authority; permissions jsonb;
BEGIN
 SELECT * INTO s FROM console_shell.resolve_shell_delegation(p_session_id,p_actor_id,p_generation,p_fencing_epoch,p_permission_revision,p_aal);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO b FROM console_identity.browser_session WHERE session_id=s.browser_session_id AND subject_id=s.actor_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO a FROM console_identity.subject_authority WHERE subject_id=s.actor_id;
 SELECT coalesce(jsonb_agg(permission ORDER BY permission COLLATE "C"),'[]'::jsonb) INTO permissions
 FROM (SELECT DISTINCT permission FROM console_identity.permission_grant WHERE subject_id=s.actor_id
   AND grant_revision<=a.permission_revision AND revoked_at IS NULL) AS grants;
 RETURN jsonb_build_object(
  'binding',jsonb_build_object('sessionId',s.session_id,'actorId',s.actor_id,'origin',s.origin,
    'sessionClass',s.session_class,'runtimeAdapterId',s.runtime_adapter_id,'networkProfile',s.network_profile,
    'runtimeUid',s.runtime_uid,'permissionRevision',s.permission_revision,'aal',s.aal,
    'releaseEvidenceRef',s.release_evidence_ref,'generation',s.generation,'fencingEpoch',s.fencing_epoch),
  'runtimePublicKeyPem',s.runtime_public_key_pem,
  'credentialExpiresAt',least(s.runtime_credential_expires_at,s.idle_expires_at,s.absolute_expires_at,b.expires_at,b.absolute_expires_at),
  'session',jsonb_build_object('sessionId',b.session_id,'subjectId',b.subject_id,
    'expiresAt',b.expires_at,'idleExpiresAt',b.expires_at,'absoluteExpiresAt',b.absolute_expires_at,
    'persistence',b.persistence,'revokedAt',b.revoked_at,'authorityFresh',true,'permissions',permissions,
    'permissionRevision',a.permission_revision::text,'revokeEpoch',a.revoke_epoch::text,'aal',b.aal));
END $$;
REVOKE ALL ON FUNCTION console_shell.resolve_native_shell_authority(uuid,uuid,bigint,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_shell.resolve_native_shell_authority(uuid,uuid,bigint,bigint,text,text) TO console_api;