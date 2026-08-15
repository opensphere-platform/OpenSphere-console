\set ON_ERROR_STOP on

BEGIN;

-- CBSS is the durable lifecycle authority. Kubernetes resources are fenced
-- projections only, and every runtime component receives EXECUTE on a closed
-- RPC surface instead of table DML.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'opensphere_shell_api', 'opensphere_shell_gateway', 'opensphere_shell_reconciler'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      RAISE EXCEPTION 'required shell database role % was not provisioned before migration 0061', role_name;
    END IF;
  END LOOP;
END $$;

INSERT INTO console.permission(code,risk_level) VALUES ('session:attach','high')
ON CONFLICT(code) DO UPDATE SET risk_level=EXCLUDED.risk_level;

INSERT INTO console.role_permission(role_id,permission_id)
SELECT r.id,p.id FROM console.role r JOIN console.permission p ON p.code='session:attach'
WHERE r.code IN ('console-admins','console-operators')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS console.shell_session (
  session_id uuid PRIMARY KEY,
  browser_session_id uuid NOT NULL REFERENCES console.browser_session(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS shell_session_actor_active_idx
  ON console.shell_session(actor_id,updated_at DESC) WHERE observed_state<>'Terminated';
CREATE INDEX IF NOT EXISTS shell_session_reconcile_idx
  ON console.shell_session(lease_expires_at,updated_at)
  WHERE observed_state<>'Terminated';

CREATE TABLE IF NOT EXISTS console.shell_attach_ticket (
  ticket_hash text PRIMARY KEY CHECK(ticket_hash~'^sha256:[a-f0-9]{64}$'),
  session_id uuid NOT NULL REFERENCES console.shell_session(session_id) ON DELETE RESTRICT,
  browser_session_id uuid NOT NULL REFERENCES console.browser_session(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS shell_attach_ticket_unconsumed_idx
  ON console.shell_attach_ticket(expires_at,session_id) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS console.shell_session_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES console.shell_session(session_id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS shell_session_event_session_idx
  ON console.shell_session_event(session_id,event_id);

CREATE OR REPLACE FUNCTION console.reject_shell_session_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,console AS $$
BEGIN
  RAISE EXCEPTION 'console.shell_session_event is append-only';
END $$;

DROP TRIGGER IF EXISTS shell_session_event_append_only ON console.shell_session_event;
CREATE TRIGGER shell_session_event_append_only
  BEFORE UPDATE OR DELETE ON console.shell_session_event
  FOR EACH ROW EXECUTE FUNCTION console.reject_shell_session_event_mutation();
ALTER TABLE console.shell_session_event ENABLE ALWAYS TRIGGER shell_session_event_append_only;

DROP TRIGGER IF EXISTS shell_session_event_no_truncate ON console.shell_session_event;
CREATE TRIGGER shell_session_event_no_truncate
  BEFORE TRUNCATE ON console.shell_session_event
  FOR EACH STATEMENT EXECUTE FUNCTION console.reject_shell_session_event_mutation();
ALTER TABLE console.shell_session_event ENABLE ALWAYS TRIGGER shell_session_event_no_truncate;

CREATE OR REPLACE FUNCTION console.guard_shell_session_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,console AS $$
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

DROP TRIGGER IF EXISTS shell_session_monotonic_guard ON console.shell_session;
CREATE TRIGGER shell_session_monotonic_guard
  BEFORE UPDATE ON console.shell_session
  FOR EACH ROW EXECUTE FUNCTION console.guard_shell_session_mutation();
ALTER TABLE console.shell_session ENABLE ALWAYS TRIGGER shell_session_monotonic_guard;

CREATE OR REPLACE FUNCTION console.current_shell_permission_revision(p_actor_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE
  v_credential_revision bigint;
  v_roles text;
  v_permissions text;
  v_payload text;
  v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT credential_revision INTO v_credential_revision
  FROM console.operator WHERE user_id=p_actor_id AND status='active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shell actor is inactive or unknown' USING ERRCODE='28000';
  END IF;
  SELECT coalesce(string_agg(code,E'\x1f' ORDER BY code COLLATE "C"),'') INTO v_roles
  FROM (
    SELECT DISTINCT r.code FROM console.operator_role ur
    JOIN console.role r ON r.id=ur.role_id
    WHERE ur.user_id=p_actor_id AND (ur.expires_at IS NULL OR ur.expires_at>v_now)
  ) role_codes;
  SELECT coalesce(string_agg(code,E'\x1f' ORDER BY code COLLATE "C"),'') INTO v_permissions
  FROM (
    SELECT DISTINCT p.code FROM console.operator_role ur
    JOIN console.role_permission rp ON rp.role_id=ur.role_id
    JOIN console.permission p ON p.id=rp.permission_id
    WHERE ur.user_id=p_actor_id AND (ur.expires_at IS NULL OR ur.expires_at>v_now)
  ) permission_codes;
  v_payload:='credentialRevision='||v_credential_revision::text||E'\nroles='||v_roles||E'\npermissions='||v_permissions;
  RETURN 'sha256:'||encode(extensions.digest(convert_to(v_payload,'UTF8'),'sha256'),'hex');
END $$;

CREATE OR REPLACE FUNCTION console.shell_actor_has_permission(p_actor_id uuid,p_permission text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
  SELECT EXISTS(
    SELECT 1 FROM console.operator o
    JOIN console.operator_role ur ON ur.user_id=o.user_id
    JOIN console.role_permission rp ON rp.role_id=ur.role_id
    JOIN console.permission p ON p.id=rp.permission_id
    WHERE o.user_id=p_actor_id AND o.status='active' AND p.code=p_permission
      AND (ur.expires_at IS NULL OR ur.expires_at>clock_timestamp())
  )
$$;

CREATE OR REPLACE FUNCTION console.assert_shell_authority(
  p_actor_id uuid,p_permission_revision text,p_require_attach boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
BEGIN
  -- Hold the authority rows through the caller transaction. Concurrent
  -- credential, role-assignment, or permission downgrades cannot commit between
  -- this revalidation and the fenced lifecycle/ticket write.
  PERFORM 1 FROM console.operator WHERE user_id=p_actor_id FOR SHARE;
  PERFORM 1 FROM console.operator_role WHERE user_id=p_actor_id FOR SHARE;
  PERFORM 1 FROM console.role_permission rp JOIN console.operator_role ur ON ur.role_id=rp.role_id
    WHERE ur.user_id=p_actor_id FOR SHARE OF rp,ur;
  IF p_permission_revision IS DISTINCT FROM console.current_shell_permission_revision(p_actor_id) THEN
    RAISE EXCEPTION 'shell permission revision changed' USING ERRCODE='40001';
  END IF;
  IF p_require_attach AND NOT console.shell_actor_has_permission(p_actor_id,'session:attach') THEN
    RAISE EXCEPTION 'session:attach permission is required' USING ERRCODE='42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION console.append_shell_session_event(
  p_session_id uuid,p_event_type text,p_result text,p_reason_code text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
BEGIN
  INSERT INTO console.shell_session_event(
    session_id,actor_id,session_class,runtime_adapter_id,generation,fencing_epoch,
    event_type,result,reason_code,origin,permission_revision,aal,release_evidence_ref,
    manifest_sha256,key_id,runtime_image_digest,os_artifact_digest,session_policy_revision
  ) SELECT session_id,actor_id,session_class,runtime_adapter_id,generation,fencing_epoch,
    p_event_type,p_result,p_reason_code,origin,permission_revision,aal,release_evidence_ref,
    manifest_sha256,key_id,runtime_image_digest,os_artifact_digest,session_policy_revision
  FROM console.shell_session WHERE session_id=p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'shell session not found'; END IF;
END $$;

CREATE OR REPLACE FUNCTION console.create_shell_session(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,p_aal text,
  p_permission_revision text,p_runtime_template_revision text,p_idle_expires_at timestamptz,
  p_absolute_expires_at timestamptz,p_release_evidence jsonb
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_browser console.browser_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
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

CREATE OR REPLACE FUNCTION console.get_shell_session(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_permission_revision text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,false);
  RETURN QUERY SELECT * FROM console.shell_session s
    WHERE s.session_id=p_session_id AND s.browser_session_id=p_browser_session_id AND s.actor_id=p_actor_id;
END $$;

CREATE OR REPLACE FUNCTION console.list_shell_sessions(
  p_browser_session_id uuid,p_actor_id uuid,p_permission_revision text,p_limit integer DEFAULT 50
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,false);
  RETURN QUERY SELECT * FROM console.shell_session s
    WHERE s.browser_session_id=p_browser_session_id AND s.actor_id=p_actor_id
    ORDER BY s.created_at DESC LIMIT greatest(1,least(coalesce(p_limit,50),100));
END $$;

CREATE OR REPLACE FUNCTION console.issue_shell_attach_ticket(
  p_ticket_hash text,p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text,p_expires_at timestamptz
) RETURNS SETOF console.shell_attach_ticket
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
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

CREATE OR REPLACE FUNCTION console.resolve_shell_attach_binding(
  p_ticket_hash text,p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_aal text,p_permission_revision text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,true);
  RETURN QUERY SELECT s.* FROM console.shell_attach_ticket t JOIN console.shell_session s
    ON s.session_id=t.session_id JOIN console.browser_session b ON b.id=s.browser_session_id
    JOIN console.operator o ON o.user_id=s.actor_id
    WHERE t.ticket_hash=p_ticket_hash AND t.session_id=p_session_id
      AND t.browser_session_id=p_browser_session_id AND t.actor_id=p_actor_id AND t.origin=p_origin
      AND t.aal=p_aal AND t.permission_revision=p_permission_revision AND t.consumed_at IS NULL
      AND t.expires_at>v_now AND s.generation=t.generation AND s.fencing_epoch=t.fencing_epoch
      AND s.permission_revision=p_permission_revision AND s.aal=p_aal AND s.origin=p_origin
      AND s.desired_state='Running' AND s.observed_state='Ready'
      AND s.runtime_registered_at IS NOT NULL AND s.runtime_credential_expires_at>v_now
      AND s.idle_expires_at>v_now AND s.absolute_expires_at>v_now
      AND b.status='active' AND b.assurance=p_aal AND b.credential_revision=o.credential_revision
      AND b.idle_expires_at>v_now AND b.absolute_expires_at>v_now;
END $$;

CREATE OR REPLACE FUNCTION console.consume_shell_attach_ticket(
  p_ticket_hash text,p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text,p_consumer text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_affected integer; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.browser_session_id<>p_browser_session_id OR v_session.actor_id<>p_actor_id
    OR v_session.origin<>p_origin OR v_session.generation<>p_generation
    OR v_session.fencing_epoch<>p_fencing_epoch OR v_session.aal<>p_aal
    OR v_session.permission_revision<>p_permission_revision OR v_session.desired_state<>'Running'
    OR v_session.observed_state<>'Ready' OR v_session.idle_expires_at<=v_now
    OR v_session.absolute_expires_at<=v_now THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM console.browser_session b
    JOIN console.operator o ON o.user_id=b.owner_id
    WHERE b.id=p_browser_session_id AND b.owner_id=p_actor_id AND b.status='active'
      AND b.assurance=p_aal AND b.credential_revision=o.credential_revision
      AND b.idle_expires_at>v_now AND b.absolute_expires_at>v_now) THEN RETURN; END IF;
  UPDATE console.shell_attach_ticket SET consumed_at=v_now,consumed_by=p_consumer
  WHERE ticket_hash=p_ticket_hash AND session_id=p_session_id AND browser_session_id=p_browser_session_id
    AND actor_id=p_actor_id AND origin=p_origin AND generation=p_generation
    AND fencing_epoch=p_fencing_epoch AND aal=p_aal AND permission_revision=p_permission_revision
    AND consumed_at IS NULL AND expires_at>v_now;
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  IF v_affected<>1 THEN RETURN; END IF;
  UPDATE console.shell_session SET last_activity_at=v_now,updated_at=v_now WHERE session_id=p_session_id;
  PERFORM console.append_shell_session_event(p_session_id,'SessionAttached','Succeeded','AttachTicketConsumed');
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console.revalidate_shell_session(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_generation bigint,p_fencing_epoch bigint,p_aal text,p_permission_revision text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,true);
  RETURN QUERY SELECT s.* FROM console.shell_session s JOIN console.browser_session b
    ON b.id=s.browser_session_id AND b.owner_id=s.actor_id
    JOIN console.operator o ON o.user_id=s.actor_id
    WHERE s.session_id=p_session_id AND s.browser_session_id=p_browser_session_id
      AND s.actor_id=p_actor_id AND s.origin=p_origin AND s.generation=p_generation
      AND s.fencing_epoch=p_fencing_epoch AND s.aal=p_aal
      AND s.permission_revision=p_permission_revision AND s.desired_state='Running'
      AND s.observed_state='Ready' AND s.idle_expires_at>v_now AND s.absolute_expires_at>v_now
      AND b.status='active' AND b.assurance=p_aal AND b.credential_revision=o.credential_revision
      AND o.status='active' AND b.idle_expires_at>v_now AND b.absolute_expires_at>v_now;
END $$;

CREATE OR REPLACE FUNCTION console.authorize_shell_runtime_attach(
  p_runtime_credential_hash text,p_ticket_hash text,p_session_id uuid,p_runtime_uid text,
  p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_affected integer; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.runtime_credential_hash<>p_runtime_credential_hash
    OR v_session.runtime_credential_expires_at<=v_now OR v_session.runtime_uid<>p_runtime_uid
    OR v_session.generation<>p_generation OR v_session.fencing_epoch<>p_fencing_epoch
    OR v_session.desired_state<>'Running' OR v_session.observed_state<>'Ready'
    OR v_session.permission_revision<>console.current_shell_permission_revision(v_session.actor_id)
    OR NOT console.shell_actor_has_permission(v_session.actor_id,'session:attach') THEN RETURN; END IF;
  UPDATE console.shell_attach_ticket SET runtime_authorized_at=v_now,runtime_authorized_by=p_runtime_uid
    WHERE ticket_hash=p_ticket_hash AND session_id=p_session_id AND generation=p_generation
      AND fencing_epoch=p_fencing_epoch AND consumed_at IS NOT NULL AND runtime_authorized_at IS NULL
      AND expires_at>v_now;
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  IF v_affected<>1 THEN RETURN; END IF;
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console.revalidate_shell_runtime(
  p_runtime_credential_hash text,p_session_id uuid,p_runtime_uid text,p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  RETURN QUERY SELECT s.* FROM console.shell_session s JOIN console.browser_session b
    ON b.id=s.browser_session_id JOIN console.operator o ON o.user_id=s.actor_id
    WHERE s.session_id=p_session_id AND s.runtime_credential_hash=p_runtime_credential_hash
      AND s.runtime_credential_expires_at>v_now AND s.runtime_uid=p_runtime_uid
      AND s.generation=p_generation AND s.fencing_epoch=p_fencing_epoch
      AND s.desired_state='Running' AND s.observed_state='Ready'
      AND s.permission_revision=console.current_shell_permission_revision(s.actor_id)
      AND console.shell_actor_has_permission(s.actor_id,'session:attach')
      AND s.idle_expires_at>v_now AND s.absolute_expires_at>v_now
      AND b.status='active' AND b.assurance=s.aal AND b.credential_revision=o.credential_revision
      AND b.idle_expires_at>v_now AND b.absolute_expires_at>v_now;
END $$;

CREATE OR REPLACE FUNCTION console.resolve_shell_delegation(
  p_session_id uuid,p_actor_id uuid,p_generation bigint,p_fencing_epoch bigint,p_permission_revision text,p_aal text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,true);
  RETURN QUERY SELECT s.* FROM console.shell_session s JOIN console.browser_session b ON b.id=s.browser_session_id
    JOIN console.operator o ON o.user_id=s.actor_id WHERE s.session_id=p_session_id AND s.actor_id=p_actor_id
      AND s.generation=p_generation AND s.fencing_epoch=p_fencing_epoch AND s.permission_revision=p_permission_revision
      AND s.aal=p_aal AND s.desired_state='Running' AND s.observed_state='Ready'
      AND s.runtime_registered_at IS NOT NULL AND s.runtime_credential_expires_at>v_now
      AND s.idle_expires_at>v_now AND s.absolute_expires_at>v_now
      AND b.status='active' AND b.assurance=p_aal AND b.credential_revision=o.credential_revision
      AND b.idle_expires_at>v_now AND b.absolute_expires_at>v_now;
END $$;

CREATE OR REPLACE FUNCTION console.request_shell_session_teardown(
  p_session_id uuid,p_browser_session_id uuid,p_actor_id uuid,p_origin text,
  p_permission_revision text,p_reason_code text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,false);
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.browser_session_id<>p_browser_session_id OR v_session.actor_id<>p_actor_id
    OR v_session.origin<>p_origin THEN RETURN; END IF;
  UPDATE console.shell_session SET desired_state='Terminated',permission_revision=p_permission_revision,
    termination_requested_at=coalesce(termination_requested_at,v_now),updated_at=v_now
    WHERE session_id=p_session_id RETURNING * INTO v_session;
  UPDATE console.shell_attach_ticket SET expires_at=least(expires_at,v_now)
    WHERE session_id=p_session_id AND consumed_at IS NULL AND expires_at>v_now;
  PERFORM console.append_shell_session_event(p_session_id,'TeardownRequested','Succeeded',p_reason_code);
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console.claim_shell_sessions(p_worker text,p_limit integer DEFAULT 5)
RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE;
BEGIN
  IF length(btrim(coalesce(p_worker,''))) NOT BETWEEN 3 AND 128 THEN RAISE EXCEPTION 'worker identity required'; END IF;
  FOR v_session IN WITH candidates AS (
    SELECT session_id FROM console.shell_session
    WHERE observed_state<>'Terminated' AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
    ORDER BY CASE WHEN desired_state='Terminated' THEN 0 ELSE 1 END,updated_at,session_id
    FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(coalesce(p_limit,5),20))
  ) UPDATE console.shell_session s SET lease_owner=p_worker,fencing_epoch=s.fencing_epoch+1,
    lease_expires_at=clock_timestamp()+interval '15 seconds',heartbeat_at=clock_timestamp(),
    updated_at=clock_timestamp()
  FROM candidates c WHERE s.session_id=c.session_id RETURNING s.*
  LOOP
    PERFORM console.append_shell_session_event(v_session.session_id,'RuntimeClaimed','Succeeded','LeaseClaimed');
    RETURN NEXT v_session;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION console.heartbeat_shell_session(
  p_session_id uuid,p_actor_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,
  p_permission_revision text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_affected integer;
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,false);
  UPDATE console.shell_session s SET lease_expires_at=clock_timestamp()+interval '15 seconds',
    heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),
    desired_state=CASE WHEN s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM console.browser_session b WHERE b.id=s.browser_session_id
        AND b.owner_id=s.actor_id AND b.status='active' AND b.idle_expires_at>clock_timestamp()
        AND b.absolute_expires_at>clock_timestamp()) THEN 'Terminated' ELSE s.desired_state END,
    termination_requested_at=CASE WHEN s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM console.browser_session b WHERE b.id=s.browser_session_id
        AND b.owner_id=s.actor_id AND b.status='active' AND b.idle_expires_at>clock_timestamp()
        AND b.absolute_expires_at>clock_timestamp()) THEN coalesce(s.termination_requested_at,clock_timestamp()) ELSE s.termination_requested_at END
  WHERE session_id=p_session_id AND actor_id=p_actor_id AND lease_owner=p_worker
    AND generation=p_generation AND fencing_epoch=p_fencing_epoch
    AND permission_revision=p_permission_revision AND lease_expires_at>clock_timestamp()
    AND observed_state<>'Terminated';
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  RETURN v_affected=1;
END $$;

CREATE OR REPLACE FUNCTION console.classify_shell_runtime_registration(
  p_session_id uuid,p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console.shell_session
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
  SELECT * FROM console.shell_session s WHERE s.session_id=p_session_id AND s.generation=p_generation
    AND s.fencing_epoch=p_fencing_epoch AND s.desired_state='Running' AND s.lease_expires_at>clock_timestamp()
    AND s.observed_state IN ('Pending','Provisioning','Ready')
$$;

CREATE OR REPLACE FUNCTION console.resolve_shell_runtime_registration(
  p_session_id uuid,p_runtime_uid text,p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console.shell_session
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
  SELECT * FROM console.shell_session s WHERE s.session_id=p_session_id
    AND s.runtime_uid=p_runtime_uid AND s.generation=p_generation AND s.fencing_epoch=p_fencing_epoch
    AND s.desired_state='Running' AND s.observed_state='Provisioning'
    AND s.lease_expires_at>clock_timestamp() AND s.runtime_registered_at IS NULL
$$;

CREATE OR REPLACE FUNCTION console.inspect_shell_claim(
  p_session_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint
) RETURNS SETOF console.shell_session
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
  SELECT * FROM console.shell_session s WHERE s.session_id=p_session_id AND s.lease_owner=p_worker
    AND s.generation=p_generation AND s.fencing_epoch=p_fencing_epoch
    AND s.lease_expires_at>clock_timestamp() AND s.observed_state<>'Terminated'
$$;

CREATE OR REPLACE FUNCTION console.reproject_shell_runtime(
  p_session_id uuid,p_actor_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,
  p_expected_runtime_uid text,p_reason_code text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.actor_id<>p_actor_id OR v_session.lease_owner<>p_worker
    OR v_session.generation<>p_generation OR v_session.fencing_epoch<>p_fencing_epoch
    OR v_session.lease_expires_at<=v_now OR v_session.desired_state<>'Running'
    OR v_session.observed_state NOT IN ('Provisioning','Ready','Failed')
    OR v_session.runtime_uid IS DISTINCT FROM p_expected_runtime_uid THEN
    RAISE EXCEPTION 'runtime reprojection fence or deletion evidence changed' USING ERRCODE='40001';
  END IF;
  UPDATE console.shell_session SET generation=generation+1,observed_state='Pending',runtime_uid=NULL,
    runtime_resource_version=NULL,observed_generation=NULL,runtime_key_id=NULL,runtime_public_key_pem=NULL,
    runtime_tls_certificate_sha256=NULL,runtime_attach_endpoint=NULL,runtime_credential_hash=NULL,
    runtime_credential_expires_at=NULL,runtime_registered_at=NULL,runtime_projection_started_at=NULL,
    last_error_code=NULL,updated_at=v_now
    WHERE session_id=p_session_id RETURNING * INTO v_session;
  UPDATE console.shell_attach_ticket SET expires_at=least(expires_at,v_now)
    WHERE session_id=p_session_id AND runtime_authorized_at IS NULL AND expires_at>v_now;
  PERFORM console.append_shell_session_event(p_session_id,'RuntimeReprojected','Succeeded',p_reason_code);
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console.register_shell_runtime(
  p_session_id uuid,p_actor_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,
  p_permission_revision text,p_runtime_uid text,p_runtime_resource_version text,p_runtime_key_id text,
  p_runtime_public_key_pem text,p_runtime_tls_certificate_sha256 text,p_runtime_attach_endpoint text,
  p_runtime_credential_hash text,p_runtime_credential_expires_at timestamptz
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,true);
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR UPDATE;
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
  UPDATE console.shell_session SET runtime_resource_version=p_runtime_resource_version,
    runtime_key_id=p_runtime_key_id,runtime_public_key_pem=p_runtime_public_key_pem,
    runtime_tls_certificate_sha256=p_runtime_tls_certificate_sha256,
    runtime_attach_endpoint=p_runtime_attach_endpoint,runtime_credential_hash=p_runtime_credential_hash,
    runtime_credential_expires_at=p_runtime_credential_expires_at,runtime_registered_at=v_now,
    updated_at=v_now WHERE session_id=p_session_id RETURNING * INTO v_session;
  PERFORM console.append_shell_session_event(p_session_id,'RuntimeRegistered','Succeeded','BootstrapTokenReviewed');
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console.revoke_shell_session_authority(
  p_session_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,p_reason_code text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_now timestamptz:=clock_timestamp(); v_revision text;
BEGIN
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.lease_owner<>p_worker OR v_session.generation<>p_generation
    OR v_session.fencing_epoch<>p_fencing_epoch OR v_session.lease_expires_at<=v_now
    OR v_session.observed_state='Terminated' THEN
    RAISE EXCEPTION 'shell authority revocation fence was lost' USING ERRCODE='40001';
  END IF;
  v_revision:=console.current_shell_permission_revision(v_session.actor_id);
  UPDATE console.shell_session SET desired_state='Terminated',permission_revision=v_revision,
    termination_requested_at=coalesce(termination_requested_at,v_now),updated_at=v_now
    WHERE session_id=p_session_id RETURNING * INTO v_session;
  UPDATE console.shell_attach_ticket SET expires_at=least(expires_at,v_now)
    WHERE session_id=p_session_id AND runtime_authorized_at IS NULL AND expires_at>v_now;
  PERFORM console.append_shell_session_event(p_session_id,'PolicyDenied','Denied',p_reason_code);
  RETURN NEXT v_session;
END $$;

CREATE OR REPLACE FUNCTION console.transition_shell_session(
  p_session_id uuid,p_actor_id uuid,p_worker text,p_generation bigint,p_fencing_epoch bigint,
  p_expected_state text,p_next_state text,p_permission_revision text,p_runtime_uid text,
  p_runtime_resource_version text,p_reason_code text
) RETURNS SETOF console.shell_session
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console AS $$
DECLARE v_session console.shell_session%ROWTYPE; v_valid boolean; v_now timestamptz:=clock_timestamp(); v_event text;
BEGIN
  PERFORM console.assert_shell_authority(p_actor_id,p_permission_revision,false);
  SELECT * INTO v_session FROM console.shell_session WHERE session_id=p_session_id FOR UPDATE;
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
  UPDATE console.shell_session SET observed_state=p_next_state,
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
  PERFORM console.append_shell_session_event(p_session_id,v_event,
    CASE WHEN p_next_state='Failed' THEN 'Failed' ELSE 'Succeeded' END,p_reason_code);
  RETURN NEXT v_session;
END $$;

ALTER TABLE console.shell_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.shell_attach_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.shell_session_event ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE console.shell_session,console.shell_attach_ticket,console.shell_session_event
  FROM PUBLIC,anon,authenticated,service_role,authenticator,opensphere_console_backend,
    opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;
REVOKE ALL ON SEQUENCE console.shell_session_event_event_id_seq
  FROM PUBLIC,anon,authenticated,service_role,authenticator,opensphere_console_backend,
    opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;

REVOKE ALL ON FUNCTION console.current_shell_permission_revision(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.shell_actor_has_permission(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.assert_shell_authority(uuid,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.append_shell_session_event(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.create_shell_session(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.get_shell_session(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.list_shell_sessions(uuid,uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.issue_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.resolve_shell_attach_binding(text,uuid,uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.consume_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.revalidate_shell_session(uuid,uuid,uuid,text,bigint,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.authorize_shell_runtime_attach(text,text,uuid,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.revalidate_shell_runtime(text,uuid,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.resolve_shell_delegation(uuid,uuid,bigint,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.request_shell_session_teardown(uuid,uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.claim_shell_sessions(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.heartbeat_shell_session(uuid,uuid,text,bigint,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.resolve_shell_runtime_registration(uuid,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.classify_shell_runtime_registration(uuid,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.inspect_shell_claim(uuid,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.reproject_shell_runtime(uuid,uuid,text,bigint,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.register_shell_runtime(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.revoke_shell_session_authority(uuid,text,bigint,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.transition_shell_session(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text) FROM PUBLIC;

GRANT USAGE ON SCHEMA console TO opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;
GRANT EXECUTE ON FUNCTION console.current_shell_permission_revision(uuid)
  TO opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;
GRANT EXECUTE ON FUNCTION console.create_shell_session(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,jsonb),
  console.get_shell_session(uuid,uuid,uuid,text),
  console.list_shell_sessions(uuid,uuid,text,integer),
  console.issue_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,timestamptz),
  console.request_shell_session_teardown(uuid,uuid,uuid,text,text,text)
  TO opensphere_shell_api;
GRANT EXECUTE ON FUNCTION console.consume_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,text),
  console.resolve_shell_attach_binding(text,uuid,uuid,uuid,text,text,text),
  console.revalidate_shell_session(uuid,uuid,uuid,text,bigint,bigint,text,text)
  TO opensphere_shell_gateway;
GRANT EXECUTE ON FUNCTION console.authorize_shell_runtime_attach(text,text,uuid,text,bigint,bigint),
  console.revalidate_shell_runtime(text,uuid,text,bigint,bigint)
  TO opensphere_shell_api;
GRANT EXECUTE ON FUNCTION console.resolve_shell_delegation(uuid,uuid,bigint,bigint,text,text)
  TO opensphere_console_backend;
GRANT EXECUTE ON FUNCTION console.claim_shell_sessions(text,integer),
  console.heartbeat_shell_session(uuid,uuid,text,bigint,bigint,text),
  console.resolve_shell_runtime_registration(uuid,text,bigint,bigint),
  console.classify_shell_runtime_registration(uuid,bigint,bigint),
  console.inspect_shell_claim(uuid,text,bigint,bigint),
  console.reproject_shell_runtime(uuid,uuid,text,bigint,bigint,text,text),
  console.register_shell_runtime(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text,text,text,timestamptz),
  console.revoke_shell_session_authority(uuid,text,bigint,bigint,text),
  console.transition_shell_session(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text)
  TO opensphere_shell_reconciler;

COMMIT;
