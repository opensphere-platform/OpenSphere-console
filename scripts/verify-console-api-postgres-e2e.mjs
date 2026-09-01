import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/console-api/package.json', import.meta.url));
const { Pool } = requireFromApi('pg');

const runtimeUrl = process.env.CONSOLE_DATABASE_URL;
const adminUrl = process.env.CONSOLE_TEST_ADMIN_DATABASE_URL;
if (!runtimeUrl || !adminUrl) throw new Error('Console API runtime and test-admin database URLs are required');

const port = Number(process.env.CONSOLE_TEST_PORT || 58080);
const origin = 'http://127.0.0.1:' + port;
const handle = 'opaque-session-handle-for-console-api-integration';
const csrf = 'csrf-proof-for-console-api-integration';
const credential = 'integration-registry-credential-never-persisted';
const correlationId = 'integration-correlation-registry-0001';
const idempotencyKey = 'integration-registry-operation-0001';
const approverHandle = 'opaque-approver-session-for-console-api-integration';
const approverCsrf = 'csrf-approver-proof-for-console-api-integration';
const approvalCorrelationId = 'integration-correlation-approval-0001';
const approvalIdempotencyKey = 'integration-approval-operation-0001';
const policyRevision = 'console-operation-policy-2026-09-01.1';
const headers = {
  cookie: '__Host-opensphere-session=' + handle,
  'x-csrf-token': csrf,
  'idempotency-key': idempotencyKey,
  'x-correlation-id': correlationId,
  'content-type': 'application/json',
};
const body = JSON.stringify({
  username: 'opensphere-platform',
  credential,
  reason: 'verify Console API PostgreSQL integration',
});
const child = spawn(process.execPath, ['apps/console-api/src/server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), CONSOLE_DATABASE_URL: runtimeUrl },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let extensionChild;
let extensionOutput = '';
let childOutput = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    childOutput = (childOutput + chunk.toString('utf8')).slice(-4000);
  });
}
const admin = new Pool({ connectionString: adminUrl, max: 1 });

async function waitForReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error('Console API exited before readiness: ' + childOutput);
    try {
      const response = await fetch(origin + '/healthz');
      if (response.ok && (await response.json()).state === 'Ready') return;
    } catch {
      // Bounded startup retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Console API readiness timed out: ' + childOutput);
}

