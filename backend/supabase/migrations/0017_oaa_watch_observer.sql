\set ON_ERROR_STOP on

-- Each OAA Gateway replica owns an independent Kubernetes watch. A cursor keyed
-- only by resource kind/namespace lets a terminating replica overwrite a healthy
-- replica's liveness, so observer identity is part of the projection key.

ALTER TABLE oaa.watch_cursor
  ADD COLUMN IF NOT EXISTS observer_id text NOT NULL DEFAULT 'legacy';

DO $$
DECLARE
  key_columns text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY u.ordinality)
    INTO key_columns
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
  WHERE c.conrelid = 'oaa.watch_cursor'::regclass AND c.contype = 'p';

  IF key_columns IS DISTINCT FROM 'source,observer_id,kind,namespace' THEN
    ALTER TABLE oaa.watch_cursor DROP CONSTRAINT IF EXISTS watch_cursor_pkey;
    ALTER TABLE oaa.watch_cursor
      ADD CONSTRAINT watch_cursor_pkey PRIMARY KEY (source, observer_id, kind, namespace);
  END IF;
END $$;

DELETE FROM oaa.watch_cursor WHERE observer_id = 'legacy';

CREATE INDEX IF NOT EXISTS watch_cursor_stream_liveness_idx
  ON oaa.watch_cursor (source, kind, namespace, updated_at DESC);
CREATE INDEX IF NOT EXISTS watch_cursor_observer_liveness_idx
  ON oaa.watch_cursor (source, observer_id, updated_at DESC);

COMMENT ON COLUMN oaa.watch_cursor.observer_id IS
  'Stable identity of the Gateway replica that owns this watch stream; normally the Kubernetes Pod hostname.';
COMMENT ON TABLE oaa.watch_cursor IS
  'Replica-aware mutable liveness/cursor projection for OAA Kubernetes watches; never an execution authority.';
