\set ON_ERROR_STOP on

-- Engineering Remediation uses the existing module_operation ledger for
-- approvals/correlation, but it is not an owner-facade operation.  Keep it out
-- of the generic durable-operation worker so an approval can never turn a
-- proposal into an accidental owner call.

CREATE OR REPLACE FUNCTION console.claim_module_operation(
  p_worker text, p_claim_epoch bigint, p_limit integer DEFAULT 10
) RETURNS SETOF console.module_operation LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
BEGIN
  IF length(btrim(coalesce(p_worker, ''))) < 3 OR p_claim_epoch < 1 THEN RAISE EXCEPTION 'worker and epoch required'; END IF;
  UPDATE console.module_operation SET
    phase = 'TimedOut', execution_state = 'timed_out', updated_at = clock_timestamp()
  WHERE deadline_at <= clock_timestamp()
    AND action <> 'engineering-remediation'
    AND phase IN ('Queued','AwaitingApproval','Claimed','Preflighting');

  RETURN QUERY
  WITH candidates AS (
    SELECT operation_id FROM console.module_operation
    WHERE action <> 'engineering-remediation'
      AND phase IN ('Queued','Running','Ambiguous','Reconciling','Verifying')
      AND next_attempt_at <= clock_timestamp()
      AND deadline_at > clock_timestamp()
      AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
      AND (
        requested_risk_class NOT IN ('R2','R3')
        OR (requested_risk_class = 'R2' AND (
          SELECT count(DISTINCT a.approver_id) FROM console.module_operation_approval a
          WHERE a.operation_id = module_operation.operation_id
            AND a.revoked_at IS NULL AND a.assurance = 'aal2'
        ) >= 1)
        OR (requested_risk_class = 'R3' AND (
          SELECT count(DISTINCT a.approver_id) FROM console.module_operation_approval a
          WHERE a.operation_id = module_operation.operation_id
            AND a.revoked_at IS NULL AND a.assurance = 'aal2'
        ) >= 2)
      )
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT greatest(1, least(p_limit, 50))
  )
  UPDATE console.module_operation o SET phase = CASE
      WHEN o.phase = 'Queued' THEN 'Claimed'
      WHEN o.phase = 'Running' THEN 'Ambiguous'
      ELSE o.phase END,
    execution_state = CASE
      WHEN o.phase = 'Queued' THEN 'claimed'
      WHEN o.phase = 'Running' THEN 'ambiguous'
      ELSE o.execution_state END,
    claim_owner = p_worker, claim_epoch = p_claim_epoch,
    lease_expires_at = clock_timestamp() + interval '30 seconds', heartbeat_at = clock_timestamp(),
    attempt = attempt + 1, updated_at = clock_timestamp()
  FROM candidates c WHERE o.operation_id = c.operation_id RETURNING o.*;
END $$;

REVOKE ALL ON FUNCTION console.claim_module_operation(text,bigint,integer)
  FROM PUBLIC,anon,authenticated,service_role,opensphere_oaa_observer,opensphere_oaa_api,opensphere_oaa_gateway;
GRANT EXECUTE ON FUNCTION console.claim_module_operation(text,bigint,integer)
  TO opensphere_console_backend;

COMMENT ON FUNCTION console.claim_module_operation(text,bigint,integer) IS
  'Claims owner-facade operations only; Engineering Remediation is isolated to its dedicated lifecycle worker.';
