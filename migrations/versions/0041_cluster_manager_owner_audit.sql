-- Existing HISS/Ceph audit integration. No new table, credentials or product implementation.
CREATE FUNCTION console_audit.append_cluster_manager_event(
 p_session uuid,p_actor uuid,p_permission_revision bigint,p_revoke_epoch bigint,
 p_action text,p_target text,p_outcome text,p_reason text,p_correlation text,p_metadata_digest text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,console_identity,console_audit,console_operation AS $$
DECLARE s console_identity.browser_session; a console_identity.subject_authority;
 receipt console_audit.event; local_edge boolean;
BEGIN
 IF p_session IS NULL OR p_actor IS NULL OR p_permission_revision IS NULL OR p_revoke_epoch IS NULL
  OR p_action IS NULL OR p_action !~ '^(HIS|Ceph|OSAAHIS)[A-Za-z]{1,80}$'
  OR p_target IS NULL OR p_target !~ '^(HISS/[a-z0-9][a-z0-9/-]{0,127}|CephExternal/rook-ceph)$'
  OR p_outcome IS NULL OR p_outcome NOT IN ('accepted','succeeded','failed','unknown')
  OR length(trim(COALESCE(p_reason,''))) NOT BETWEEN 3 AND 1000 OR p_reason ~ '[\r\n]'
  OR p_correlation IS NULL OR p_correlation !~ '^[A-Za-z0-9._:-]{1,128}$'
  OR p_metadata_digest IS NULL OR p_metadata_digest !~ '^sha256:[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Invalid Cluster Manager audit contract' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM console_identity.browser_session WHERE session_id=p_session FOR SHARE;
 IF NOT FOUND OR s.subject_id<>p_actor OR s.revoked_at IS NOT NULL
  OR s.expires_at<=statement_timestamp() OR s.absolute_expires_at<=statement_timestamp()
 THEN RAISE EXCEPTION 'Active Console session required' USING ERRCODE='28000'; END IF;
 SELECT * INTO a FROM console_identity.subject_authority WHERE subject_id=p_actor FOR SHARE;
 IF NOT FOUND OR a.permission_revision<>s.permission_revision OR a.revoke_epoch<>s.revoke_epoch
  OR a.permission_revision<>p_permission_revision OR a.revoke_epoch<>p_revoke_epoch
 THEN RAISE EXCEPTION 'Stale Console authority' USING ERRCODE='28000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM console_identity.permission_grant WHERE subject_id=p_actor
  AND permission='console.role.admin' AND grant_revision<=a.permission_revision AND revoked_at IS NULL)
 THEN RAISE EXCEPTION 'Console administrator required' USING ERRCODE='42501'; END IF;
 SELECT EXISTS(SELECT 1 FROM console_operation.module_installation_environment WHERE singleton AND channel='edge'
  AND console_origin ~ '^https://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]{1,5})?$') INTO local_edge;
 IF NOT local_edge AND s.aal<>'aal2'
 THEN RAISE EXCEPTION 'MFA required outside localhost edge' USING ERRCODE='42501',DETAIL='StepUpRequired'; END IF;
 receipt:=console_audit.append_event_internal(NULL,p_correlation,p_actor::text,p_action,p_target,p_outcome,p_reason,
  jsonb_build_object('source','cluster-manager','metadataDigest',p_metadata_digest,'sessionId',p_session,
   'aal',s.aal,'localEdgeMfaException',local_edge));
 RETURN jsonb_build_object('eventId',receipt.event_id,'eventHash',receipt.event_hash);
END $$;
REVOKE ALL ON FUNCTION console_audit.append_cluster_manager_event(uuid,uuid,bigint,bigint,text,text,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION console_audit.append_cluster_manager_event(uuid,uuid,bigint,bigint,text,text,text,text,text,text) TO console_api;
