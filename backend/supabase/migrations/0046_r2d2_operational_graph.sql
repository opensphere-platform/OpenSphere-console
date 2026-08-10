\set ON_ERROR_STOP on

-- Wave 1: fenced, rebuildable Operational Graph projection. Kubernetes,
-- Registry, Release, Gitea, HIS and owner APIs remain authoritative.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_oaa_observer') THEN
    CREATE ROLE opensphere_oaa_observer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_oaa_api') THEN
    CREATE ROLE opensphere_oaa_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_oaa_incident_relay') THEN
    CREATE ROLE opensphere_oaa_incident_relay NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_oaa_maintenance') THEN
    CREATE ROLE opensphere_oaa_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

ALTER TABLE oaa.runtime_resource
  ADD COLUMN IF NOT EXISTS authority_uid text,
  ADD COLUMN IF NOT EXISTS collection_epoch bigint,
  ADD COLUMN IF NOT EXISTS stream_sequence bigint,
  ADD COLUMN IF NOT EXISTS reconcile_session_id uuid,
  ADD COLUMN IF NOT EXISTS snapshot_complete boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS oaa.observer_fence (
  cluster_id text PRIMARY KEY,
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  collector_id text NOT NULL,
  lease_identity text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS oaa.reconcile_session (
  reconcile_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id text NOT NULL,
  source text NOT NULL,
  collector_id text NOT NULL,
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  collection_epoch bigint NOT NULL CHECK (collection_epoch > 0),
  source_revision text,
  expected_scope_count integer NOT NULL CHECK (expected_scope_count >= 0),
  completed_scope_count integer NOT NULL DEFAULT 0 CHECK (completed_scope_count >= 0),
  snapshot_complete boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (cluster_id, source, collection_epoch)
);

CREATE TABLE IF NOT EXISTS oaa.source_health (
  cluster_id text NOT NULL,
  source text NOT NULL,
  epistemic_state text NOT NULL DEFAULT 'unknown'
    CHECK (epistemic_state IN ('known','unknown','stale','conflicting','inferred','unobservable')),
  configured boolean NOT NULL DEFAULT true,
  snapshot_complete boolean NOT NULL DEFAULT false,
  last_complete_session_id uuid,
  last_complete_at timestamptz,
  last_received_at timestamptz,
  lag_seconds integer,
  blocker_code text,
  evidence_ref text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (cluster_id, source)
);

CREATE TABLE IF NOT EXISTS oaa.resource_node (
  cluster_id text NOT NULL,
  node_id text NOT NULL,
  node_type text NOT NULL,
  canonical_id text NOT NULL,
  authority text NOT NULL,
  authority_uid text NOT NULL,
  display_name text NOT NULL,
  namespace text NOT NULL DEFAULT '',
  owner_ref text,
  health text NOT NULL DEFAULT 'Unknown',
  epistemic_state text NOT NULL DEFAULT 'unknown'
    CHECK (epistemic_state IN ('known','unknown','stale','conflicting','inferred','unobservable')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  collection_epoch bigint NOT NULL CHECK (collection_epoch > 0),
  stream_sequence bigint,
  source_revision text,
  reconcile_session_id uuid NOT NULL,
  snapshot_complete boolean NOT NULL DEFAULT false,
  observed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  deleted_at timestamptz,
  PRIMARY KEY (cluster_id, node_id),
  UNIQUE (cluster_id, authority, authority_uid)
);

CREATE TABLE IF NOT EXISTS oaa.resource_relation (
  cluster_id text NOT NULL,
  from_node_id text NOT NULL,
  relation_type text NOT NULL CHECK (relation_type IN (
    'owns','contains','selects','serves','routes_to','depends_on','optionally_depends_on',
    'declares','realizes','observes','affects','executed_by'
  )),
  to_node_id text NOT NULL,
  authority text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('confirmed','probable','possible')),
  evidence_ref text NOT NULL,
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  collection_epoch bigint NOT NULL CHECK (collection_epoch > 0),
  source_revision text,
  reconcile_session_id uuid NOT NULL,
  observed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (cluster_id, from_node_id, relation_type, to_node_id, authority),
  CHECK (from_node_id <> to_node_id)
);

CREATE TABLE IF NOT EXISTS oaa.observation (
  observation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  cluster_id text NOT NULL,
  source text NOT NULL,
  source_event_id text NOT NULL,
  subject_node_id text NOT NULL,
  observation_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','high','critical','unknown')),
  fact jsonb NOT NULL CHECK (jsonb_typeof(fact) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  evidence_ref text NOT NULL,
  collector_id text NOT NULL,
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  collection_epoch bigint NOT NULL CHECK (collection_epoch > 0),
  stream_sequence bigint,
  source_revision text,
  reconcile_session_id uuid NOT NULL,
  snapshot_complete boolean NOT NULL DEFAULT false,
  observed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (observation_id, received_at),
  UNIQUE (cluster_id, source, source_event_id, received_at)
) PARTITION BY RANGE(received_at);

-- Create a bounded rolling window. The maintenance role must add future
-- partitions before the horizon; inserts fail closed when no partition exists.
DO $$
DECLARE month_start date; partition_name text; offset_month integer;
BEGIN
  FOR offset_month IN -1..3 LOOP
    month_start := (date_trunc('month', clock_timestamp()) + make_interval(months => offset_month))::date;
    partition_name := 'observation_' || to_char(month_start, 'YYYYMM');
    EXECUTE format('CREATE TABLE IF NOT EXISTS oaa.%I PARTITION OF oaa.observation FOR VALUES FROM (%L) TO (%L)',
      partition_name, month_start, (month_start + interval '1 month')::date);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS resource_node_current_idx
  ON oaa.resource_node (cluster_id, node_type, namespace, health)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS resource_node_freshness_idx
  ON oaa.resource_node (cluster_id, expires_at, epistemic_state)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS resource_relation_from_idx
  ON oaa.resource_relation (cluster_id, from_node_id, relation_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS resource_relation_to_idx
  ON oaa.resource_relation (cluster_id, to_node_id, relation_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS observation_subject_time_idx
  ON oaa.observation (cluster_id, subject_node_id, received_at DESC);

CREATE OR REPLACE FUNCTION oaa.assert_current_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
DECLARE current_epoch bigint;
BEGIN
  SELECT fencing_epoch INTO current_epoch FROM oaa.observer_fence WHERE cluster_id = NEW.cluster_id;
  IF current_epoch IS NULL OR NEW.fencing_epoch <> current_epoch THEN
    RAISE EXCEPTION 'stale observer fencing epoch: % != %', NEW.fencing_epoch, current_epoch
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS resource_node_fence ON oaa.resource_node;
CREATE TRIGGER resource_node_fence BEFORE INSERT OR UPDATE ON oaa.resource_node
  FOR EACH ROW EXECUTE FUNCTION oaa.assert_current_fence();
DROP TRIGGER IF EXISTS resource_relation_fence ON oaa.resource_relation;
CREATE TRIGGER resource_relation_fence BEFORE INSERT OR UPDATE ON oaa.resource_relation
  FOR EACH ROW EXECUTE FUNCTION oaa.assert_current_fence();
DROP TRIGGER IF EXISTS observation_fence ON oaa.observation;
CREATE TRIGGER observation_fence BEFORE INSERT ON oaa.observation
  FOR EACH ROW EXECUTE FUNCTION oaa.assert_current_fence();

CREATE OR REPLACE FUNCTION oaa.claim_observer_epoch(
  p_cluster_id text, p_collector_id text, p_lease_identity text, p_ttl_seconds integer DEFAULT 60
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
DECLARE next_epoch bigint;
BEGIN
  IF length(btrim(coalesce(p_cluster_id, ''))) < 1 OR length(btrim(coalesce(p_collector_id, ''))) < 3
     OR length(btrim(coalesce(p_lease_identity, ''))) < 3 THEN
    RAISE EXCEPTION 'cluster, collector and lease identity are required';
  END IF;
  IF p_ttl_seconds < 15 OR p_ttl_seconds > 300 THEN RAISE EXCEPTION 'invalid observer ttl'; END IF;
  INSERT INTO oaa.observer_fence(cluster_id, fencing_epoch, collector_id, lease_identity, lease_expires_at)
  VALUES (btrim(p_cluster_id), 1, btrim(p_collector_id), btrim(p_lease_identity), clock_timestamp() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (cluster_id) DO UPDATE SET
    fencing_epoch = oaa.observer_fence.fencing_epoch + 1,
    collector_id = EXCLUDED.collector_id,
    lease_identity = EXCLUDED.lease_identity,
    lease_expires_at = EXCLUDED.lease_expires_at,
    heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
  RETURNING fencing_epoch INTO next_epoch;
  RETURN next_epoch;
END $$;

CREATE OR REPLACE FUNCTION oaa.renew_observer_epoch(
  p_cluster_id text, p_collector_id text, p_fencing_epoch bigint, p_ttl_seconds integer DEFAULT 60
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
BEGIN
  UPDATE oaa.observer_fence SET
    lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds),
    heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE cluster_id = p_cluster_id AND collector_id = p_collector_id
    AND fencing_epoch = p_fencing_epoch AND lease_expires_at > clock_timestamp();
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION oaa.complete_reconcile_session(
  p_session_id uuid, p_completed_scope_count integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
DECLARE session_row oaa.reconcile_session%ROWTYPE;
BEGIN
  SELECT * INTO session_row FROM oaa.reconcile_session WHERE reconcile_session_id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconcile session not found'; END IF;
  PERFORM 1 FROM oaa.observer_fence
    WHERE cluster_id = session_row.cluster_id AND fencing_epoch = session_row.fencing_epoch
      AND collector_id = session_row.collector_id AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'stale reconcile session' USING ERRCODE = '40001'; END IF;
  IF p_completed_scope_count <> session_row.expected_scope_count THEN
    RAISE EXCEPTION 'incomplete reconcile barrier: %/%', p_completed_scope_count, session_row.expected_scope_count;
  END IF;
  UPDATE oaa.reconcile_session SET completed_scope_count = p_completed_scope_count,
    snapshot_complete = true, completed_at = clock_timestamp() WHERE reconcile_session_id = p_session_id;
  INSERT INTO oaa.source_health(cluster_id, source, epistemic_state, configured, snapshot_complete,
    last_complete_session_id, last_complete_at, last_received_at, lag_seconds, blocker_code, evidence_ref)
  VALUES (session_row.cluster_id, session_row.source, 'known', true, true, p_session_id,
    clock_timestamp(), clock_timestamp(), 0, NULL, 'reconcile:' || p_session_id::text)
  ON CONFLICT (cluster_id, source) DO UPDATE SET epistemic_state = 'known', snapshot_complete = true,
    last_complete_session_id = EXCLUDED.last_complete_session_id, last_complete_at = EXCLUDED.last_complete_at,
    last_received_at = EXCLUDED.last_received_at, lag_seconds = 0, blocker_code = NULL,
    evidence_ref = EXCLUDED.evidence_ref, updated_at = clock_timestamp();
  RETURN true;
END $$;

ALTER TABLE oaa.observer_fence ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.reconcile_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.source_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.resource_node ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.resource_relation ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.observation ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE oaa.observer_fence, oaa.reconcile_session, oaa.source_health,
  oaa.resource_node, oaa.resource_relation, oaa.observation
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway;
GRANT USAGE ON SCHEMA oaa TO opensphere_oaa_observer, opensphere_oaa_api, opensphere_oaa_maintenance;
GRANT SELECT, INSERT, UPDATE ON oaa.observer_fence, oaa.reconcile_session, oaa.source_health,
  oaa.resource_node, oaa.resource_relation TO opensphere_oaa_observer;
GRANT SELECT, INSERT ON oaa.observation TO opensphere_oaa_observer;
GRANT SELECT ON oaa.source_health, oaa.resource_node, oaa.resource_relation, oaa.observation TO opensphere_oaa_api;
GRANT SELECT ON oaa.source_health, oaa.resource_node, oaa.resource_relation, oaa.observation TO opensphere_oaa_gateway;
GRANT EXECUTE ON FUNCTION oaa.claim_observer_epoch(text,text,text,integer),
  oaa.renew_observer_epoch(text,text,bigint,integer), oaa.complete_reconcile_session(uuid,integer)
  TO opensphere_oaa_observer;
REVOKE ALL ON FUNCTION oaa.claim_observer_epoch(text,text,text,integer),
  oaa.renew_observer_epoch(text,text,bigint,integer), oaa.complete_reconcile_session(uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway;

DROP POLICY IF EXISTS observer_fence_policy ON oaa.observer_fence;
CREATE POLICY observer_fence_policy ON oaa.observer_fence FOR ALL TO opensphere_oaa_observer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS observer_reconcile_policy ON oaa.reconcile_session;
CREATE POLICY observer_reconcile_policy ON oaa.reconcile_session FOR ALL TO opensphere_oaa_observer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS observer_source_health_policy ON oaa.source_health;
CREATE POLICY observer_source_health_policy ON oaa.source_health FOR ALL TO opensphere_oaa_observer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS observer_node_policy ON oaa.resource_node;
CREATE POLICY observer_node_policy ON oaa.resource_node FOR ALL TO opensphere_oaa_observer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS observer_relation_policy ON oaa.resource_relation;
CREATE POLICY observer_relation_policy ON oaa.resource_relation FOR ALL TO opensphere_oaa_observer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS observer_observation_policy ON oaa.observation;
CREATE POLICY observer_observation_policy ON oaa.observation FOR SELECT TO opensphere_oaa_observer USING (true);
CREATE POLICY observer_observation_insert_policy ON oaa.observation FOR INSERT TO opensphere_oaa_observer WITH CHECK (true);
DROP POLICY IF EXISTS api_source_health_policy ON oaa.source_health;
CREATE POLICY api_source_health_policy ON oaa.source_health FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);
DROP POLICY IF EXISTS api_node_policy ON oaa.resource_node;
CREATE POLICY api_node_policy ON oaa.resource_node FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);
DROP POLICY IF EXISTS api_relation_policy ON oaa.resource_relation;
CREATE POLICY api_relation_policy ON oaa.resource_relation FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);
DROP POLICY IF EXISTS api_observation_policy ON oaa.observation;
CREATE POLICY api_observation_policy ON oaa.observation FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);

COMMENT ON TABLE oaa.resource_node IS 'Rebuildable R2D2 graph node projection; never desired/live authority.';
COMMENT ON TABLE oaa.resource_relation IS 'Closed-vocabulary evidence-bound R2D2 graph relation projection.';
COMMENT ON TABLE oaa.observation IS 'Append-only sanitized fact evidence used for correlation; external text is untrusted data.';