async function startExtensionController() {
  const extensionDatabaseUrl = process.env.CONSOLE_EXTENSION_DATABASE_URL;
  if (!extensionDatabaseUrl) throw new Error('CONSOLE_EXTENSION_DATABASE_URL is required');
  extensionChild = spawn(process.execPath, ['apps/extension-controller/src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: '58081',
      CONSOLE_EXTENSION_DATABASE_URL: extensionDatabaseUrl,
      CONSOLE_EXTENSION_WORKER_ID: 'cccccccc-1111-4111-8111-111111111111',
      CONSOLE_EXTENSION_POLL_MS: '100',
      CONSOLE_EXTENSION_LEASE_SECONDS: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [extensionChild.stdout, extensionChild.stderr]) {
    stream.on('data', (chunk) => {
      extensionOutput = (extensionOutput + chunk.toString('utf8')).slice(-4000);
    });
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (extensionChild.exitCode != null) throw new Error('Extension Controller exited before readiness: ' + extensionOutput);
    try {
      const response = await fetch('http://127.0.0.1:58081/healthz');
      if (response.ok && (await response.json()).state === 'Ready') return;
    } catch {
      // Bounded startup retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Extension Controller readiness timed out: ' + extensionOutput);
}

async function mutation(candidateBody = body, candidateHeaders = headers) {
  return fetch(origin + '/api/admin/extensions/registry-connections/opensphere-ghcr', {
    method: 'PUT',
    headers: candidateHeaders,
    body: candidateBody,
  });
}

async function createRevocation() {
  const image = 'ghcr.io/opensphere-platform/console@sha256:' + 'e'.repeat(64);
  const response = await fetch(origin + '/api/admin/extensions/revocations', {
    method: 'POST',
    headers: {
      ...headers,
      'idempotency-key': 'integration-revocation-operation-0001',
      'x-correlation-id': 'integration-correlation-revocation-0001',
    },
    body: JSON.stringify({
      image,
      reason: 'verify independent approval integration',
      confirmation: 'REVOKE ' + image,
    }),
  });
  assert.equal(response.status, 202);
  return response.json();
}

function approval(operationId, candidateBody, candidateHeaders = {}) {
  return fetch(origin + '/api/platform/operations/' + operationId + '/approvals', {
    method: 'POST',
    headers: {
      cookie: '__Host-opensphere-session=' + approverHandle,
      'x-csrf-token': approverCsrf,
      'idempotency-key': approvalIdempotencyKey,
      'x-correlation-id': approvalCorrelationId,
      'content-type': 'application/json',
      ...candidateHeaders,
    },
    body: JSON.stringify(candidateBody),
  });
}

function verification(operationId, candidateBody, candidateHeaders = {}) {
  return fetch(origin + '/api/platform/operations/' + operationId + '/verification', {
    method: 'POST',
    headers: {
      cookie: headers.cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'integration-verification-operation-0001',
      'x-correlation-id': 'integration-verification-correlation-0001',
      'content-type': 'application/json',
      ...candidateHeaders,
    },
    body: JSON.stringify(candidateBody),
  });
}

try {
  await waitForReady();
  const connectionProjectionResponse = await fetch(
    origin + '/api/admin/extensions/registry-connections/opensphere-ghcr',
    { headers: { cookie: headers.cookie, 'x-correlation-id': 'integration-registry-read-0001' } },
  );
  assert.equal(connectionProjectionResponse.status, 200);
  const connectionProjection = await connectionProjectionResponse.json();
  assert.equal(connectionProjection.authority, 'ConsoleRegistryConnectionMetadata');
  assert.equal(connectionProjection.data.connectionId, 'opensphere-ghcr');
  assert.equal(connectionProjection.data.configurationState, 'NotConfigured');
  assert.equal(connectionProjection.data.credentialPresent, false);
  assert.doesNotMatch(JSON.stringify(connectionProjection), /secretRef|credentialDigest|password|token/i);

  const accepted = await mutation();
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get('x-idempotent-replay'), 'false');
  const receipt = await accepted.json();
  assert.equal(receipt.actionId, 'console.registry.connection.replace');
  assert.equal(receipt.state, 'Authorized');
  assert.equal(receipt.correlationId, correlationId);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(credential));

  const replay = await mutation();
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await replay.json()).operationId, receipt.operationId);

  const mismatch = await mutation(JSON.stringify({
    username: 'opensphere-platform',
    credential: 'different-integration-registry-credential',
    reason: 'verify Console API PostgreSQL integration',
  }));
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, 'IdempotencyMismatch');

  const evidence = await admin.query(
    [
      'SELECT',
      '(SELECT count(*)::int FROM console_operation.operation WHERE correlation_id = $1) AS operations,',
      '(SELECT count(*)::int FROM console_operation.outbox o JOIN console_operation.operation p USING(operation_id) WHERE p.correlation_id = $1) AS outbox_events,',
      '(SELECT count(*)::int FROM console_audit.event WHERE correlation_id = $1) AS audit_events,',
      'position($2 in (',
      'COALESCE((SELECT string_agg(row_to_json(p)::text, \'\') FROM console_operation.operation p WHERE p.correlation_id = $1), \'\') ||',
      'COALESCE((SELECT string_agg(o.payload::text, \'\') FROM console_operation.outbox o JOIN console_operation.operation p USING(operation_id) WHERE p.correlation_id = $1), \'\') ||',
      'COALESCE((SELECT string_agg(a.evidence::text, \'\') FROM console_audit.event a WHERE a.correlation_id = $1), \'\')',
      ')) AS credential_position',
    ].join(' '),
    [correlationId, credential],
  );
  assert.deepEqual(evidence.rows[0], {
    operations: 1,
    outbox_events: 1,
    audit_events: 1,
    credential_position: 0,
  });

  const plannedRevocation = await createRevocation();
  assert.equal(plannedRevocation.state, 'Planned');
  assert.equal(plannedRevocation.approvalRequired, true);
  const approvalBody = {
    reason: 'independent approval integration review',
    approvalRevision: policyRevision,
    expectedStateVersion: 0,
    confirmation: null,
  };

  const selfApproval = await approval(plannedRevocation.operationId, approvalBody, {
    cookie: headers.cookie,
    'x-csrf-token': csrf,
    'idempotency-key': 'integration-self-approval-operation-0001',
    'x-correlation-id': 'integration-self-approval-correlation-0001',
  });
  assert.equal(selfApproval.status, 403);
  assert.equal((await selfApproval.json()).code, 'PermissionDenied');

  const approved = await approval(plannedRevocation.operationId, approvalBody);
  assert.equal(approved.status, 202);
  assert.equal(approved.headers.get('x-idempotent-replay'), 'false');
  const approvedReceipt = await approved.json();
  assert.equal(approvedReceipt.state, 'Authorized');
  assert.equal(approvedReceipt.stateVersion, 1);
  assert.equal(approvedReceipt.approvalRevision, policyRevision);

  const approvalReplay = await approval(plannedRevocation.operationId, approvalBody);
  assert.equal(approvalReplay.status, 202);
  assert.equal(approvalReplay.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await approvalReplay.json()).operationId, plannedRevocation.operationId);

  const approvalMismatch = await approval(plannedRevocation.operationId, {
    ...approvalBody,
    reason: 'different approval replay content',
  });
  assert.equal(approvalMismatch.status, 409);
  assert.equal((await approvalMismatch.json()).code, 'IdempotencyMismatch');

  const approvalEvidence = await admin.query(
    [
      'SELECT',
      '(SELECT count(*)::int FROM console_operation.approval WHERE operation_id = $1) AS approvals,',
      '(SELECT count(*)::int FROM console_operation.outbox WHERE operation_id = $1) AS outbox_events,',
      '(SELECT count(*)::int FROM console_audit.event WHERE operation_id = $1) AS audit_events,',
      '(SELECT state FROM console_operation.operation WHERE operation_id = $1) AS state,',
      '(SELECT state_version::int FROM console_operation.operation WHERE operation_id = $1) AS state_version'
    ].join(' '),
    [plannedRevocation.operationId],
  );
  assert.deepEqual(approvalEvidence.rows[0], {
    approvals: 1,
    outbox_events: 2,
    audit_events: 2,
    state: 'Authorized',
    state_version: 1,
  });

  await admin.query(
    [
      'UPDATE console_identity.browser_session',
      'SET revoked_at = statement_timestamp(), revoke_reason = $1',
      'WHERE session_id = $2',
    ].join(' '),
    ['integration approver revoke', '66666666-6666-4666-8666-666666666666'],
  );
  const revokedApproval = await approval(plannedRevocation.operationId, approvalBody, {
    'idempotency-key': 'integration-revoked-approval-operation-0001',
  });
  assert.equal(revokedApproval.status, 401);
  assert.equal((await revokedApproval.json()).code, 'AuthenticationRequired');

  await startExtensionController();
  let executionEvidence;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = await admin.query(
      [
        'SELECT',
        '(SELECT state FROM console_operation.operation WHERE operation_id = $1) AS state,',
        '(SELECT state_version::int FROM console_operation.operation WHERE operation_id = $1) AS state_version,',
        '(SELECT count(*)::int FROM console_operation.execution_receipt WHERE operation_id = $1) AS receipts,',
        '(SELECT count(*)::int FROM console_extension.revocation WHERE operation_id = $1) AS revocations,',
        '(SELECT count(*)::int FROM console_operation.outbox WHERE operation_id = $1 AND delivered_at IS NOT NULL) AS delivered_outbox'
      ].join(' '),
      [plannedRevocation.operationId],
    );
    if (candidate.rows[0].state === 'Applied') {
      executionEvidence = candidate.rows[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(executionEvidence, {
    state: 'Applied',
    state_version: 4,
    receipts: 1,
    revocations: 1,
    delivered_outbox: 1,
  });
  const revocationProjectionResponse = await fetch(origin + '/api/admin/extensions/revocations', {
    headers: {
      cookie: headers.cookie,
      'x-correlation-id': 'integration-revocation-projection-0001',
    },
  });
  assert.equal(revocationProjectionResponse.status, 200);
  const revocationProjection = await revocationProjectionResponse.json();
  assert.equal(revocationProjection.authority, 'ConsoleExtensionRevocation');
  assert.equal(revocationProjection.freshness, 'fresh');
  assert.equal(revocationProjection.correlationId, 'integration-revocation-projection-0001');
  assert.equal(
    revocationProjection.data.some((item) => item.imageRef === plannedRevocation.targetRef
      && item.operationId === plannedRevocation.operationId),
    true,
  );

  const verified = await verification(plannedRevocation.operationId, { expectedStateVersion: 4 });
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get('x-idempotent-replay'), 'false');
  const verifiedReceipt = await verified.json();
  assert.equal(verifiedReceipt.state, 'Verified');
  assert.equal(verifiedReceipt.stateVersion, 5);
  assert.equal(verifiedReceipt.observedPostcondition.authority, 'ConsoleExtensionRevocation');

  const verificationReplay = await verification(plannedRevocation.operationId, { expectedStateVersion: 4 });
  assert.equal(verificationReplay.status, 200);
  assert.equal(verificationReplay.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await verificationReplay.json()).state, 'Verified');

  const verificationMismatch = await verification(
    plannedRevocation.operationId,
    { expectedStateVersion: 5 },
  );
  assert.equal(verificationMismatch.status, 409);
  assert.equal((await verificationMismatch.json()).code, 'IdempotencyMismatch');

  const verificationEvidence = await admin.query(
    [
      'SELECT',
      '(SELECT state FROM console_operation.operation WHERE operation_id = $1) AS state,',
      '(SELECT state_version::int FROM console_operation.operation WHERE operation_id = $1) AS state_version,',
      '(SELECT count(*)::int FROM console_operation.verification_receipt WHERE operation_id = $1) AS verifications,',
      '(SELECT count(*)::int FROM console_operation.execution_receipt WHERE operation_id = $1) AS owner_receipts,',
      '(SELECT count(*)::int FROM console_audit.event WHERE operation_id = $1) AS audit_events'
    ].join(' '),
    [plannedRevocation.operationId],
  );
  assert.deepEqual(verificationEvidence.rows[0], {
    state: 'Verified',
    state_version: 5,
    verifications: 1,
    owner_receipts: 1,
    audit_events: 5,
  });

  const auditResponse = await fetch(origin + '/api/identity/audit?limit=2', {
    headers: { cookie: headers.cookie, 'x-correlation-id': 'integration-audit-read-page-one' },
  });
  assert.equal(auditResponse.status, 200);
  const auditProjection = await auditResponse.json();
  assert.equal(auditProjection.authority, 'SupabaseAuditLedger');
  assert.equal(auditProjection.data.items.length, 2);
  assert.match(auditProjection.data.nextCursor, /^[1-9][0-9]*$/);
  assert.equal(auditProjection.data.items[0].operationId, plannedRevocation.operationId);
  assert.match(auditProjection.data.items[0].eventHash, /^sha256:[0-9a-f]{64}$/);

  const nextAuditResponse = await fetch(
    origin + '/api/identity/audit?limit=2&cursor=' + auditProjection.data.nextCursor,
    { headers: { cookie: headers.cookie, 'x-correlation-id': 'integration-audit-read-page-two' } },
  );
  assert.equal(nextAuditResponse.status, 200);
  const nextAuditProjection = await nextAuditResponse.json();
  assert.equal(nextAuditProjection.data.items.length, 2);
  assert.equal(
    BigInt(nextAuditProjection.data.items[0].sequenceId) < BigInt(auditProjection.data.nextCursor),
    true,
  );

  const sessionProjectionResponse = await fetch(origin + '/api/identity/session', {
    headers: { cookie: headers.cookie, 'x-correlation-id': 'integration-session-read-0001' },
  });
  assert.equal(sessionProjectionResponse.status, 200);
  const sessionProjection = await sessionProjectionResponse.json();
  assert.equal(sessionProjection.authority, 'SupabaseAuth');
  assert.equal(sessionProjection.data.state, 'Active');
  assert.equal(sessionProjection.data.subjectId, '11111111-1111-4111-8111-111111111111');

  const actorProjectionResponse = await fetch(origin + '/api/identity/me', {
    headers: { cookie: headers.cookie, 'x-correlation-id': 'integration-actor-read-0001' },
  });
  assert.equal(actorProjectionResponse.status, 200);
  const actorProjection = await actorProjectionResponse.json();
  assert.equal(actorProjection.authority, 'SupabaseAuth');
  assert.equal(actorProjection.data.permissions.includes('console.audit.read'), true);
  assert.doesNotMatch(JSON.stringify(actorProjection.data), /sessionId|token|cookie|csrf/i);

  const logoutResponse = await fetch(origin + '/api/identity/session', {
    method: 'DELETE',
    headers: {
      cookie: headers.cookie,
      'x-csrf-token': csrf,
      'x-correlation-id': 'integration-session-revoke-0001',
    },
  });
  assert.equal(logoutResponse.status, 204);
  assert.match(logoutResponse.headers.get('set-cookie'), /^__Host-opensphere-session=;/);
  assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);
  const revoked = await mutation(body, { ...headers, 'idempotency-key': 'integration-registry-operation-0002' });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).code, 'AuthenticationRequired');

  process.stdout.write(JSON.stringify({
    status: 'passed',
    operationId: receipt.operationId,
    durableCounts: evidence.rows[0],
    registryConnectionProjection: true,
    replay: true,
    idempotencyMismatch: true,
    approval: approvalEvidence.rows[0],
    selfApprovalDenied: true,
    revokedApprovalDenied: true,
    extensionExecution: executionEvidence,
    revocationProjection: true,
    verification: verificationEvidence.rows[0],
    auditProjection: true,
    identityProjection: true,
    sessionSelfRevoke: true,
    revokeDenied: true,
  }) + '\n');
} finally {
  await admin.query(
    [
      'UPDATE console_identity.browser_session',
      'SET revoked_at = NULL, revoke_reason = NULL',
      'WHERE session_id = $1',
    ].join(' '),
    ['22222222-2222-4222-8222-222222222222'],
  ).catch(() => {});
  await admin.query(
    [
      'UPDATE console_identity.browser_session',
      'SET revoked_at = NULL, revoke_reason = NULL',
      'WHERE session_id = $1',
    ].join(' '),
    ['66666666-6666-4666-8666-666666666666'],
  ).catch(() => {});
  await admin.end().catch(() => {});
  if (extensionChild && extensionChild.exitCode == null) extensionChild.kill('SIGTERM');
  if (extensionChild) {
    await Promise.race([
      new Promise((resolve) => extensionChild.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (extensionChild.exitCode == null) extensionChild.kill('SIGKILL');
  }
  if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}
