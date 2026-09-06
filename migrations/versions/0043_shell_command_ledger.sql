-- CON-FR-007/018: durable admission for the common OS Shell command path.
-- Never automatically redispatch an uncertain write after a process crash.
CREATE TABLE console_shell.command_request (
  actor_id uuid NOT NULL, request_id uuid NOT NULL, session_id uuid NOT NULL,
  command text NOT NULL CHECK (command ~ '^hiss[.][a-z.]+$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  aal text NOT NULL CHECK (aal IN ('aal1','aal2')),
  phase text NOT NULL DEFAULT 'Dispatching' CHECK (phase IN ('Dispatching','Recorded')),
  result jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), recorded_at timestamptz,
  PRIMARY KEY(actor_id,request_id),
  CHECK ((phase='Dispatching' AND result IS NULL AND recorded_at IS NULL)
    OR (phase='Recorded' AND result IS NOT NULL AND recorded_at IS NOT NULL))
);
REVOKE ALL ON console_shell.command_request FROM PUBLIC,console_api,opensphere_shell_api,opensphere_shell_gateway,opensphere_shell_reconciler;
CREATE FUNCTION console_shell.claim_command(p_actor uuid,p_session uuid,p_request uuid,p_command text,p_digest text,p_aal text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
DECLARE r console_shell.command_request; inserted integer; actual_aal text;
BEGIN
  -- Recheck authoritative session state at the durable admission boundary.
  SELECT b.aal INTO actual_aal FROM console_identity.browser_session b
    JOIN console_identity.subject_authority a ON a.subject_id=b.subject_id
    WHERE b.session_id=p_session AND b.subject_id=p_actor AND b.revoked_at IS NULL
      AND b.expires_at>statement_timestamp() AND b.absolute_expires_at>statement_timestamp()
      AND b.permission_revision=a.permission_revision AND b.revoke_epoch=a.revoke_epoch;
  IF actual_aal IS NULL THEN
    SELECT 'aal1' INTO actual_aal FROM console_identity.cli_session c
      JOIN console_identity.cli_device d ON d.device_id=c.device_id
      JOIN console_identity.subject_authority a ON a.subject_id=c.subject_id
      WHERE c.session_id=p_session AND c.subject_id=p_actor AND c.revoked_at IS NULL
        AND c.expires_at>statement_timestamp() AND d.status='active'
        AND c.permission_revision=a.permission_revision AND c.revoke_epoch=a.revoke_epoch;
  END IF;
  IF actual_aal IS NULL OR actual_aal<>p_aal THEN
    RAISE EXCEPTION 'ShellCommandSessionInvalid' USING ERRCODE='28000'; END IF;
  IF NOT console_shell.shell_actor_has_permission(p_actor,'console.role.admin') THEN
    RAISE EXCEPTION 'ShellCommandPermissionDenied' USING ERRCODE='42501';
  END IF;
  IF actual_aal<>'aal2' AND NOT EXISTS(SELECT 1 FROM console_operation.module_installation_environment
    WHERE singleton AND channel='edge' AND console_origin ~ '^https://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?$') THEN
    RAISE EXCEPTION 'ShellCommandMfaRequired' USING ERRCODE='42501'; END IF;
  INSERT INTO console_shell.command_request(actor_id,session_id,request_id,command,input_digest,aal)
    VALUES(p_actor,p_session,p_request,p_command,p_digest,p_aal) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  SELECT * INTO STRICT r FROM console_shell.command_request WHERE actor_id=p_actor AND request_id=p_request;
  IF r.command<>p_command OR r.input_digest<>p_digest THEN RETURN jsonb_build_object('conflict',true); END IF;
  RETURN jsonb_build_object('claimed',inserted=1,'phase',r.phase,'result',r.result);
END $$;
CREATE FUNCTION console_shell.finish_command(p_actor uuid,p_request uuid,p_digest text,p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,console_shell AS $$
BEGIN
  IF jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>1048576 THEN
    RAISE EXCEPTION 'ShellCommandResultInvalid' USING ERRCODE='22023'; END IF;
  UPDATE console_shell.command_request SET phase='Recorded',result=p_result,recorded_at=clock_timestamp()
    WHERE actor_id=p_actor AND request_id=p_request AND input_digest=p_digest AND phase='Dispatching';
  IF NOT FOUND THEN RAISE EXCEPTION 'ShellCommandRecordConflict' USING ERRCODE='40001'; END IF;
END $$;
REVOKE ALL ON FUNCTION console_shell.claim_command(uuid,uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_shell.finish_command(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_shell.claim_command(uuid,uuid,uuid,text,text,text),console_shell.finish_command(uuid,uuid,text,jsonb) TO opensphere_shell_api;

-- External CLI sessions are separate records from browser sessions. The audit
-- owner must verify their actual device, expiry, authority and assurance too.
CREATE FUNCTION console_audit.append_cluster_manager_cli_event(
 p_session uuid,p_actor uuid,p_permission_revision bigint,p_revoke_epoch bigint,
 p_action text,p_target text,p_outcome text,p_reason text,p_correlation text,p_metadata_digest text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s console_identity.cli_session; a console_identity.subject_authority; receipt console_audit.event;
BEGIN
 IF p_session IS NULL OR p_actor IS NULL OR p_permission_revision IS NULL OR p_revoke_epoch IS NULL
  OR p_action IS NULL OR p_action !~ '^(HIS|Ceph|OSAAHIS)[A-Za-z]{1,80}$'
  OR p_target IS NULL OR p_target !~ '^(HISS/[a-z0-9][a-z0-9/-]{0,127}|CephExternal/rook-ceph)$'
  OR p_outcome IS NULL OR p_outcome NOT IN ('accepted','succeeded','failed','unknown')
  OR length(trim(COALESCE(p_reason,''))) NOT BETWEEN 3 AND 1000 OR p_reason ~ '[\r\n]'
  OR p_correlation IS NULL OR p_correlation !~ '^[A-Za-z0-9._:-]{1,128}$'
  OR p_metadata_digest IS NULL OR p_metadata_digest !~ '^sha256:[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Invalid Cluster Manager audit contract' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM console_identity.cli_session WHERE session_id=p_session FOR SHARE;
 IF NOT FOUND OR s.subject_id<>p_actor OR s.revoked_at IS NOT NULL OR s.expires_at<=statement_timestamp()
  OR NOT EXISTS(SELECT 1 FROM console_identity.cli_device WHERE device_id=s.device_id AND status='active')
 THEN RAISE EXCEPTION 'Active CLI device session required' USING ERRCODE='28000'; END IF;
 SELECT * INTO a FROM console_identity.subject_authority WHERE subject_id=p_actor FOR SHARE;
 IF NOT FOUND OR a.permission_revision<>s.permission_revision OR a.revoke_epoch<>s.revoke_epoch
  OR a.permission_revision<>p_permission_revision OR a.revoke_epoch<>p_revoke_epoch
 THEN RAISE EXCEPTION 'Stale Console authority' USING ERRCODE='28000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM console_identity.permission_grant WHERE subject_id=p_actor
  AND permission='console.role.admin' AND grant_revision<=a.permission_revision AND revoked_at IS NULL)
 THEN RAISE EXCEPTION 'Console administrator required' USING ERRCODE='42501'; END IF;
 -- Device credentials currently carry AAL1; never manufacture AAL2.
 IF NOT EXISTS(SELECT 1 FROM console_operation.module_installation_environment WHERE singleton AND channel='edge'
  AND console_origin ~ '^https://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?$')
 THEN RAISE EXCEPTION 'MFA required outside localhost edge' USING ERRCODE='42501',DETAIL='StepUpRequired'; END IF;
 receipt:=console_audit.append_event_internal(NULL,p_correlation,p_actor::text,p_action,p_target,p_outcome,p_reason,
  jsonb_build_object('source','cluster-manager','metadataDigest',p_metadata_digest,'sessionId',p_session,
   'credentialType','cli-device','aal','aal1','localEdgeMfaException',true));
 RETURN jsonb_build_object('eventId',receipt.event_id,'eventHash',receipt.event_hash);
END $$;
REVOKE ALL ON FUNCTION console_audit.append_cluster_manager_cli_event(uuid,uuid,bigint,bigint,text,text,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION console_audit.append_cluster_manager_cli_event(uuid,uuid,bigint,bigint,text,text,text,text,text,text) TO console_api;
