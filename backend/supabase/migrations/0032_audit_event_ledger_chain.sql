-- L2-7 remediation: audit.event is a server-sequenced tamper-evident ledger.
-- The existing event_hash remains the producer's payload/idempotency digest.
-- ledger_hash is the canonical server-owned chain hash and prev_hash links it.
BEGIN;

LOCK TABLE audit.event IN ACCESS EXCLUSIVE MODE;

ALTER TABLE audit.event
  ADD COLUMN IF NOT EXISTS chain_sequence bigint,
  ADD COLUMN IF NOT EXISTS ledger_hash text;

CREATE OR REPLACE FUNCTION audit.compute_event_ledger_hash(
  p_event audit.event,
  p_prev_hash text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, audit, extensions
AS $$
  SELECT encode(
    extensions.digest(
      convert_to(
        jsonb_build_array(
          'audit.event/ledger/v1',
          p_event.id::text,
          extract(epoch FROM p_event.occurred_at)::text,
          p_event.request_id::text,
          p_event.correlation_id,
          p_event.actor_type,
          coalesce(p_event.actor_id::text, ''),
          coalesce(p_event.auth_session_id::text, ''),
          p_event.action,
          p_event.target_type,
          p_event.target_id,
          p_event.reason,
          p_event.phase,
          p_event.result,
          coalesce(p_event.git_commit_sha, ''),
          coalesce(p_event.k8s_operation_id, ''),
          coalesce(p_event.payload_digest, ''),
          p_event.event_hash,
          p_prev_hash
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

-- Backfill is atomic under an exclusive table lock. The pre-existing
-- UPDATE/DELETE guard is disabled only inside this transaction and is restored
-- as an ALWAYS trigger before the lock is released.
ALTER TABLE audit.event DISABLE TRIGGER audit_event_append_only;

DO $$
DECLARE
  event_row audit.event%ROWTYPE;
  next_sequence bigint := 0;
  previous_hash text := repeat('0', 64);
  computed_hash text;
BEGIN
  FOR event_row IN
    SELECT *
    FROM audit.event
    ORDER BY occurred_at, id
  LOOP
    next_sequence := next_sequence + 1;
    computed_hash := audit.compute_event_ledger_hash(event_row, previous_hash);
    UPDATE audit.event
    SET chain_sequence = next_sequence,
        prev_hash = previous_hash,
        ledger_hash = computed_hash
    WHERE id = event_row.id;
    previous_hash := computed_hash;
  END LOOP;
END;
$$;

ALTER TABLE audit.event ENABLE ALWAYS TRIGGER audit_event_append_only;

ALTER TABLE audit.event
  ALTER COLUMN chain_sequence SET NOT NULL,
  ALTER COLUMN prev_hash SET NOT NULL,
  ALTER COLUMN ledger_hash SET NOT NULL;

ALTER TABLE audit.event
  DROP CONSTRAINT IF EXISTS audit_event_prev_hash_format,
  ADD CONSTRAINT audit_event_prev_hash_format
    CHECK (prev_hash ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS audit_event_ledger_hash_format,
  ADD CONSTRAINT audit_event_ledger_hash_format
    CHECK (ledger_hash ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS audit_event_chain_sequence_uidx
  ON audit.event (chain_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS audit_event_ledger_hash_uidx
  ON audit.event (ledger_hash);

CREATE OR REPLACE FUNCTION audit.assign_event_ledger_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, extensions
AS $$
DECLARE
  previous_sequence bigint;
  previous_hash text;
BEGIN
  -- Every writer, including multi-row statements, shares one ordered chain.
  -- The transaction advisory lock serializes the read-head/append transition.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('opensphere:audit.event:ledger:v1', 0)
  );

  SELECT chain_sequence, ledger_hash
  INTO previous_sequence, previous_hash
  FROM audit.event
  ORDER BY chain_sequence DESC
  LIMIT 1;

  NEW.chain_sequence := coalesce(previous_sequence, 0) + 1;
  NEW.prev_hash := coalesce(previous_hash, repeat('0', 64));
  NEW.ledger_hash := audit.compute_event_ledger_hash(NEW, NEW.prev_hash);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_event_assign_ledger_chain ON audit.event;
CREATE TRIGGER audit_event_assign_ledger_chain
  BEFORE INSERT ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.assign_event_ledger_chain();
ALTER TABLE audit.event ENABLE ALWAYS TRIGGER audit_event_assign_ledger_chain;

CREATE OR REPLACE FUNCTION audit.reject_event_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, audit
AS $$
BEGIN
  RAISE EXCEPTION 'audit.event is append-only; TRUNCATE is forbidden';
END;
$$;

DROP TRIGGER IF EXISTS audit_event_reject_truncate ON audit.event;
CREATE TRIGGER audit_event_reject_truncate
  BEFORE TRUNCATE ON audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_event_truncate();
ALTER TABLE audit.event ENABLE ALWAYS TRIGGER audit_event_reject_truncate;

CREATE OR REPLACE FUNCTION audit.verify_event_ledger_chain()
RETURNS TABLE (
  valid boolean,
  event_count bigint,
  first_invalid_sequence bigint,
  head_hash text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, audit, extensions
AS $$
  WITH checked AS (
    SELECT
      e.chain_sequence,
      e.ledger_hash,
      e.chain_sequence = row_number() OVER (ORDER BY e.chain_sequence) AS sequence_valid,
      e.prev_hash = coalesce(
        lag(e.ledger_hash) OVER (ORDER BY e.chain_sequence),
        repeat('0', 64)
      ) AS link_valid,
      e.ledger_hash = audit.compute_event_ledger_hash(e, e.prev_hash) AS hash_valid
    FROM audit.event AS e
  )
  SELECT
    coalesce(bool_and(sequence_valid AND link_valid AND hash_valid), true) AS valid,
    count(*)::bigint AS event_count,
    min(chain_sequence) FILTER (
      WHERE NOT (sequence_valid AND link_valid AND hash_valid)
    ) AS first_invalid_sequence,
    (array_agg(ledger_hash ORDER BY chain_sequence DESC))[1] AS head_hash
  FROM checked;
$$;

REVOKE ALL ON FUNCTION audit.compute_event_ledger_hash(audit.event, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.assign_event_ledger_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.reject_event_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.verify_event_ledger_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.verify_event_ledger_chain()
  TO opensphere_console_backend, service_role;

REVOKE UPDATE, DELETE, TRUNCATE ON audit.event
  FROM PUBLIC, anon, authenticated, service_role, opensphere_console_backend;

COMMENT ON COLUMN audit.event.chain_sequence IS
  'Server-assigned gap-free order for the audit.event ledger.';
COMMENT ON COLUMN audit.event.prev_hash IS
  'Previous row ledger_hash, or 64 zeroes for the genesis event.';
COMMENT ON COLUMN audit.event.ledger_hash IS
  'Server-computed SHA-256 over the canonical event payload and prev_hash.';
COMMENT ON FUNCTION audit.verify_event_ledger_chain() IS
  'Recomputes sequence, links and hashes; any mismatch makes valid=false.';

COMMIT;
