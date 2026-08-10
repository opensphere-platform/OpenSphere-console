\set ON_ERROR_STOP on

-- Post-implementation red-team hardening.  This migration turns the remaining
-- convention-level safety properties into database-enforced contracts.

-- A legacy default privilege granted every future OAA table to the gateway.
-- Future writers must now receive an explicit, reviewed grant per table.
ALTER DEFAULT PRIVILEGES IN SCHEMA oaa
  REVOKE ALL ON TABLES FROM opensphere_oaa_gateway;

-- ---------------------------------------------------------------------------
-- H-1: partitioned evidence is append-only and direct child access is least
-- privilege.  Parent triggers are cloned to existing and future partitions by
-- PostgreSQL; harden_evidence_partition also fixes direct-child grants and
-- statement-level TRUNCATE protection.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS observation_append_only ON oaa.observation;
CREATE TRIGGER observation_append_only BEFORE UPDATE OR DELETE ON oaa.observation
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.observation ENABLE ALWAYS TRIGGER observation_append_only;

DROP TRIGGER IF EXISTS observation_no_truncate ON oaa.observation;
CREATE TRIGGER observation_no_truncate BEFORE TRUNCATE ON oaa.observation
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.observation ENABLE ALWAYS TRIGGER observation_no_truncate;

DROP TRIGGER IF EXISTS slo_sample_append_only ON oaa.slo_sample;
CREATE TRIGGER slo_sample_append_only BEFORE UPDATE OR DELETE ON oaa.slo_sample
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.slo_sample ENABLE ALWAYS TRIGGER slo_sample_append_only;

DROP TRIGGER IF EXISTS slo_sample_no_truncate ON oaa.slo_sample;
CREATE TRIGGER slo_sample_no_truncate BEFORE TRUNCATE ON oaa.slo_sample
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.slo_sample ENABLE ALWAYS TRIGGER slo_sample_no_truncate;

