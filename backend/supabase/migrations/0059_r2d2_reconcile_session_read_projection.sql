\set ON_ERROR_STOP on

-- Runtime readiness joins operational nodes to the latest complete reconcile
-- barrier.  The gateway may inspect that barrier, but it must not mutate it.
REVOKE ALL ON TABLE oaa.reconcile_session
  FROM opensphere_oaa_gateway, opensphere_oaa_api;
GRANT SELECT ON TABLE oaa.reconcile_session
  TO opensphere_oaa_gateway, opensphere_oaa_api;

DROP POLICY IF EXISTS api_reconcile_session_policy ON oaa.reconcile_session;
CREATE POLICY api_reconcile_session_policy ON oaa.reconcile_session
  FOR SELECT TO opensphere_oaa_gateway, opensphere_oaa_api
  USING (true);

COMMENT ON POLICY api_reconcile_session_policy ON oaa.reconcile_session IS
  'Read-only reconcile barrier projection used by R2D2 operational freshness checks.';
