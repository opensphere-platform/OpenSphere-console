\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regprocedure('console_identity.list_owned_browser_sessions(bytea)') IS NULL
      OR to_regprocedure('console_identity.revoke_owned_browser_session(bytea,bytea,uuid,text)') IS NULL
      OR to_regprocedure('console_identity.revoke_all_owned_browser_sessions(bytea,bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'owned browser session management functions are incomplete';
  END IF;
  IF has_function_privilege('public', 'console_identity.list_owned_browser_sessions(bytea)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.revoke_owned_browser_session(bytea,bytea,uuid,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.revoke_all_owned_browser_sessions(bytea,bytea,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.list_owned_browser_sessions(bytea)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.revoke_owned_browser_session(bytea,bytea,uuid,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.revoke_all_owned_browser_sessions(bytea,bytea,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'owned browser session grants are not closed to console_api';
  END IF;
END;
$$;

INSERT INTO auth.users(id) VALUES
  ('12121212-1212-4121-8121-121212121212'),
  ('34343434-3434-4343-8343-343434343434');

INSERT INTO console_identity.subject_authority(
  subject_id, person_ref, permission_revision, revoke_epoch
) VALUES
  ('12121212-1212-4121-8121-121212121212', '12121212-aaaa-4aaa-8aaa-121212121212', 1, 0),
  ('34343434-3434-4343-8343-343434343434', '34343434-bbbb-4bbb-8bbb-343434343434', 1, 0);

SET ROLE console_api;
DO $$
DECLARE
  v_index integer;
BEGIN
  FOR v_index IN 1..100 LOOP
    PERFORM console_identity.issue_browser_session(
      '12121212-1212-4121-8121-121212121212',
      sha256(convert_to('migration-verification-inventory-filler-handle-' || v_index::text, 'UTF8')),
      sha256(convert_to('migration-verification-inventory-filler-csrf-' || v_index::text, 'UTF8')),
      'v1.aW52ZW50b3J5ZmlsbGVyYWNjZXNz.aW52ZW50b3J5ZmlsbGVyYWNjZXNzdGFn.aW52ZW50b3J5ZmlsbGVyYWNjZXNzY2lwaGVy',
      'v1.aW52ZW50b3J5ZmlsbGVycmVmcmVzaA.aW52ZW50b3J5ZmlsbGVycmVmcmVzaHRhZw.aW52ZW50b3J5ZmlsbGVycmVmcmVzaGNpcGhlcg',
      'migration-verification-inventory-filler-auth-' || v_index::text,
      'aal1', statement_timestamp() + interval '1 hour',
      statement_timestamp() + interval '24 hours', '24h', false,
      'migration-session-inventory-filler-' || lpad(v_index::text, 4, '0')
    );
  END LOOP;
END;
$$;

SELECT set_config(
  'verification.inventory_current',
  console_identity.issue_browser_session(
    '12121212-1212-4121-8121-121212121212',
    sha256(convert_to('migration-verification-inventory-current-handle', 'UTF8')),
    sha256(convert_to('migration-verification-inventory-current-csrf', 'UTF8')),
    'v1.aW52ZW50b3J5Y3VycmVudGFjY2Vzcw.aW52ZW50b3J5Y3VycmVudGFjY2Vzc3RhZw.aW52ZW50b3J5Y3VycmVudGFjY2Vzc2NpcGhlcg',
    'v1.aW52ZW50b3J5Y3VycmVudHJlZnJlc2g.aW52ZW50b3J5Y3VycmVudHJlZnJlc2h0YWc.aW52ZW50b3J5Y3VycmVudHJlZnJlc2hjaXBoZXI',
    'migration-verification-inventory-current-auth', 'aal2',
    statement_timestamp() + interval '1 hour', statement_timestamp() + interval '24 hours',
    '24h', false, 'migration-session-inventory-issue-current-0001'
  )::text, false
);
SELECT set_config(
  'verification.inventory_other',
  console_identity.issue_browser_session(
    '12121212-1212-4121-8121-121212121212',
    sha256(convert_to('migration-verification-inventory-other-handle', 'UTF8')),
    sha256(convert_to('migration-verification-inventory-other-csrf', 'UTF8')),
    'v1.aW52ZW50b3J5b3RoZXJhY2Nlc3M.aW52ZW50b3J5b3RoZXJhY2Nlc3N0YWc.aW52ZW50b3J5b3RoZXJhY2Nlc3NjaXBoZXI',
    'v1.aW52ZW50b3J5b3RoZXJyZWZyZXNo.aW52ZW50b3J5b3RoZXJyZWZyZXNodGFn.aW52ZW50b3J5b3RoZXJyZWZyZXNoY2lwaGVy',
    'migration-verification-inventory-other-auth', 'aal1',
    statement_timestamp() + interval '1 hour', statement_timestamp() + interval '24 hours',
    '24h', false, 'migration-session-inventory-issue-other-0001'
  )::text, false
);
SELECT set_config(
  'verification.inventory_foreign',
  console_identity.issue_browser_session(
    '34343434-3434-4343-8343-343434343434',
    sha256(convert_to('migration-verification-inventory-foreign-handle', 'UTF8')),
    sha256(convert_to('migration-verification-inventory-foreign-csrf', 'UTF8')),
    'v1.aW52ZW50b3J5Zm9yZWlnbmFjY2Vzcw.aW52ZW50b3J5Zm9yZWlnbmFjY2Vzc3RhZw.aW52ZW50b3J5Zm9yZWlnbmFjY2Vzc2NpcGhlcg',
    'v1.aW52ZW50b3J5Zm9yZWlnbnJlZnJlc2g.aW52ZW50b3J5Zm9yZWlnbnJlZnJlc2h0YWc.aW52ZW50b3J5Zm9yZWlnbnJlZnJlc2hjaXBoZXI',
    'migration-verification-inventory-foreign-auth', 'aal2',
    statement_timestamp() + interval '1 hour', statement_timestamp() + interval '24 hours',
    '24h', false, 'migration-session-inventory-issue-foreign-0001'
  )::text, false
);

RESET ROLE;
UPDATE console_identity.browser_session
SET last_seen_at = statement_timestamp() - interval '1 day'
WHERE session_id = (current_setting('verification.inventory_current')::jsonb->>'sessionId')::uuid;
SET ROLE console_api;

DO $$
DECLARE
  v_current jsonb := current_setting('verification.inventory_current')::jsonb;
  v_other jsonb := current_setting('verification.inventory_other')::jsonb;
  v_foreign jsonb := current_setting('verification.inventory_foreign')::jsonb;
  v_inventory jsonb;
  v_revoked jsonb;
BEGIN
  v_inventory := console_identity.list_owned_browser_sessions(
    sha256(convert_to('migration-verification-inventory-current-handle', 'UTF8'))
  );
  IF jsonb_array_length(v_inventory->'items') > 100
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_inventory->'items') item
        WHERE item->>'id' = v_current->>'sessionId' AND (item->>'current')::boolean)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_inventory->'items') item
        WHERE item->>'id' = v_other->>'sessionId' AND NOT (item->>'current')::boolean)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_inventory->'items') item
        WHERE item->>'id' = v_foreign->>'sessionId')
      OR (SELECT count(*) FROM jsonb_array_elements(v_inventory->'items') item
          WHERE (item->>'current')::boolean) <> 1
      OR v_inventory::text ~ '(accessToken|refreshToken|csrf|ciphertext|authSessionRef)' THEN
    RAISE EXCEPTION 'owned session inventory lost subject isolation, bounds, current binding, or no-secret projection';
  END IF;

  v_revoked := console_identity.revoke_owned_browser_session(
    sha256(convert_to('migration-verification-inventory-current-handle', 'UTF8')),
    sha256(convert_to('migration-verification-inventory-current-csrf', 'UTF8')),
    (v_other->>'sessionId')::uuid, 'migration-session-owned-revoke-0001'
  );
  IF (v_revoked->>'current')::boolean OR v_revoked->>'sessionId' <> v_other->>'sessionId' THEN
    RAISE EXCEPTION 'owned session targeted revocation lost its target/current result';
  END IF;
  BEGIN
    PERFORM console_identity.revoke_owned_browser_session(
      sha256(convert_to('migration-verification-inventory-current-handle', 'UTF8')),
      sha256(convert_to('migration-verification-inventory-current-csrf', 'UTF8')),
      (v_foreign->>'sessionId')::uuid, 'migration-session-owned-revoke-foreign-0001'
    );
    RAISE EXCEPTION 'owned session revocation crossed the subject boundary';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  v_inventory := console_identity.list_owned_browser_sessions(
    sha256(convert_to('migration-verification-inventory-current-handle', 'UTF8'))
  );
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_inventory->'items') item
      WHERE item->>'id' = v_other->>'sessionId') THEN
    RAISE EXCEPTION 'revoked session remained in the live inventory';
  END IF;
