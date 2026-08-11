\set ON_ERROR_STOP on

-- The completeness digest is a cross-runtime cryptographic contract. Database
-- locale collation (for example en_US.UTF-8) is not canonical, so node IDs are
-- aggregated in bytewise C order to match JavaScript's deterministic sort.
CREATE OR REPLACE FUNCTION oaa.complete_reconcile_session_v2(
  p_session_id uuid, p_completed_scope_count integer, p_observed_resource_count integer,
  p_page_token_exhausted boolean, p_authority_revision text, p_completeness_digest text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa, extensions AS $$
DECLARE session_row oaa.reconcile_session%ROWTYPE;
DECLARE actual_count integer;
DECLARE node_ids text;
DECLARE expected_digest text;
BEGIN
  SELECT * INTO session_row FROM oaa.reconcile_session
    WHERE reconcile_session_id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconcile session not found'; END IF;
  PERFORM 1 FROM oaa.observer_fence
    WHERE cluster_id=session_row.cluster_id AND fencing_epoch=session_row.fencing_epoch
      AND collector_id=session_row.collector_id AND lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'stale reconcile session' USING ERRCODE='40001'; END IF;
  IF p_completed_scope_count <> session_row.expected_scope_count OR NOT coalesce(p_page_token_exhausted,false) THEN
    RAISE EXCEPTION 'incomplete reconcile scope/page barrier';
  END IF;
  IF length(btrim(coalesce(p_authority_revision,''))) < 8 THEN RAISE EXCEPTION 'authority revision evidence required'; END IF;
  SELECT count(*)::integer, coalesce(string_agg(node_id, E'\n' ORDER BY node_id COLLATE "C"),'')
    INTO actual_count, node_ids FROM oaa.resource_node
    WHERE reconcile_session_id=p_session_id AND cluster_id=session_row.cluster_id
      AND fencing_epoch=session_row.fencing_epoch AND collection_epoch=session_row.collection_epoch
      AND snapshot_complete=true;
  IF actual_count <> p_observed_resource_count THEN
    RAISE EXCEPTION 'observed resource count mismatch: %/%', p_observed_resource_count, actual_count;
  END IF;
  expected_digest := 'sha256:' || encode(extensions.digest(
    convert_to('complete-reconcile-v2' || E'\n' || p_session_id::text || E'\n'
      || session_row.expected_scope_count::text || E'\n' || p_completed_scope_count::text || E'\n'
      || actual_count::text || E'\n' || p_authority_revision || E'\n' || node_ids, 'UTF8'), 'sha256'), 'hex');
  IF p_completeness_digest IS DISTINCT FROM expected_digest THEN RAISE EXCEPTION 'reconcile completeness digest mismatch'; END IF;
  UPDATE oaa.reconcile_session SET completed_scope_count=p_completed_scope_count,
    observed_resource_count=actual_count, page_token_exhausted=true,
    authority_revision=p_authority_revision, completeness_digest=expected_digest,
    snapshot_complete=true, completed_at=clock_timestamp()
    WHERE reconcile_session_id=p_session_id;
  INSERT INTO oaa.source_health(cluster_id,source,epistemic_state,configured,snapshot_complete,
    last_complete_session_id,last_complete_at,last_received_at,lag_seconds,blocker_code,evidence_ref)
  VALUES(session_row.cluster_id,session_row.source,'known',true,true,p_session_id,
    clock_timestamp(),clock_timestamp(),0,NULL,'reconcile:'||p_session_id::text)
  ON CONFLICT(cluster_id,source) DO UPDATE SET epistemic_state='known',snapshot_complete=true,
    last_complete_session_id=EXCLUDED.last_complete_session_id,last_complete_at=EXCLUDED.last_complete_at,
    last_received_at=EXCLUDED.last_received_at,lag_seconds=0,blocker_code=NULL,
    evidence_ref=EXCLUDED.evidence_ref,updated_at=clock_timestamp();
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION oaa.complete_reconcile_session_v2(uuid,integer,integer,boolean,text,text)
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway,
       opensphere_oaa_api, opensphere_oaa_incident_relay, opensphere_oaa_maintenance;
GRANT EXECUTE ON FUNCTION oaa.complete_reconcile_session_v2(uuid,integer,integer,boolean,text,text)
  TO opensphere_oaa_observer;

COMMENT ON FUNCTION oaa.complete_reconcile_session_v2(uuid,integer,integer,boolean,text,text)
  IS 'Fail-closed reconcile barrier using locale-independent bytewise node ID ordering.';
