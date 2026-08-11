\set ON_ERROR_STOP on

-- Activation follow-up: OperationalQueryService reads the observer fence via
-- the Gateway query pool. Keep the observer writer's existing privileges and
-- grant only the read access required by the API projection.
GRANT SELECT ON oaa.observer_fence TO opensphere_oaa_gateway, opensphere_oaa_api;

DROP POLICY IF EXISTS api_observer_fence_policy ON oaa.observer_fence;
CREATE POLICY api_observer_fence_policy ON oaa.observer_fence
  FOR SELECT TO opensphere_oaa_gateway, opensphere_oaa_api USING (true);

COMMENT ON POLICY api_observer_fence_policy ON oaa.observer_fence
  IS 'Read-only observer leader/fence projection for the R2D2 operational status API.';
