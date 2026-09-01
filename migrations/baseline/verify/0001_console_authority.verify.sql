\set ON_ERROR_STOP on

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('99999999-9999-4999-8999-999999999999');

INSERT INTO console_identity.subject_authority(subject_id, permission_revision, revoke_epoch)
VALUES ('11111111-1111-4111-8111-111111111111', 7, 2);

INSERT INTO console_identity.permission_grant(subject_id, permission, grant_revision, granted_by)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'console.registry.manage', 7, '99999999-9999-4999-8999-999999999999'),
  ('11111111-1111-4111-8111-111111111111', 'console.extension.revoke', 7, '99999999-9999-4999-8999-999999999999');

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

CREATE ROLE console_api_runtime LOGIN PASSWORD 'console-runtime-test' INHERIT;
GRANT console_api TO console_api_runtime;

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
UPDATE console_identity.browser_session
SET revoked_at = statement_timestamp(), revoke_reason = 'verification revoke'
WHERE session_id = '22222222-2222-4222-8222-222222222222';

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
      OR (SELECT count(*) FROM console_audit.event) <> 1 THEN
    RAISE EXCEPTION 'negative tests changed atomic authority records';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relrowsecurity AND relnamespace IN (
    'console_identity'::regnamespace,
    'console_operation'::regnamespace,
    'console_audit'::regnamespace
  )) <> 6 THEN
    RAISE EXCEPTION 'expected six RLS-protected authority tables';
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
