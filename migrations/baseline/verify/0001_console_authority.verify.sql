\set ON_ERROR_STOP on

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('55555555-5555-4555-8555-555555555555'),
  ('88888888-8888-4888-8888-888888888888'),
  ('99999999-9999-4999-8999-999999999999');

INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 7, 2),
  ('55555555-5555-4555-8555-555555555555', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 3, 0),
  ('88888888-8888-4888-8888-888888888888', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 3, 0);

INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'console.registry.manage', 7, '99999999-9999-4999-8999-999999999999'),
  ('11111111-1111-4111-8111-111111111111', 'console.extension.revoke', 7, '99999999-9999-4999-8999-999999999999'),
  ('11111111-1111-4111-8111-111111111111', 'console.operation.verify', 7, '99999999-9999-4999-8999-999999999999'),
  ('11111111-1111-4111-8111-111111111111', 'console.audit.read', 7, '99999999-9999-4999-8999-999999999999'),
  ('11111111-1111-4111-8111-111111111111', 'console.data_identity.read', 7, '99999999-9999-4999-8999-999999999999'),
  ('11111111-1111-4111-8111-111111111111', 'console.operation.approve', 7, '99999999-9999-4999-8999-999999999999'),
  ('55555555-5555-4555-8555-555555555555', 'console.operation.approve', 3, '99999999-9999-4999-8999-999999999999'),
  ('88888888-8888-4888-8888-888888888888', 'console.operation.approve', 3, '99999999-9999-4999-8999-999999999999');

INSERT INTO console_identity.browser_session(
  session_id, subject_id, token_digest, csrf_token_digest, aal,
  permission_revision, revoke_epoch, expires_at
) VALUES
  (
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    sha256(convert_to('opaque-session-handle-for-console-api-integration', 'UTF8')),
    sha256(convert_to('csrf-proof-for-console-api-integration', 'UTF8')),
    'aal2', 7, 2,
    statement_timestamp() + interval '1 hour'
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    '11111111-1111-4111-8111-111111111111',
    decode('cc', 'hex'), decode('dd', 'hex'), 'aal1', 7, 2,
    statement_timestamp() + interval '1 hour'
  ),
  (
    '66666666-6666-4666-8666-666666666666',
    '55555555-5555-4555-8555-555555555555',
    sha256(convert_to('opaque-approver-session-for-console-api-integration', 'UTF8')),
    sha256(convert_to('csrf-approver-proof-for-console-api-integration', 'UTF8')),
    'aal2', 3, 0,
    statement_timestamp() + interval '1 hour'
  ),
  (
    '77777777-7777-4777-8777-777777777777',
    '55555555-5555-4555-8555-555555555555',
    decode('ee', 'hex'), decode('ff', 'hex'), 'aal1', 3, 0,
    statement_timestamp() + interval '1 hour'
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    '88888888-8888-4888-8888-888888888888',
    decode('ab', 'hex'), decode('ac', 'hex'), 'aal2', 3, 0,
    statement_timestamp() + interval '1 hour'
  );

SET ROLE console_api;
DO $$
DECLARE
  v_session jsonb;
BEGIN
  v_session := console_identity.resolve_browser_session(
    decode('e644602849bbdff44d47c35cf399290b6361c61a675dd49d627b19709eda092a', 'hex'),
    decode('51cac0aece76bdc04162b207133fa67cf078808440e83551689583e102b50897', 'hex'),
    true
  );
  IF v_session->>'subjectId' <> '11111111-1111-4111-8111-111111111111'
      OR v_session->>'permissionRevision' <> '7'
      OR NOT (v_session->'permissions' ? 'console.registry.manage') THEN
    RAISE EXCEPTION 'resolved session lost current authority evidence';
  END IF;
  BEGIN
    PERFORM console_identity.resolve_browser_session(
      decode('e644602849bbdff44d47c35cf399290b6361c61a675dd49d627b19709eda092a', 'hex'),
      decode('66639f86ed9d9a72898109a1a84a20257887fa9fbbc135c561e6ad9084fc0901', 'hex'),
      true
    );
    RAISE EXCEPTION 'invalid CSRF digest unexpectedly resolved a session';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE console_api;
