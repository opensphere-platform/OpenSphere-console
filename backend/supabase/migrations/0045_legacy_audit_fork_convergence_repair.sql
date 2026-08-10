\set ON_ERROR_STOP on

-- Canonical convergence repair for the historical
-- 0032_audit_ledger_integrity fork. It removes the incompatible producer-hash
-- chain and rebuilds the server-owned ledger chain for every existing row.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE audit.event IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regprocedure('audit.verify_event_ledger_chain()') IS NULL THEN
    RAISE EXCEPTION 'canonical audit ledger chain contract is missing';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS audit_event_chain_link ON audit.event;
DROP TRIGGER IF EXISTS audit_event_no_truncate ON audit.event;

ALTER TABLE audit.event DISABLE TRIGGER audit_event_append_only;

DO $$
DECLARE
  event_row audit.event%ROWTYPE;
  previous_hash text := repeat('0', 64);
  computed_hash text;
BEGIN
  FOR event_row IN
    SELECT * FROM audit.event ORDER BY chain_sequence
  LOOP
    computed_hash := audit.compute_event_ledger_hash(event_row, previous_hash);
    UPDATE audit.event
       SET prev_hash = previous_hash,
           ledger_hash = computed_hash
     WHERE id = event_row.id;
    previous_hash := computed_hash;
  END LOOP;
END
$$;

ALTER TABLE audit.event ENABLE ALWAYS TRIGGER audit_event_append_only;

DROP FUNCTION IF EXISTS audit.link_event_chain();
DROP FUNCTION IF EXISTS audit.verify_event_chain();
DROP INDEX IF EXISTS audit.audit_event_seq_idx;
ALTER TABLE audit.event DROP COLUMN IF EXISTS seq;

DO $$
DECLARE
  chain_valid boolean;
BEGIN
  SELECT valid INTO chain_valid FROM audit.verify_event_ledger_chain();
  IF NOT coalesce(chain_valid, false) THEN
    RAISE EXCEPTION 'canonical audit ledger chain remains invalid after legacy convergence repair';
  END IF;
END
$$;

COMMIT;