END;
$$;

SELECT set_config(
  'verification.inventory_revoked_all',
  console_identity.revoke_all_owned_browser_sessions(
    sha256(convert_to('migration-verification-inventory-current-handle', 'UTF8')),
    sha256(convert_to('migration-verification-inventory-current-csrf', 'UTF8')),
    'migration-session-owned-revoke-all-0001'
  )::text, false
);

DO $$
DECLARE
  v_result jsonb := current_setting('verification.inventory_revoked_all')::jsonb;
BEGIN
  IF NOT (v_result->>'current')::boolean OR (v_result->>'revokedCount')::integer < 1 THEN
    RAISE EXCEPTION 'all-session revocation did not include the current session';
  END IF;
  BEGIN
    PERFORM console_identity.resolve_browser_session(
      sha256(convert_to('migration-verification-inventory-current-handle', 'UTF8')), NULL, false
    );
    RAISE EXCEPTION 'current session remained usable after all-session revocation';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM console_audit.event
      WHERE correlation_id = 'migration-session-owned-revoke-0001'
        AND action = 'console.identity.session.revoke') <> 1
      OR (SELECT count(*) FROM console_audit.event
          WHERE correlation_id = 'migration-session-owned-revoke-all-0001'
            AND action = 'console.identity.session.revoke_all') <> 1
      OR EXISTS (
        SELECT 1 FROM console_audit.event
        WHERE correlation_id IN ('migration-session-owned-revoke-0001', 'migration-session-owned-revoke-all-0001')
          AND evidence::text ~ '(migration-verification-inventory|accessToken|refreshToken|csrf|ciphertext)'
      ) THEN
    RAISE EXCEPTION 'owned session revocation audit evidence is incomplete or contains credential material';
  END IF;
END;
$$;