DO $$
DECLARE
  v_status jsonb;
BEGIN
  v_status := console_identity.get_supabase_status(
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    7, 2, 'correlation-supabase-status-0001'
  );
  IF v_status->>'authority' <> 'Supabase'
      OR v_status->'data'->>'state' <> 'Degraded'
      OR v_status->'data'->'components'->0->>'state' <> 'Ready'
      OR v_status->'data'->'components'->1->>'state' <> 'Unknown'
      OR v_status->'data'->'components'->4->>'state' <> 'Partial'
      OR v_status->'data'->'components'->5->>'state' <> 'Ready'
      OR v_status->'data'->'components'->5->>'protectedTables' <> '11' THEN
    RAISE EXCEPTION 'Supabase status projection overclaimed or lost baseline evidence';
  END IF;
  BEGIN
    PERFORM console_identity.get_supabase_status(
      '66666666-6666-4666-8666-666666666666',
      '55555555-5555-4555-8555-555555555555',
      3, 0, 'correlation-supabase-status-denied-0001'
    );
    RAISE EXCEPTION 'actor without data identity permission read Supabase status';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

CREATE ROLE console_api_runtime LOGIN PASSWORD 'console-runtime-test' INHERIT;
GRANT console_api TO console_api_runtime;
CREATE ROLE console_extension_runtime LOGIN PASSWORD 'console-extension-runtime-test' INHERIT;
GRANT console_extension_controller TO console_extension_runtime;

SET ROLE console_api;
SELECT * FROM console_operation.accept_operation(
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  7, 2, 'console.registry.manage',
  'console.registry.connection.replace', '1.0',
  'registry-connection:opensphere-ghcr',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'R2', 'rotate registry credential',
  'console-operation-policy-2026-09-01.1', false,
  'registry-operation-0001', 'correlation-registry-0001',
  NULL, 'C_EXT', NULL
);
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM console_operation.operation) <> 1
      OR (SELECT count(*) FROM console_operation.outbox) <> 1
      OR (SELECT count(*) FROM console_audit.event) <> 1 THEN
    RAISE EXCEPTION 'operation, audit and outbox were not committed atomically';
  END IF;
  IF EXISTS (
    SELECT 1 FROM console_operation.outbox
    WHERE payload::text ~* '"(credential|password|token|secret|authorization|cookie)"[[:space:]]*:'
  ) THEN
    RAISE EXCEPTION 'outbox contains a prohibited credential-bearing field';
  END IF;
END;
$$;





SELECT set_config(
  'verification.operation_id',
  (SELECT operation_id::text FROM console_operation.operation LIMIT 1),
  false
);

SET ROLE console_api;
SELECT * FROM console_operation.accept_operation(
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  7, 2, 'console.registry.manage',
  'console.registry.connection.replace', '1.0',
  'registry-connection:opensphere-ghcr',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'R2', 'rotate registry credential',
  'console-operation-policy-2026-09-01.1', false,
  'registry-operation-0001', 'correlation-registry-0001',
  NULL, 'C_EXT', NULL
);
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM console_operation.operation) <> 1
      OR (SELECT count(*) FROM console_operation.outbox) <> 1
      OR (SELECT count(*) FROM console_audit.event) <> 1 THEN
    RAISE EXCEPTION 'idempotent replay created duplicate durable effects';
  END IF;
END;
$$;

SET ROLE console_api;
DO $$
DECLARE
  v_detail text;
BEGIN
  BEGIN
    PERFORM * FROM console_operation.accept_operation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, 'console.registry.manage',
      'console.registry.connection.replace', '1.0',
      'registry-connection:opensphere-ghcr',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'R2', 'rotate registry credential',
      'console-operation-policy-2026-09-01.1', false,
      'registry-operation-0001', 'correlation-registry-0001',
      NULL, 'C_EXT', NULL
    );
    RAISE EXCEPTION 'idempotency mismatch unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail <> 'IdempotencyMismatch' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

