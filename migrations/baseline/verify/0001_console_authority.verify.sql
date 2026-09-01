INSERT INTO console_audit.event(
  correlation_id, actor_ref, action, target_ref, outcome, event_hash
) VALUES (
  'baseline-verification', 'verification-actor', 'verify', 'console-authority', 'accepted',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

DO $$
BEGIN
  BEGIN
    UPDATE console_audit.event SET outcome = 'failed';
    RAISE EXCEPTION 'append-only update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM console_audit.event;
    RAISE EXCEPTION 'append-only delete unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    TRUNCATE console_audit.event;
    RAISE EXCEPTION 'append-only truncate unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM console_audit.event) <> 1 THEN
    RAISE EXCEPTION 'audit row count changed during negative verification';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relrowsecurity AND relnamespace IN (
    'console_identity'::regnamespace,
    'console_operation'::regnamespace,
    'console_audit'::regnamespace
  )) <> 5 THEN
    RAISE EXCEPTION 'expected five RLS-protected authority tables';
  END IF;
END;
$$;
