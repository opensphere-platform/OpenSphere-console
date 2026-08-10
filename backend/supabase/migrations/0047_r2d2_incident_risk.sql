\set ON_ERROR_STOP on

-- Wave 2/3: durable Incident, evidence, bounded impact, atomic transition
-- timeline and relay outbox. Notification delivery is deliberately outside
-- this transaction and converges by idempotency key.

CREATE TABLE IF NOT EXISTS oaa.incident (
  incident_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  incident_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('detected','active','recovering','resolved','suspended')),
  severity text NOT NULL CHECK (severity IN ('info','warning','high','critical','unknown')),
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  cause_status text NOT NULL CHECK (cause_status IN ('confirmed','hypothesis','unknown')),
  cause_code text,
  title text NOT NULL,
  first_detected_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  recovering_at timestamptz,
  resolved_at timestamptz,
  suspended_at timestamptz,
  primary_node_id text NOT NULL,
  rule_revision text NOT NULL,
  summary text NOT NULL,
  transition_sequence bigint NOT NULL DEFAULT 0 CHECK (transition_sequence >= 0),
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  fresh_authority_watermark timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (cluster_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS oaa.incident_evidence (
  incident_id uuid NOT NULL REFERENCES oaa.incident(incident_id) ON DELETE RESTRICT,
  observation_id uuid NOT NULL,
  observation_received_at timestamptz NOT NULL,
  evidence_role text NOT NULL CHECK (evidence_role IN ('supports','contradicts','temporal_only','confirms')),
  rank integer NOT NULL CHECK (rank BETWEEN 0 AND 1000),
  PRIMARY KEY (incident_id, observation_id, observation_received_at),
  FOREIGN KEY (observation_id, observation_received_at) REFERENCES oaa.observation(observation_id, received_at) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS oaa.incident_impact (
  incident_id uuid NOT NULL REFERENCES oaa.incident(incident_id) ON DELETE RESTRICT,
  node_id text NOT NULL,
  impact_type text NOT NULL CHECK (impact_type IN ('direct','downstream','route','capability','unknown')),
  distance integer NOT NULL CHECK (distance BETWEEN 0 AND 32),
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  path_digest text NOT NULL CHECK (path_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (incident_id, node_id, impact_type)
);

CREATE TABLE IF NOT EXISTS oaa.incident_timeline (
  incident_id uuid NOT NULL REFERENCES oaa.incident(incident_id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  transition text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  transition_sequence bigint NOT NULL CHECK (transition_sequence > 0),
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  reason_code text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (incident_id, sequence),
  UNIQUE (incident_id, transition_sequence)
);

CREATE TABLE IF NOT EXISTS oaa.incident_outbox (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES oaa.incident(incident_id) ON DELETE RESTRICT,
  transition_sequence bigint NOT NULL CHECK (transition_sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'incident_detected','incident_activated','incident_severity_changed',
    'incident_recovering','incident_resolved','incident_suspended','incident_resumed'
  )),
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','delivered','retry','dead-letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_by text,
  claim_expires_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (incident_id, transition_sequence)
);

CREATE INDEX IF NOT EXISTS incident_active_severity_idx
  ON oaa.incident (cluster_id, severity, last_observed_at DESC)
  WHERE status IN ('detected','active','recovering');
CREATE INDEX IF NOT EXISTS incident_primary_node_idx
  ON oaa.incident (cluster_id, primary_node_id, status);
CREATE INDEX IF NOT EXISTS incident_outbox_claim_idx
  ON oaa.incident_outbox (status, next_attempt_at, created_at)
  WHERE status IN ('pending','retry');
CREATE INDEX IF NOT EXISTS incident_outbox_replay_idx
  ON oaa.incident_outbox (created_at, outbox_id);

CREATE OR REPLACE FUNCTION oaa.valid_incident_transition(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from IS NULL THEN p_to = 'detected'
    WHEN p_from = p_to THEN true
    WHEN p_from = 'detected' THEN p_to IN ('active','resolved','suspended')
    WHEN p_from = 'active' THEN p_to IN ('recovering','suspended')
    WHEN p_from = 'recovering' THEN p_to IN ('active','resolved','suspended')
    WHEN p_from = 'suspended' THEN p_to IN ('detected','active')
    WHEN p_from = 'resolved' THEN p_to = 'detected'
    ELSE false END
$$;

CREATE OR REPLACE FUNCTION oaa.transition_incident(
  p_cluster_id text,
  p_fencing_epoch bigint,
  p_fingerprint text,
  p_incident_type text,
  p_to_status text,
  p_severity text,
  p_confidence numeric,
  p_cause_status text,
  p_cause_code text,
  p_title text,
  p_primary_node_id text,
  p_rule_revision text,
  p_summary text,
  p_reason_code text,
  p_evidence_digest text,
  p_event_type text,
  p_payload jsonb,
  p_observed_at timestamptz,
  p_fresh_authority_watermark timestamptz DEFAULT NULL
) RETURNS TABLE(incident_id uuid, transition_sequence bigint, outbox_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
DECLARE current_row oaa.incident%ROWTYPE;
DECLARE resulting_id uuid;
DECLARE next_sequence bigint;
DECLARE resulting_outbox uuid;
BEGIN
  PERFORM 1 FROM oaa.observer_fence WHERE cluster_id = p_cluster_id
    AND fencing_epoch = p_fencing_epoch AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'stale incident writer' USING ERRCODE = '40001'; END IF;
  SELECT * INTO current_row FROM oaa.incident
    WHERE cluster_id = p_cluster_id AND fingerprint = p_fingerprint FOR UPDATE;
  IF FOUND AND NOT oaa.valid_incident_transition(current_row.status, p_to_status) THEN
    RAISE EXCEPTION 'invalid incident transition % -> %', current_row.status, p_to_status;
  END IF;
  IF p_to_status = 'resolved' THEN
    IF p_fresh_authority_watermark IS NULL OR p_fresh_authority_watermark <= current_row.last_observed_at THEN
      RAISE EXCEPTION 'resolution requires a newer fresh-authority watermark';
    END IF;
  END IF;
  next_sequence := coalesce(current_row.transition_sequence, 0) + 1;
  INSERT INTO oaa.incident(cluster_id, fingerprint, incident_type, status, severity, confidence,
    cause_status, cause_code, title, first_detected_at, last_observed_at, recovering_at,
    resolved_at, suspended_at, primary_node_id, rule_revision, summary, transition_sequence,
    fencing_epoch, fresh_authority_watermark)
  VALUES (p_cluster_id, p_fingerprint, p_incident_type, p_to_status, p_severity, p_confidence,
    p_cause_status, p_cause_code, p_title, p_observed_at, p_observed_at,
    CASE WHEN p_to_status = 'recovering' THEN p_observed_at END,
    CASE WHEN p_to_status = 'resolved' THEN p_observed_at END,
    CASE WHEN p_to_status = 'suspended' THEN p_observed_at END,
    p_primary_node_id, p_rule_revision, p_summary, next_sequence, p_fencing_epoch,
    p_fresh_authority_watermark)
  ON CONFLICT (cluster_id, fingerprint) DO UPDATE SET
    status = EXCLUDED.status, severity = EXCLUDED.severity, confidence = EXCLUDED.confidence,
    cause_status = EXCLUDED.cause_status, cause_code = EXCLUDED.cause_code, title = EXCLUDED.title,
    last_observed_at = EXCLUDED.last_observed_at,
    recovering_at = CASE WHEN EXCLUDED.status = 'recovering' THEN EXCLUDED.last_observed_at ELSE oaa.incident.recovering_at END,
    resolved_at = CASE WHEN EXCLUDED.status = 'resolved' THEN EXCLUDED.last_observed_at ELSE NULL END,
    suspended_at = CASE WHEN EXCLUDED.status = 'suspended' THEN EXCLUDED.last_observed_at ELSE NULL END,
    primary_node_id = EXCLUDED.primary_node_id, rule_revision = EXCLUDED.rule_revision,
    summary = EXCLUDED.summary, transition_sequence = EXCLUDED.transition_sequence,
    fencing_epoch = EXCLUDED.fencing_epoch, fresh_authority_watermark = EXCLUDED.fresh_authority_watermark,
    updated_at = clock_timestamp()
  RETURNING oaa.incident.incident_id INTO resulting_id;
  INSERT INTO oaa.incident_timeline(incident_id, sequence, transition, from_status, to_status,
    transition_sequence, fencing_epoch, reason_code, evidence_digest, occurred_at)
  VALUES (resulting_id, next_sequence, coalesce(current_row.status, 'none') || '->' || p_to_status,
    current_row.status, p_to_status, next_sequence, p_fencing_epoch, p_reason_code,
    p_evidence_digest, p_observed_at);
  INSERT INTO oaa.incident_outbox(incident_id, transition_sequence, event_type, idempotency_key, payload)
  VALUES (resulting_id, next_sequence, p_event_type, resulting_id::text || ':' || next_sequence::text, p_payload)
  RETURNING oaa.incident_outbox.outbox_id INTO resulting_outbox;
  RETURN QUERY SELECT resulting_id, next_sequence, resulting_outbox;
END $$;

CREATE OR REPLACE FUNCTION oaa.claim_incident_outbox(p_worker text, p_limit integer DEFAULT 50)
RETURNS SETOF oaa.incident_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, oaa AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT outbox_id FROM oaa.incident_outbox
    WHERE status IN ('pending','retry') AND next_attempt_at <= clock_timestamp()
      AND (claim_expires_at IS NULL OR claim_expires_at < clock_timestamp())
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT greatest(1, least(p_limit, 100))
  )
  UPDATE oaa.incident_outbox o SET status = 'claimed', claimed_by = p_worker,
    claim_expires_at = clock_timestamp() + interval '30 seconds', attempt_count = attempt_count + 1,
    updated_at = clock_timestamp()
  FROM candidates c WHERE o.outbox_id = c.outbox_id RETURNING o.*;
END $$;

ALTER TABLE oaa.incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.incident_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.incident_impact ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.incident_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE oaa.incident_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE oaa.incident, oaa.incident_evidence, oaa.incident_impact,
  oaa.incident_timeline, oaa.incident_outbox
  FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway;
GRANT SELECT, INSERT, UPDATE ON oaa.incident TO opensphere_oaa_observer;
GRANT SELECT, INSERT ON oaa.incident_evidence, oaa.incident_impact, oaa.incident_timeline, oaa.incident_outbox TO opensphere_oaa_observer;
GRANT SELECT ON oaa.incident, oaa.incident_evidence, oaa.incident_impact, oaa.incident_timeline TO opensphere_oaa_api, opensphere_oaa_gateway;
GRANT SELECT, UPDATE ON oaa.incident_outbox TO opensphere_oaa_incident_relay;
GRANT USAGE ON SCHEMA oaa TO opensphere_oaa_incident_relay;
GRANT USAGE ON SCHEMA console TO opensphere_oaa_incident_relay;
GRANT SELECT, INSERT ON console.notification_event TO opensphere_oaa_incident_relay;
GRANT SELECT ON oaa.incident_outbox TO opensphere_oaa_api, opensphere_oaa_gateway;
REVOKE ALL ON FUNCTION oaa.transition_incident(text,bigint,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text,jsonb,timestamptz,timestamptz),
  oaa.claim_incident_outbox(text,integer) FROM PUBLIC, anon, authenticated, service_role, opensphere_oaa_gateway;
GRANT EXECUTE ON FUNCTION oaa.transition_incident(text,bigint,text,text,text,text,numeric,text,text,text,text,text,text,text,text,text,jsonb,timestamptz,timestamptz)
  TO opensphere_oaa_observer;
GRANT EXECUTE ON FUNCTION oaa.claim_incident_outbox(text,integer) TO opensphere_oaa_incident_relay;

CREATE POLICY observer_incident_policy ON oaa.incident FOR ALL TO opensphere_oaa_observer USING (true) WITH CHECK (true);
CREATE POLICY observer_incident_evidence_policy ON oaa.incident_evidence FOR SELECT TO opensphere_oaa_observer USING (true);
CREATE POLICY observer_incident_evidence_insert_policy ON oaa.incident_evidence FOR INSERT TO opensphere_oaa_observer WITH CHECK (true);
CREATE POLICY observer_incident_impact_policy ON oaa.incident_impact FOR SELECT TO opensphere_oaa_observer USING (true);
CREATE POLICY observer_incident_impact_insert_policy ON oaa.incident_impact FOR INSERT TO opensphere_oaa_observer WITH CHECK (true);
CREATE POLICY observer_incident_timeline_policy ON oaa.incident_timeline FOR SELECT TO opensphere_oaa_observer USING (true);
CREATE POLICY observer_incident_timeline_insert_policy ON oaa.incident_timeline FOR INSERT TO opensphere_oaa_observer WITH CHECK (true);
CREATE POLICY observer_incident_outbox_policy ON oaa.incident_outbox FOR SELECT TO opensphere_oaa_observer USING (true);
CREATE POLICY observer_incident_outbox_insert_policy ON oaa.incident_outbox FOR INSERT TO opensphere_oaa_observer WITH CHECK (true);
CREATE POLICY api_incident_policy ON oaa.incident FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);
CREATE POLICY api_incident_evidence_policy ON oaa.incident_evidence FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);
CREATE POLICY api_incident_impact_policy ON oaa.incident_impact FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);
CREATE POLICY api_incident_timeline_policy ON oaa.incident_timeline FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);
CREATE POLICY relay_incident_outbox_policy ON oaa.incident_outbox FOR ALL TO opensphere_oaa_incident_relay USING (true) WITH CHECK (true);
CREATE POLICY r2d2_relay_notification_event_policy ON console.notification_event FOR SELECT TO opensphere_oaa_incident_relay USING (true);
CREATE POLICY r2d2_relay_notification_event_insert_policy ON console.notification_event FOR INSERT TO opensphere_oaa_incident_relay WITH CHECK (source_type = 'r2d2_incident');
CREATE POLICY api_incident_outbox_policy ON oaa.incident_outbox FOR SELECT TO opensphere_oaa_api, opensphere_oaa_gateway USING (true);

COMMENT ON TABLE oaa.incident IS 'Advisory risk projection derived from fresh authority evidence; never admission or desired-state authority.';
COMMENT ON TABLE oaa.incident_outbox IS 'Atomic OAA incident transition outbox; Console notification is an idempotent downstream relay.';