SET ROLE console_api;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM console_operation.accept_operation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, 'console.missing.permission',
      'console.registry.connection.remove', '1.0',
      'registry-connection:opensphere-ghcr',
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      'R2', 'remove registry credential',
      'console-operation-policy-2026-09-01.1', false,
      'registry-operation-0002', 'correlation-registry-0002',
      NULL, 'C_EXT', NULL
    );
    RAISE EXCEPTION 'missing permission unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE console_api;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM console_operation.accept_operation(
      '44444444-4444-4444-8444-444444444444',
      '11111111-1111-4111-8111-111111111111',
      7, 2, 'console.registry.manage',
      'console.registry.connection.remove', '1.0',
      'registry-connection:opensphere-ghcr',
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      'R2', 'remove registry credential',
      'console-operation-policy-2026-09-01.1', false,
      'registry-operation-0003', 'correlation-registry-0003',
      NULL, 'C_EXT', NULL
    );
    RAISE EXCEPTION 'aal1 high-risk operation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

UPDATE console_identity.subject_authority
SET permission_revision = 8, updated_at = statement_timestamp()
WHERE subject_id = '11111111-1111-4111-8111-111111111111';

SET ROLE console_api;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM console_operation.accept_operation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, 'console.registry.manage',
      'console.registry.connection.remove', '1.0',
      'registry-connection:opensphere-ghcr',
      'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      'R2', 'remove registry credential',
      'console-operation-policy-2026-09-01.1', false,
      'registry-operation-0004', 'correlation-registry-0004',
      NULL, 'C_EXT', NULL
    );
    RAISE EXCEPTION 'stale permission revision unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
  BEGIN
    PERFORM console_operation.get_operation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      current_setting('verification.operation_id')::uuid
    );
    RAISE EXCEPTION 'stale session unexpectedly read an operation';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
END;
$$;
RESET ROLE;

UPDATE console_identity.subject_authority
SET permission_revision = 7, updated_at = statement_timestamp()
WHERE subject_id = '11111111-1111-4111-8111-111111111111';
SET ROLE console_api;
SELECT console_identity.revoke_browser_session(
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  7, 2, 'correlation-session-self-revoke-0001'
);
RESET ROLE;

DO $$
BEGIN
  IF (SELECT revoke_reason FROM console_identity.browser_session
      WHERE session_id = '22222222-2222-4222-8222-222222222222') <> 'self-logout'
      OR (SELECT count(*) FROM console_audit.event
          WHERE action = 'console.identity.session.revoke'
            AND actor_ref = '11111111-1111-4111-8111-111111111111') <> 1 THEN
    RAISE EXCEPTION 'session self-revoke did not atomically append audit evidence';
  END IF;
END;
$$;

SET ROLE console_api;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM console_operation.accept_operation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, 'console.registry.manage',
      'console.registry.connection.remove', '1.0',
      'registry-connection:opensphere-ghcr',
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'R2', 'remove registry credential',
      'console-operation-policy-2026-09-01.1', false,
      'registry-operation-0005', 'correlation-registry-0005',
      NULL, 'C_EXT', NULL
    );
    RAISE EXCEPTION 'revoked session unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
  BEGIN
    PERFORM console_operation.get_operation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      current_setting('verification.operation_id')::uuid
    );
    RAISE EXCEPTION 'revoked session unexpectedly read an operation';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
END;
$$;
RESET ROLE;

UPDATE console_identity.browser_session
SET revoked_at = NULL, revoke_reason = NULL
WHERE session_id = '22222222-2222-4222-8222-222222222222';

SET ROLE console_api;
DO $$
BEGIN
  BEGIN
    INSERT INTO console_operation.operation(
      action_id, action_version, actor_ref, target_ref, required_permission,
      payload_digest, request_digest, risk, aal, permission_revision,
      plan_revision, approval_required, idempotency_key, correlation_id, state
    ) VALUES (
      'console.direct.write', '1.0', '11111111-1111-4111-8111-111111111111',
      'forbidden', 'console.registry.manage',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'R0', 'aal2', 7, 'forbidden', false, 'forbidden-write', 'forbidden-correlation', 'Planned'
    );
    RAISE EXCEPTION 'console_api direct table write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE console_audit.event SET outcome = 'failed';
    RAISE EXCEPTION 'console_api audit update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  IF (SELECT count(*) FROM console_operation.operation) <> 1 THEN
    RAISE EXCEPTION 'authenticated actor cannot read its own operation';
  END IF;
  BEGIN
    INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
    VALUES (
      '11111111-1111-4111-8111-111111111111', 'console.forbidden.write', 8,
      '99999999-9999-4999-8999-999999999999'
    );
    RAISE EXCEPTION 'authenticated role mutated RBAC directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
