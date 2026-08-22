\set ON_ERROR_STOP on

-- The JavaScript incident state machine permits a short-lived condition to
-- clear before activation (detected -> recovering). The database authority
-- must accept the same transition or one stale EndpointSlice can abort every
-- subsequent observer reconciliation. Keep the SQL authority explicit and in
-- lockstep with incident-engine.js.
CREATE OR REPLACE FUNCTION osaa.valid_incident_transition(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from IS NULL THEN p_to = 'detected'
    WHEN p_from = p_to THEN true
    WHEN p_from = 'detected' THEN p_to IN ('active','recovering','resolved','suspended')
    WHEN p_from = 'active' THEN p_to IN ('recovering','suspended')
    WHEN p_from = 'recovering' THEN p_to IN ('active','resolved','suspended')
    WHEN p_from = 'suspended' THEN p_to IN ('detected','active')
    WHEN p_from = 'resolved' THEN p_to = 'detected'
    ELSE false END
$$;

COMMENT ON FUNCTION osaa.valid_incident_transition(text,text) IS
  'Canonical OSAA incident transition authority. Must remain equivalent to opensphere-console-osaa-gateway/incident-engine.js.';
