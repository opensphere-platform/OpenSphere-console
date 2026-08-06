\set ON_ERROR_STOP on

-- Browser-session termination and authority failures must be distinguishable
-- in the operator-visible audit history. This migration changes only the
-- closed event vocabulary; existing rows and runtime credentials are retained.
ALTER TABLE console.session_event
  DROP CONSTRAINT IF EXISTS session_event_event_check;

ALTER TABLE console.session_event
  ADD CONSTRAINT session_event_event_check CHECK (event IN (
    'login',
    'refresh',
    'lock',
    'unlock',
    'step_up',
    'logout',
    'revoke',
    'revoke_all',
    'reuse_detected',
    'refresh_rejected',
    'expired_idle',
    'expired_absolute',
    'authority_unavailable'
  ));

COMMENT ON COLUMN console.session_event.event IS
  'Closed browser-session transition vocabulary, including exact expiry, refresh rejection and authority availability outcomes.';