ROLLBACK;

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
  IF (SELECT count(*) FROM console_operation.operation) <> 1
      OR (SELECT count(*) FROM console_operation.outbox) <> 1
      OR (SELECT count(*) FROM console_audit.event) <> 2 THEN
    RAISE EXCEPTION 'negative tests changed atomic authority records';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relrowsecurity AND relnamespace IN (
    'console_identity'::regnamespace,
    'console_operation'::regnamespace,
    'console_audit'::regnamespace,
    'console_extension'::regnamespace
  )) <> 11 THEN
    RAISE EXCEPTION 'expected eleven RLS-protected authority tables';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM console_audit.event e
    WHERE e.event_hash <> 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
      'eventId', e.event_id,
      'operationId', e.operation_id,
      'occurredAt', e.occurred_at,
      'correlationId', e.correlation_id,
      'actorRef', e.actor_ref,
      'action', e.action,
      'targetRef', e.target_ref,
      'outcome', e.outcome,
      'reason', e.reason,
      'evidence', e.evidence,
      'previousHash', e.previous_hash
    )::text, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'audit event hash verification failed';
  END IF;
END;
$$;

SET ROLE console_api;
SELECT * FROM console_operation.accept_operation(
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  7, 2, 'console.extension.revoke',
  'console.extension.revocation.create', '1.0',
  'ghcr.io/opensphere-platform/console@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  'R2', 'revoke compromised image',
  'console-operation-policy-2026-09-01.1', true,
  'approval-source-operation-0001', 'correlation-approval-source-0001',
  NULL, 'C_EXT', NULL
);
RESET ROLE;

SELECT set_config(
  'verification.approval_operation_id',
  (SELECT operation_id::text FROM console_operation.operation WHERE idempotency_key = 'approval-source-operation-0001'),
  false
);

SET ROLE console_api;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM console_operation.approve_operation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, current_setting('verification.approval_operation_id')::uuid, 0,
      'self approval must fail', 'console-operation-policy-2026-09-01.1', NULL,
      'self-approval-operation-0001', 'correlation-self-approval-0001'
    );
    RAISE EXCEPTION 'operation initiator unexpectedly approved its own operation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM console_operation.approve_operation(
      '77777777-7777-4777-8777-777777777777',
      '55555555-5555-4555-8555-555555555555',
      3, 0, current_setting('verification.approval_operation_id')::uuid, 0,
      'aal1 approval must fail', 'console-operation-policy-2026-09-01.1', NULL,
      'aal1-approval-operation-0001', 'correlation-aal1-approval-0001'
    );
    RAISE EXCEPTION 'aal1 approval unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM console_operation.approve_operation(
      '88888888-8888-4888-8888-888888888888',
      '88888888-8888-4888-8888-888888888888',
      3, 0, current_setting('verification.approval_operation_id')::uuid, 0,
      'alias account approval must fail', 'console-operation-policy-2026-09-01.1', NULL,
      'alias-approval-operation-0001', 'correlation-alias-approval-0001'
    );
    RAISE EXCEPTION 'second account for the same person unexpectedly approved the operation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

SELECT * FROM console_operation.approve_operation(
  '66666666-6666-4666-8666-666666666666',
  '55555555-5555-4555-8555-555555555555',
  3, 0, current_setting('verification.approval_operation_id')::uuid, 0,
  'independent approval completed', 'console-operation-policy-2026-09-01.1', NULL,
  'approval-operation-0001', 'correlation-approval-0001'
);