CREATE OR REPLACE FUNCTION oaa.harden_evidence_partition(
  p_partition regclass, p_stream text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
DECLARE qualified_name text;
DECLARE trigger_name text;
BEGIN
  IF p_stream NOT IN ('observation', 'slo_sample') THEN
    RAISE EXCEPTION 'unsupported evidence stream %', p_stream;
  END IF;
  SELECT format('%I.%I', n.nspname, c.relname) INTO qualified_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = p_partition AND n.nspname = 'oaa' AND c.relkind = 'r';
  IF qualified_name IS NULL THEN RAISE EXCEPTION 'evidence partition not found'; END IF;
  PERFORM 1 FROM pg_inherits i
    WHERE i.inhrelid = p_partition
      AND i.inhparent = CASE p_stream WHEN 'observation' THEN 'oaa.observation'::regclass ELSE 'oaa.slo_sample'::regclass END;
  IF NOT FOUND THEN RAISE EXCEPTION '% is not a direct % partition', qualified_name, p_stream; END IF;

  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway, opensphere_oaa_observer, opensphere_oaa_api, opensphere_oaa_maintenance', qualified_name);
  IF p_stream = 'observation' THEN
    EXECUTE format('GRANT SELECT ON TABLE %s TO opensphere_oaa_gateway, opensphere_oaa_api, opensphere_oaa_observer', qualified_name);
  ELSE
    EXECUTE format('GRANT SELECT ON TABLE %s TO opensphere_oaa_gateway, opensphere_oaa_api, opensphere_oaa_maintenance', qualified_name);
  END IF;

  FOR trigger_name IN
    SELECT t.tgname FROM pg_trigger t
    WHERE t.tgrelid = p_partition AND NOT t.tgisinternal
      AND t.tgname IN ('observation_append_only', 'observation_no_truncate',
                       'slo_sample_append_only', 'slo_sample_no_truncate')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I', qualified_name, trigger_name);
  END LOOP;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION oaa.harden_evidence_partition(regclass,text)
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway,
       opensphere_oaa_observer, opensphere_oaa_api, opensphere_oaa_maintenance;

REVOKE ALL ON TABLE oaa.observation, oaa.slo_sample
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway,
       opensphere_oaa_observer, opensphere_oaa_api, opensphere_oaa_maintenance;
GRANT SELECT, INSERT ON oaa.observation TO opensphere_oaa_observer;
GRANT SELECT ON oaa.observation TO opensphere_oaa_api, opensphere_oaa_gateway;
GRANT SELECT, INSERT ON oaa.slo_sample TO opensphere_oaa_maintenance;
GRANT SELECT ON oaa.slo_sample TO opensphere_oaa_api, opensphere_oaa_gateway;

DO $$
DECLARE child regclass;
BEGIN
  FOR child IN
    SELECT i.inhrelid::regclass FROM pg_inherits i
    WHERE i.inhparent = 'oaa.observation'::regclass
  LOOP PERFORM oaa.harden_evidence_partition(child, 'observation'); END LOOP;
  FOR child IN
    SELECT i.inhrelid::regclass FROM pg_inherits i
    WHERE i.inhparent = 'oaa.slo_sample'::regclass
  LOOP PERFORM oaa.harden_evidence_partition(child, 'slo_sample'); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION oaa.ensure_time_partitions(p_month date)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
DECLARE month_start date := date_trunc('month', p_month)::date;
DECLARE observation_partition regclass;
DECLARE slo_partition regclass;
BEGIN
  IF month_start < date_trunc('month', clock_timestamp())::date
     OR month_start > (date_trunc('month', clock_timestamp()) + interval '12 months')::date THEN
    RAISE EXCEPTION 'partition month outside maintenance horizon';
  END IF;
  EXECUTE format('CREATE TABLE IF NOT EXISTS oaa.%I PARTITION OF oaa.observation FOR VALUES FROM (%L) TO (%L)',
    'observation_' || to_char(month_start, 'YYYYMM'), month_start, (month_start + interval '1 month')::date);
  EXECUTE format('CREATE TABLE IF NOT EXISTS oaa.%I PARTITION OF oaa.slo_sample FOR VALUES FROM (%L) TO (%L)',
    'slo_sample_' || to_char(month_start, 'YYYYMM'), month_start, (month_start + interval '1 month')::date);
  observation_partition := to_regclass('oaa.observation_' || to_char(month_start, 'YYYYMM'));
  slo_partition := to_regclass('oaa.slo_sample_' || to_char(month_start, 'YYYYMM'));
  PERFORM oaa.harden_evidence_partition(observation_partition, 'observation');
  PERFORM oaa.harden_evidence_partition(slo_partition, 'slo_sample');
  RETURN true;
END $$;

-- L-1/L-2: fence and monotonicity are database invariants, including sessions
-- using replication-role trigger semantics.
ALTER TABLE oaa.resource_node ENABLE ALWAYS TRIGGER resource_node_fence;
ALTER TABLE oaa.resource_relation ENABLE ALWAYS TRIGGER resource_relation_fence;
ALTER TABLE oaa.observation ENABLE ALWAYS TRIGGER observation_fence;

CREATE OR REPLACE FUNCTION oaa.assert_graph_monotonicity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, oaa AS $$
BEGIN
  IF NEW.fencing_epoch < OLD.fencing_epoch
     OR (NEW.fencing_epoch = OLD.fencing_epoch AND NEW.collection_epoch < OLD.collection_epoch)
     OR (TG_TABLE_NAME = 'resource_node'
         AND NEW.fencing_epoch = OLD.fencing_epoch
         AND NEW.collection_epoch = OLD.collection_epoch
         AND coalesce(NEW.stream_sequence, -1) < coalesce(OLD.stream_sequence, -1)) THEN
    RAISE EXCEPTION 'operational graph revision regression' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS resource_node_monotonicity ON oaa.resource_node;
CREATE TRIGGER resource_node_monotonicity BEFORE UPDATE ON oaa.resource_node
  FOR EACH ROW EXECUTE FUNCTION oaa.assert_graph_monotonicity();
ALTER TABLE oaa.resource_node ENABLE ALWAYS TRIGGER resource_node_monotonicity;
DROP TRIGGER IF EXISTS resource_relation_monotonicity ON oaa.resource_relation;
CREATE TRIGGER resource_relation_monotonicity BEFORE UPDATE ON oaa.resource_relation
  FOR EACH ROW EXECUTE FUNCTION oaa.assert_graph_monotonicity();
ALTER TABLE oaa.resource_relation ENABLE ALWAYS TRIGGER resource_relation_monotonicity;

-- ---------------------------------------------------------------------------
-- M-1: incident state is writable only through fenced SECURITY DEFINER RPCs.
-- The core state/timeline/outbox transition remains one database transaction.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS incident_fence ON oaa.incident;
CREATE TRIGGER incident_fence BEFORE INSERT OR UPDATE ON oaa.incident
  FOR EACH ROW EXECUTE FUNCTION oaa.assert_current_fence();
ALTER TABLE oaa.incident ENABLE ALWAYS TRIGGER incident_fence;

DROP TRIGGER IF EXISTS incident_timeline_append_only ON oaa.incident_timeline;
CREATE TRIGGER incident_timeline_append_only BEFORE UPDATE OR DELETE ON oaa.incident_timeline
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.incident_timeline ENABLE ALWAYS TRIGGER incident_timeline_append_only;
DROP TRIGGER IF EXISTS incident_timeline_no_truncate ON oaa.incident_timeline;
CREATE TRIGGER incident_timeline_no_truncate BEFORE TRUNCATE ON oaa.incident_timeline
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.incident_timeline ENABLE ALWAYS TRIGGER incident_timeline_no_truncate;

DROP TRIGGER IF EXISTS incident_evidence_append_only ON oaa.incident_evidence;
CREATE TRIGGER incident_evidence_append_only BEFORE UPDATE OR DELETE ON oaa.incident_evidence
  FOR EACH ROW EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.incident_evidence ENABLE ALWAYS TRIGGER incident_evidence_append_only;
DROP TRIGGER IF EXISTS incident_evidence_no_truncate ON oaa.incident_evidence;
CREATE TRIGGER incident_evidence_no_truncate BEFORE TRUNCATE ON oaa.incident_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.incident_evidence ENABLE ALWAYS TRIGGER incident_evidence_no_truncate;

CREATE OR REPLACE FUNCTION oaa.attach_incident_impact(
  p_cluster_id text, p_fencing_epoch bigint, p_incident_id uuid,
  p_node_id text, p_impact_type text, p_distance integer,
  p_confidence numeric, p_path_digest text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
BEGIN
  PERFORM 1 FROM oaa.observer_fence
    WHERE cluster_id = p_cluster_id AND fencing_epoch = p_fencing_epoch
      AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'stale incident writer' USING ERRCODE = '40001'; END IF;
  PERFORM 1 FROM oaa.incident
    WHERE incident_id = p_incident_id AND cluster_id = p_cluster_id
      AND fencing_epoch = p_fencing_epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'incident fence mismatch' USING ERRCODE = '40001'; END IF;
  INSERT INTO oaa.incident_impact(incident_id,node_id,impact_type,distance,confidence,path_digest)
    VALUES(p_incident_id,p_node_id,p_impact_type,p_distance,p_confidence,p_path_digest)
  ON CONFLICT(incident_id,node_id,impact_type) DO UPDATE SET
    distance=EXCLUDED.distance, confidence=EXCLUDED.confidence, path_digest=EXCLUDED.path_digest;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION oaa.attach_incident_evidence(
  p_cluster_id text, p_fencing_epoch bigint, p_incident_id uuid,
  p_observation_id uuid, p_observation_received_at timestamptz,
  p_evidence_role text, p_rank integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
BEGIN
  PERFORM 1 FROM oaa.observer_fence
    WHERE cluster_id = p_cluster_id AND fencing_epoch = p_fencing_epoch
      AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'stale incident writer' USING ERRCODE = '40001'; END IF;
  PERFORM 1 FROM oaa.incident
    WHERE incident_id = p_incident_id AND cluster_id = p_cluster_id
      AND fencing_epoch = p_fencing_epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'incident fence mismatch' USING ERRCODE = '40001'; END IF;
  INSERT INTO oaa.incident_evidence(
    incident_id,observation_id,observation_received_at,evidence_role,rank
  ) VALUES(p_incident_id,p_observation_id,p_observation_received_at,p_evidence_role,p_rank)
  ON CONFLICT DO NOTHING;
  RETURN true;
END $$;

REVOKE ALL ON TABLE oaa.incident, oaa.incident_evidence, oaa.incident_impact,
  oaa.incident_timeline, oaa.incident_outbox FROM opensphere_oaa_observer;
GRANT SELECT ON oaa.incident, oaa.incident_evidence, oaa.incident_impact,
  oaa.incident_timeline, oaa.incident_outbox TO opensphere_oaa_observer;
REVOKE ALL ON FUNCTION oaa.attach_incident_impact(text,bigint,uuid,text,text,integer,numeric,text),
  oaa.attach_incident_evidence(text,bigint,uuid,uuid,timestamptz,text,integer)
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway,
       opensphere_oaa_api, opensphere_oaa_incident_relay, opensphere_oaa_maintenance;
GRANT EXECUTE ON FUNCTION oaa.attach_incident_impact(text,bigint,uuid,text,text,integer,numeric,text),
  oaa.attach_incident_evidence(text,bigint,uuid,uuid,timestamptz,text,integer)
  TO opensphere_oaa_observer;

-- ---------------------------------------------------------------------------
-- M-2: purge checks and DETACH/DROP are now one maintenance-only transaction.
-- Only the two streams that are actually partitioned are accepted.
-- ---------------------------------------------------------------------------

ALTER TABLE oaa.evidence_partition_export
  DROP CONSTRAINT IF EXISTS evidence_partition_export_stream_check;
ALTER TABLE oaa.evidence_partition_export
  ADD CONSTRAINT evidence_partition_export_stream_check
  CHECK (stream IN ('observation','slo_sample','runtime_event','incident_timeline','module_operation_step'));

CREATE OR REPLACE FUNCTION oaa.assert_evidence_purge_allowed(
  p_stream text, p_range_start timestamptz, p_range_end timestamptz, p_export_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
BEGIN
  IF p_stream NOT IN ('observation','slo_sample') THEN RAISE EXCEPTION 'stream is not partition-purge enabled'; END IF;
  IF p_range_end > clock_timestamp() - interval '30 days' THEN RAISE EXCEPTION 'minimum retention window not elapsed'; END IF;
  PERFORM 1 FROM oaa.evidence_partition_export
    WHERE export_id = p_export_id AND stream = p_stream
      AND range_start = p_range_start AND range_end = p_range_end
      AND verified_at IS NOT NULL AND restored_at IS NOT NULL
      AND object_digest ~ '^sha256:[0-9a-f]{64}$';
  IF NOT FOUND THEN RAISE EXCEPTION 'verified export and restore proof required'; END IF;
  PERFORM 1 FROM oaa.evidence_legal_hold WHERE stream = p_stream AND active
    AND tstzrange(range_start,range_end,'[)') && tstzrange(p_range_start,p_range_end,'[)');
  IF FOUND THEN RAISE EXCEPTION 'active legal hold blocks purge'; END IF;
  IF p_stream = 'observation' THEN
    PERFORM 1 FROM oaa.incident_evidence ie JOIN oaa.observation o
      ON o.observation_id=ie.observation_id AND o.received_at=ie.observation_received_at
      WHERE o.received_at>=p_range_start AND o.received_at<p_range_end LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'incident evidence reference blocks purge'; END IF;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION oaa.purge_evidence_partition(
  p_stream text, p_partition_name text, p_range_start timestamptz,
  p_range_end timestamptz, p_export_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
DECLARE parent_table regclass;
DECLARE child_table regclass;
DECLARE expected_name text;
DECLARE qualified_child text;
BEGIN
  IF p_stream NOT IN ('observation','slo_sample') THEN RAISE EXCEPTION 'stream is not partition-purge enabled'; END IF;
  IF p_range_start <> date_trunc('month', p_range_start)
     OR p_range_end <> p_range_start + interval '1 month' THEN
    RAISE EXCEPTION 'purge range must be one exact UTC month';
  END IF;
  expected_name := p_stream || '_' || to_char(p_range_start AT TIME ZONE 'UTC', 'YYYYMM');
  IF p_partition_name <> expected_name THEN RAISE EXCEPTION 'partition identity/range mismatch'; END IF;
  parent_table := CASE p_stream WHEN 'observation' THEN 'oaa.observation'::regclass ELSE 'oaa.slo_sample'::regclass END;
  child_table := to_regclass(format('oaa.%I', p_partition_name));
  IF child_table IS NULL THEN RAISE EXCEPTION 'partition not found'; END IF;
  PERFORM 1 FROM pg_inherits WHERE inhparent = parent_table AND inhrelid = child_table;
  IF NOT FOUND THEN RAISE EXCEPTION 'partition is not an exact child of stream'; END IF;
  PERFORM oaa.assert_evidence_purge_allowed(p_stream,p_range_start,p_range_end,p_export_id);
  qualified_child := format('oaa.%I', p_partition_name);
  EXECUTE format('ALTER TABLE %s DETACH PARTITION %s', parent_table, qualified_child);
  EXECUTE format('DROP TABLE %s', qualified_child);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION oaa.purge_evidence_partition(text,text,timestamptz,timestamptz,uuid)
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway,
       opensphere_oaa_observer, opensphere_oaa_api, opensphere_oaa_incident_relay;
GRANT EXECUTE ON FUNCTION oaa.purge_evidence_partition(text,text,timestamptz,timestamptz,uuid)
  TO opensphere_oaa_maintenance;

-- ---------------------------------------------------------------------------
-- M-3: complete reconcile requires independently recomputable row coverage,
-- page-token exhaustion, authority revision and a deterministic evidence hash.
-- ---------------------------------------------------------------------------

ALTER TABLE oaa.reconcile_session
  ADD COLUMN IF NOT EXISTS observed_resource_count integer CHECK (observed_resource_count IS NULL OR observed_resource_count >= 0),
  ADD COLUMN IF NOT EXISTS page_token_exhausted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS authority_revision text,
  ADD COLUMN IF NOT EXISTS completeness_digest text CHECK (completeness_digest IS NULL OR completeness_digest ~ '^sha256:[0-9a-f]{64}$');

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
  SELECT count(*)::integer, coalesce(string_agg(node_id, E'\n' ORDER BY node_id),'')
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

REVOKE ALL ON FUNCTION oaa.complete_reconcile_session(uuid,integer)
  FROM opensphere_oaa_observer;
REVOKE ALL ON FUNCTION oaa.complete_reconcile_session_v2(uuid,integer,integer,boolean,text,text)
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway,
       opensphere_oaa_api, opensphere_oaa_incident_relay, opensphere_oaa_maintenance;
GRANT EXECUTE ON FUNCTION oaa.complete_reconcile_session_v2(uuid,integer,integer,boolean,text,text)
  TO opensphere_oaa_observer;

-- L-4: R2/R3 approval must be independent from the submitting actor.
CREATE OR REPLACE FUNCTION console.reject_module_operation_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, console AS $$
DECLARE operation_actor uuid;
DECLARE operation_risk text;
BEGIN
  SELECT actor_id, coalesce(requested_risk_class,risk_class)
    INTO operation_actor, operation_risk FROM console.module_operation
    WHERE operation_id=NEW.operation_id;
  IF operation_risk IN ('R2','R3') AND NEW.approver_id=operation_actor THEN
    RAISE EXCEPTION 'R2/R3 operation requires an independent approver';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS module_operation_no_self_approval ON console.module_operation_approval;
CREATE TRIGGER module_operation_no_self_approval BEFORE INSERT OR UPDATE ON console.module_operation_approval
  FOR EACH ROW EXECUTE FUNCTION console.reject_module_operation_self_approval();

-- L-6: remove public from the Engineering SECURITY DEFINER lookup path.
DO $$
DECLARE target regprocedure;
BEGIN
  SELECT p.oid::regprocedure INTO target FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='oaa' AND p.proname='propose_engineering_remediation_v2';
  IF target IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, oaa, console, extensions', target);
  END IF;
END $$;

COMMENT ON FUNCTION oaa.purge_evidence_partition(text,text,timestamptz,timestamptz,uuid)
  IS 'Maintenance-only atomic retention gate plus exact partition detach/drop; direct DDL is not granted.';
COMMENT ON FUNCTION oaa.complete_reconcile_session_v2(uuid,integer,integer,boolean,text,text)
  IS 'Fail-closed reconcile barrier bound to DB-counted resources, exhausted pagination and authority revision evidence.';
