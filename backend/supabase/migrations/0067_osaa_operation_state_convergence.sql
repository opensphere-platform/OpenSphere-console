-- Keep the shared durable operation receipt internally consistent across the
-- legacy module adapter and the OSAA durable worker. phase remains the public
-- lifecycle summary; execution_state and verification_state are its explicit
-- machine-readable projections.

UPDATE console.module_operation
SET execution_state = CASE phase
      WHEN 'Queued' THEN 'accepted'
      WHEN 'AwaitingApproval' THEN 'awaiting_approval'
      WHEN 'Claimed' THEN 'claimed'
      WHEN 'Preflighting' THEN 'preflighting'
      WHEN 'AuthorizationExpired' THEN 'authorization_expired'
      WHEN 'PreflightBlocked' THEN 'preflight_blocked'
      WHEN 'Running' THEN 'executing'
      WHEN 'Ambiguous' THEN 'ambiguous'
      WHEN 'Reconciling' THEN 'reconciling'
      WHEN 'Verifying' THEN 'complete'
      WHEN 'Succeeded' THEN 'complete'
      WHEN 'Failed' THEN 'failed'
      WHEN 'VerificationFailed' THEN 'complete'
      WHEN 'Inconclusive' THEN 'complete'
      WHEN 'Cancelled' THEN 'cancelled'
      WHEN 'TimedOut' THEN 'timed_out'
      WHEN 'RollingBack' THEN 'rolling_back'
      WHEN 'RolledBack' THEN 'rolled_back'
      ELSE execution_state
    END,
    verification_state = CASE phase
      WHEN 'Verifying' THEN 'verifying'
      WHEN 'Succeeded' THEN 'succeeded'
      WHEN 'VerificationFailed' THEN 'failed'
      WHEN 'Inconclusive' THEN 'inconclusive'
      WHEN 'RollingBack' THEN 'failed'
      WHEN 'RolledBack' THEN 'failed'
      WHEN 'Failed' THEN 'not_required'
      WHEN 'AuthorizationExpired' THEN 'not_required'
      WHEN 'PreflightBlocked' THEN 'not_required'
      WHEN 'Cancelled' THEN 'not_required'
      WHEN 'TimedOut' THEN 'not_required'
      ELSE verification_state
    END,
    updated_at = clock_timestamp()
WHERE (execution_state, verification_state) IS DISTINCT FROM (
  CASE phase
    WHEN 'Queued' THEN 'accepted'
    WHEN 'AwaitingApproval' THEN 'awaiting_approval'
    WHEN 'Claimed' THEN 'claimed'
    WHEN 'Preflighting' THEN 'preflighting'
    WHEN 'AuthorizationExpired' THEN 'authorization_expired'
    WHEN 'PreflightBlocked' THEN 'preflight_blocked'
    WHEN 'Running' THEN 'executing'
    WHEN 'Ambiguous' THEN 'ambiguous'
    WHEN 'Reconciling' THEN 'reconciling'
    WHEN 'Verifying' THEN 'complete'
    WHEN 'Succeeded' THEN 'complete'
    WHEN 'Failed' THEN 'failed'
    WHEN 'VerificationFailed' THEN 'complete'
    WHEN 'Inconclusive' THEN 'complete'
    WHEN 'Cancelled' THEN 'cancelled'
    WHEN 'TimedOut' THEN 'timed_out'
    WHEN 'RollingBack' THEN 'rolling_back'
    WHEN 'RolledBack' THEN 'rolled_back'
    ELSE execution_state
  END,
  CASE phase
    WHEN 'Verifying' THEN 'verifying'
    WHEN 'Succeeded' THEN 'succeeded'
    WHEN 'VerificationFailed' THEN 'failed'
    WHEN 'Inconclusive' THEN 'inconclusive'
    WHEN 'RollingBack' THEN 'failed'
    WHEN 'RolledBack' THEN 'failed'
    WHEN 'Failed' THEN 'not_required'
    WHEN 'AuthorizationExpired' THEN 'not_required'
    WHEN 'PreflightBlocked' THEN 'not_required'
    WHEN 'Cancelled' THEN 'not_required'
    WHEN 'TimedOut' THEN 'not_required'
    ELSE verification_state
  END
);
