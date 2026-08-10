\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS oaa.evidence_partition_export (
  export_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream text NOT NULL CHECK (stream IN ('observation','runtime_event','incident_timeline','module_operation_step')),
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL CHECK (range_end>range_start),
  row_count bigint NOT NULL CHECK (row_count>=0),
  object_ref text NOT NULL CHECK (length(object_ref) BETWEEN 8 AND 1000),
  object_digest text NOT NULL CHECK (object_digest ~ '^sha256:[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL,
  verified_by text NOT NULL,
  restored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(stream,range_start,range_end)
);

CREATE TABLE IF NOT EXISTS oaa.evidence_legal_hold (
  hold_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream text NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL CHECK (range_end>range_start),
  reason text NOT NULL CHECK (length(btrim(reason))>=8),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_by text,
  released_at timestamptz
);

CREATE TABLE IF NOT EXISTS oaa.slo_sample (
  sampled_at timestamptz NOT NULL,
  metric text NOT NULL CHECK (metric IN (
    'projection_latency_ms','incident_detection_latency_ms','global_propagation_latency_ms',
    'graph_query_latency_ms','incident_query_latency_ms','observer_failover_ms','queue_depth',
    'queue_dropped','relay_lag_seconds','db_pool_wait_ms','coverage_ratio'
  )),
  value numeric NOT NULL,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(labels)='object'),
  PRIMARY KEY(sampled_at,metric)
) PARTITION BY RANGE(sampled_at);

DO $$
DECLARE month_start date; partition_name text; offset_month integer;
BEGIN
  FOR offset_month IN -1..3 LOOP
    month_start := (date_trunc('month',clock_timestamp())+make_interval(months=>offset_month))::date;
    partition_name := 'slo_sample_'||to_char(month_start,'YYYYMM');
    EXECUTE format('CREATE TABLE IF NOT EXISTS oaa.%I PARTITION OF oaa.slo_sample FOR VALUES FROM (%L) TO (%L)',
      partition_name,month_start,(month_start+interval '1 month')::date);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION oaa.ensure_time_partitions(p_month date)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa AS $$
DECLARE month_start date := date_trunc('month',p_month)::date;
BEGIN
  IF month_start < date_trunc('month',clock_timestamp())::date OR month_start > (date_trunc('month',clock_timestamp())+interval '12 months')::date THEN
    RAISE EXCEPTION 'partition month outside maintenance horizon';
  END IF;
  EXECUTE format('CREATE TABLE IF NOT EXISTS oaa.%I PARTITION OF oaa.observation FOR VALUES FROM (%L) TO (%L)',
    'observation_'||to_char(month_start,'YYYYMM'),month_start,(month_start+interval '1 month')::date);
  EXECUTE format('CREATE TABLE IF NOT EXISTS oaa.%I PARTITION OF oaa.slo_sample FOR VALUES FROM (%L) TO (%L)',
    'slo_sample_'||to_char(month_start,'YYYYMM'),month_start,(month_start+interval '1 month')::date);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION oaa.assert_evidence_purge_allowed(
  p_stream text,p_range_start timestamptz,p_range_end timestamptz,p_export_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,oaa AS $$
BEGIN
  IF p_range_end>clock_timestamp()-interval '30 days' THEN RAISE EXCEPTION 'minimum retention window not elapsed'; END IF;
  PERFORM 1 FROM oaa.evidence_partition_export WHERE export_id=p_export_id AND stream=p_stream
    AND range_start<=p_range_start AND range_end>=p_range_end AND verified_at IS NOT NULL AND object_digest~'^sha256:[0-9a-f]{64}$';
  IF NOT FOUND THEN RAISE EXCEPTION 'verified export proof required'; END IF;
  PERFORM 1 FROM oaa.evidence_legal_hold WHERE stream=p_stream AND active
    AND tstzrange(range_start,range_end,'[)') && tstzrange(p_range_start,p_range_end,'[)');
  IF FOUND THEN RAISE EXCEPTION 'active legal hold blocks purge'; END IF;
  IF p_stream='observation' THEN
    PERFORM 1 FROM oaa.incident_evidence ie JOIN oaa.observation o
      ON o.observation_id=ie.observation_id AND o.received_at=ie.observation_received_at
      WHERE o.received_at>=p_range_start AND o.received_at<p_range_end LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'incident evidence reference blocks purge'; END IF;
  END IF;
  RETURN true;
END $$;

ALTER TABLE oaa.evidence_partition_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.evidence_legal_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.slo_sample ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON oaa.evidence_partition_export,oaa.evidence_legal_hold,oaa.slo_sample FROM PUBLIC,anon,authenticated,service_role,opensphere_oaa_gateway;
GRANT SELECT ON oaa.evidence_partition_export,oaa.evidence_legal_hold,oaa.slo_sample TO opensphere_oaa_api,opensphere_oaa_gateway;
GRANT SELECT,INSERT,UPDATE ON oaa.evidence_partition_export,oaa.evidence_legal_hold,oaa.slo_sample TO opensphere_oaa_maintenance;
GRANT SELECT ON oaa.source_health TO opensphere_oaa_maintenance;
GRANT EXECUTE ON FUNCTION oaa.ensure_time_partitions(date),oaa.assert_evidence_purge_allowed(text,timestamptz,timestamptz,uuid) TO opensphere_oaa_maintenance;
REVOKE ALL ON FUNCTION oaa.ensure_time_partitions(date),oaa.assert_evidence_purge_allowed(text,timestamptz,timestamptz,uuid) FROM PUBLIC,anon,authenticated,service_role,opensphere_oaa_gateway,opensphere_oaa_observer,opensphere_oaa_api;
CREATE POLICY api_partition_export ON oaa.evidence_partition_export FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY api_legal_hold ON oaa.evidence_legal_hold FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY api_slo_sample ON oaa.slo_sample FOR SELECT TO opensphere_oaa_api,opensphere_oaa_gateway USING(true);
CREATE POLICY maintenance_partition_export ON oaa.evidence_partition_export FOR ALL TO opensphere_oaa_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance_legal_hold ON oaa.evidence_legal_hold FOR ALL TO opensphere_oaa_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintenance_slo_sample ON oaa.slo_sample FOR ALL TO opensphere_oaa_maintenance USING(true) WITH CHECK(true);

COMMENT ON FUNCTION oaa.assert_evidence_purge_allowed IS 'Fail-closed retention gate; actual detach/drop remains a separately approved maintenance action.';