SELECT * FROM console_operation.approve_operation(
  '66666666-6666-4666-8666-666666666666',
  '55555555-5555-4555-8555-555555555555',
  3, 0, current_setting('verification.approval_operation_id')::uuid, 0,
  'independent approval completed', 'console-operation-policy-2026-09-01.1', NULL,
  'approval-operation-0001', 'correlation-approval-0001'
);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM console_operation.approve_operation(
      '66666666-6666-4666-8666-666666666666',
      '55555555-5555-4555-8555-555555555555',
      3, 0, current_setting('verification.approval_operation_id')::uuid, 0,
      'different approval content', 'console-operation-policy-2026-09-01.1', NULL,
      'approval-operation-0001', 'correlation-approval-0001'
    );
    RAISE EXCEPTION 'approval idempotency mismatch unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE '%different approval%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM * FROM console_operation.approve_operation(
      '66666666-6666-4666-8666-666666666666',
      '55555555-5555-4555-8555-555555555555',
      3, 0, current_setting('verification.approval_operation_id')::uuid, 0,
      'second approval must fail', 'console-operation-policy-2026-09-01.1', NULL,
      'approval-operation-0002', 'correlation-approval-0002'
    );
    RAISE EXCEPTION 'stale state approval unexpectedly succeeded';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM console_operation.approval WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 1
      OR (SELECT state FROM console_operation.operation WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 'Authorized'
      OR (SELECT state_version FROM console_operation.operation WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 1
      OR (SELECT count(*) FROM console_operation.outbox WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 2
      OR (SELECT count(*) FROM console_audit.event WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 2 THEN
    RAISE EXCEPTION 'approval was not committed atomically or replay created duplicate effects';
  END IF;
  IF EXISTS (
    SELECT 1 FROM console_operation.approval a
    JOIN console_operation.operation o USING (operation_id)
    WHERE a.actor_ref = o.actor_ref
  ) THEN
    RAISE EXCEPTION 'distinct-person approval invariant was violated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT sequence_id, previous_hash,
        lag(event_hash) OVER (ORDER BY sequence_id) AS expected_previous_hash
      FROM console_audit.event
    ) chain
    WHERE previous_hash IS DISTINCT FROM expected_previous_hash
  ) THEN
    RAISE EXCEPTION 'audit chain linkage verification failed after approval';
  END IF;
END;
$$;

SET ROLE console_extension_controller;
DO $$
BEGIN
  BEGIN
    PERFORM console_operation.claim_owner_operation(
      'aaaaaaaa-1111-4111-8111-111111111111',
      'C_API', ARRAY['console.registry.connection.replace'], 30
    );
    RAISE EXCEPTION 'Extension Controller claimed another owner capability';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM console_operation.claim_owner_operation(
      'aaaaaaaa-1111-4111-8111-111111111111',
      'C_EXT', ARRAY['console.registry.connection.replace'], 30
    );
    RAISE EXCEPTION 'Extension Controller claimed a credential-broker action';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
SELECT set_config(
  'verification.claim_one',
  console_operation.claim_owner_operation(
    'aaaaaaaa-1111-4111-8111-111111111111',
    'C_EXT', ARRAY['console.extension.revocation.create'], 30
  )::text,
  false
);

DO $$
DECLARE
  v_second_claim jsonb;
BEGIN
  IF (current_setting('verification.claim_one')::jsonb->>'claimEpoch')::bigint <> 1
      OR current_setting('verification.claim_one')::jsonb->>'resumeMode' <> 'apply'
      OR current_setting('verification.claim_one')::jsonb->>'state' <> 'Submitted' THEN
    RAISE EXCEPTION 'initial owner claim lost fencing or state evidence';
  END IF;
  v_second_claim := console_operation.claim_owner_operation(
    'bbbbbbbb-1111-4111-8111-111111111111',
    'C_EXT', ARRAY['console.extension.revocation.create'], 30
  );
  IF v_second_claim IS NOT NULL THEN
    RAISE EXCEPTION 'active owner lease was claimed concurrently';
  END IF;
  BEGIN
    INSERT INTO console_extension.revocation(
      image_ref, operation_id, payload_digest, action_version, claim_epoch
    ) VALUES (
      'ghcr.io/opensphere-platform/forbidden@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      current_setting('verification.approval_operation_id')::uuid,
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '1.0', 1
    );
    RAISE EXCEPTION 'extension controller directly mutated its authority table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

UPDATE console_operation.outbox
SET lease_expires_at = statement_timestamp() - interval '1 second'
WHERE outbox_id = (current_setting('verification.claim_one')::jsonb->>'outboxId')::bigint;

SET ROLE console_extension_controller;
SELECT set_config(
  'verification.claim_two',
  console_operation.claim_owner_operation(
    'bbbbbbbb-1111-4111-8111-111111111111',
    'C_EXT', ARRAY['console.extension.revocation.create'], 30
  )::text,
  false
);

DO $$
DECLARE
  v_claim jsonb := current_setting('verification.claim_two')::jsonb;
BEGIN
  IF (v_claim->>'claimEpoch')::bigint <> 2 OR v_claim->>'resumeMode' <> 'reconcile' THEN
    RAISE EXCEPTION 'expired claim was not resumed with a new fence';
  END IF;
  BEGIN
    PERFORM console_operation.renew_owner_claim(
      'aaaaaaaa-1111-4111-8111-111111111111',
      (current_setting('verification.claim_one')::jsonb->>'outboxId')::bigint,
      1, 30
    );
    RAISE EXCEPTION 'stale worker renewed a replaced claim';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  PERFORM console_operation.renew_owner_claim(
    'bbbbbbbb-1111-4111-8111-111111111111',
    (v_claim->>'outboxId')::bigint,
    (v_claim->>'claimEpoch')::bigint,
    30
  );
  BEGIN
    PERFORM console_extension.apply_revocation(
      'bbbbbbbb-1111-4111-8111-111111111111',
      (v_claim->>'outboxId')::bigint,
      (v_claim->>'claimEpoch')::bigint,
      (v_claim->>'operationId')::uuid,
      'ghcr.io/opensphere-platform/wrong@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      v_claim->>'payloadDigest'
    );
    RAISE EXCEPTION 'claim target substitution unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

SELECT console_extension.apply_revocation(
  'bbbbbbbb-1111-4111-8111-111111111111',
  (current_setting('verification.claim_two')::jsonb->>'outboxId')::bigint,
  (current_setting('verification.claim_two')::jsonb->>'claimEpoch')::bigint,
  (current_setting('verification.claim_two')::jsonb->>'operationId')::uuid,
  current_setting('verification.claim_two')::jsonb->>'targetRef',
  current_setting('verification.claim_two')::jsonb->>'payloadDigest'
);
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM console_extension.revocation) <> 1
      OR (SELECT count(*) FROM console_operation.execution_receipt) <> 1
      OR (SELECT state FROM console_operation.operation WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 'Applied'
      OR (SELECT state_version FROM console_operation.operation WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 4
      OR (SELECT delivered_at IS NULL FROM console_operation.outbox WHERE outbox_id = (current_setting('verification.claim_two')::jsonb->>'outboxId')::bigint)
      OR (SELECT count(*) FROM console_audit.event WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 5 THEN
    RAISE EXCEPTION 'fenced Extension execution receipt is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT sequence_id, previous_hash,
        lag(event_hash) OVER (ORDER BY sequence_id) AS expected_previous_hash
      FROM console_audit.event
    ) chain
    WHERE previous_hash IS DISTINCT FROM expected_previous_hash
  ) THEN
    RAISE EXCEPTION 'audit chain linkage verification failed after owner execution';
  END IF;
END;
$$;

SET ROLE console_api;
DO $$
BEGIN
  BEGIN
    PERFORM console_operation.verify_extension_revocation(
      '66666666-6666-4666-8666-666666666666',
      '55555555-5555-4555-8555-555555555555',
      3, 0, current_setting('verification.approval_operation_id')::uuid, 4,
      'verification-permission-denied-0001', 'correlation-verification-denied-0001'
    );
    RAISE EXCEPTION 'verification without permission unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM console_operation.verify_extension_revocation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, current_setting('verification.approval_operation_id')::uuid, 3,
      'verification-stale-version-0001', 'correlation-verification-stale-0001'
    );
    RAISE EXCEPTION 'verification with a stale state version unexpectedly succeeded';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE console_api;
DO $$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_cursor bigint;
BEGIN
  v_first := console_audit.list_events(
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    7, 2, NULL, 2, 'correlation-audit-read-page-one'
  );
  IF v_first->>'authority' <> 'SupabaseAuditLedger'
      OR v_first->>'freshness' <> 'fresh'
      OR jsonb_array_length(v_first->'data'->'items') <> 2
      OR v_first->'data'->>'nextCursor' IS NULL
      OR jsonb_array_length(v_first->'evidenceRefs') <> 2 THEN
    RAISE EXCEPTION 'audit first page lost bounded ledger semantics';
  END IF;
  v_cursor := (v_first->'data'->>'nextCursor')::bigint;
  v_second := console_audit.list_events(
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    7, 2, v_cursor, 2, 'correlation-audit-read-page-two'
  );
  IF jsonb_array_length(v_second->'data'->'items') < 1
      OR (v_second->'data'->'items'->0->>'sequenceId')::bigint >= v_cursor THEN
    RAISE EXCEPTION 'audit cursor did not move monotonically backward';
  END IF;
  BEGIN
    PERFORM console_audit.list_events(
      '66666666-6666-4666-8666-666666666666',
      '55555555-5555-4555-8555-555555555555',
      3, 0, NULL, 50, 'correlation-forbidden-audit-read'
    );
    RAISE EXCEPTION 'actor without audit permission read the ledger';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  BEGIN
    UPDATE console_extension.revocation
      SET payload_digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      WHERE operation_id = current_setting('verification.approval_operation_id')::uuid;
    PERFORM console_operation.verify_extension_revocation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, current_setting('verification.approval_operation_id')::uuid, 4,
      'verification-mismatch-0001', 'correlation-verification-mismatch-0001'
    );
    RAISE EXCEPTION 'verification with a mismatched observation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

