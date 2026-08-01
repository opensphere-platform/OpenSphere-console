\set ON_ERROR_STOP on

-- The Gateway persists discovery and unsupported states before a watch reaches
-- `watching`. Migration 0016 predated those self-healing states and rejected
-- them, producing a permanent constraint-error loop after a cold restart.
ALTER TABLE oaa.watch_cursor
  DROP CONSTRAINT IF EXISTS watch_cursor_status_check;

ALTER TABLE oaa.watch_cursor
  ADD CONSTRAINT watch_cursor_status_check CHECK (status IN (
    'starting',
    'discovery',
    'discovery-error',
    'watching',
    'reconnecting',
    'stopped',
    'error',
    'unsupported'
  ));

COMMENT ON COLUMN oaa.watch_cursor.status IS
  'Closed runtime-watch lifecycle vocabulary; discovery and unsupported are durable non-error startup outcomes.';