SET ROLE console_api;
SELECT * FROM console_operation.verify_extension_revocation(
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  7, 2, current_setting('verification.approval_operation_id')::uuid, 4,
  'verification-operation-0001', 'correlation-verification-operation-0001'
);
SELECT * FROM console_operation.verify_extension_revocation(
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  7, 2, current_setting('verification.approval_operation_id')::uuid, 4,
  'verification-operation-0001', 'correlation-verification-operation-0001'
);
DO $$
BEGIN
  BEGIN
    PERFORM console_operation.verify_extension_revocation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, current_setting('verification.approval_operation_id')::uuid, 5,
      'verification-operation-0001', 'correlation-verification-operation-0001'
    );
    RAISE EXCEPTION 'verification idempotency mismatch unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM console_operation.verification_receipt
      WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 1
      OR (SELECT state FROM console_operation.operation
          WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 'Verified'
      OR (SELECT state_version FROM console_operation.operation
          WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 5
      OR (SELECT observed_postcondition->>'authority' FROM console_operation.operation
          WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 'ConsoleExtensionRevocation'
      OR (SELECT count(*) FROM console_audit.event
          WHERE operation_id = current_setting('verification.approval_operation_id')::uuid) <> 6 THEN
    RAISE EXCEPTION 'verification receipt was not committed atomically or replay created duplicate effects';
  END IF;
END;
$$;


SET ROLE console_api;
SELECT * FROM console_operation.accept_operation(
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  7, 2, 'console.extension.revoke',
  'console.extension.revocation.create', '1.0',
  'ghcr.io/opensphere-platform/failure-fixture@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'R2', 'exercise unknown execution receipt',
  'console-operation-policy-2026-09-01.1', true,
  'failure-source-operation-0001', 'correlation-failure-source-0001',
  NULL, 'C_EXT', NULL
);
RESET ROLE;
SELECT set_config(
  'verification.failure_operation_id',
  (SELECT operation_id::text FROM console_operation.operation WHERE idempotency_key = 'failure-source-operation-0001'),
  false
);
SET ROLE console_api;
SELECT * FROM console_operation.approve_operation(
  '66666666-6666-4666-8666-666666666666',
  '55555555-5555-4555-8555-555555555555',
  3, 0, current_setting('verification.failure_operation_id')::uuid, 0,
  'approve failure receipt fixture', 'console-operation-policy-2026-09-01.1', NULL,
  'failure-approval-operation-0001', 'correlation-failure-approval-0001'
);
RESET ROLE;
SET ROLE console_extension_controller;
SELECT set_config(
  'verification.failure_claim',
  console_operation.claim_owner_operation(
    'dddddddd-1111-4111-8111-111111111111',
    'C_EXT', ARRAY['console.extension.revocation.create'], 30
  )::text,
  false
);
SELECT console_extension.record_execution_failure(
  'dddddddd-1111-4111-8111-111111111111',
  (current_setting('verification.failure_claim')::jsonb->>'outboxId')::bigint,
  (current_setting('verification.failure_claim')::jsonb->>'claimEpoch')::bigint,
  current_setting('verification.failure_operation_id')::uuid,
  'OwnerTimeout',
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  true
);
RESET ROLE;

DO $$
BEGIN
  IF (SELECT state FROM console_operation.operation WHERE operation_id = current_setting('verification.failure_operation_id')::uuid) <> 'Unknown'
      OR (SELECT state_version FROM console_operation.operation WHERE operation_id = current_setting('verification.failure_operation_id')::uuid) <> 3
      OR (SELECT count(*) FROM console_operation.execution_receipt
          WHERE operation_id = current_setting('verification.failure_operation_id')::uuid AND phase = 'Unknown') <> 1
      OR (SELECT error->>'sideEffect' FROM console_operation.operation
          WHERE operation_id = current_setting('verification.failure_operation_id')::uuid) <> 'unknown' THEN
    RAISE EXCEPTION 'typed Unknown execution receipt was not committed';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE console_operation.operation
      SET state = 'Applied', state_version = 4
      WHERE operation_id = current_setting('verification.failure_operation_id')::uuid;
    PERFORM console_operation.verify_extension_revocation(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      7, 2, current_setting('verification.failure_operation_id')::uuid, 4,
      'verification-missing-observation-0001', 'correlation-verification-missing-0001'
    );
    RAISE EXCEPTION 'verification without an owner observation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%missing%' THEN RAISE; END IF;
  END;
END;
$$;

SET ROLE console_api;
DO $$
DECLARE
  v_projection jsonb;
BEGIN
  v_projection := console_extension.get_registry_connection(
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'correlation-registry-read-0001'
  );
  IF v_projection->>'authority' <> 'ConsoleRegistryConnectionMetadata'
      OR v_projection->>'freshness' <> 'fresh'
      OR v_projection->'data'->>'connectionId' <> 'opensphere-ghcr'
      OR v_projection->'data'->>'configurationState' <> 'NotConfigured'
      OR (v_projection->'data'->>'credentialPresent')::boolean
      OR v_projection->'data' ? 'secretRefDigest'
      OR jsonb_array_length(v_projection->'evidenceRefs') <> 1 THEN
    RAISE EXCEPTION 'Registry connection projection lost fixed no-secret authority semantics';
  END IF;
  BEGIN
    PERFORM console_extension.get_registry_connection(
      '66666666-6666-4666-8666-666666666666',
      '55555555-5555-4555-8555-555555555555',
      'correlation-forbidden-registry-read-0001'
    );
    RAISE EXCEPTION 'actor without Registry permission read connection metadata';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

DO $$
DECLARE
  v_projection jsonb;
BEGIN
  v_projection := console_extension.list_revocations(
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'correlation-revocation-read-0001'
  );
  IF v_projection->>'authority' <> 'ConsoleExtensionRevocation'
      OR v_projection->>'freshness' <> 'fresh'
      OR jsonb_array_length(v_projection->'data') <> 1
      OR v_projection->'data'->0->>'imageRef' <> 'ghcr.io/opensphere-platform/console@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      OR jsonb_array_length(v_projection->'evidenceRefs') <> 1 THEN
    RAISE EXCEPTION 'C_EXT revocation read projection lost authority evidence';
  END IF;
  BEGIN
    PERFORM console_extension.list_revocations(
      '66666666-6666-4666-8666-666666666666',
      '55555555-5555-4555-8555-555555555555',
      'correlation-forbidden-revocation-read-0001'
    );
    RAISE EXCEPTION 'approver without revocation permission read the projection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;
