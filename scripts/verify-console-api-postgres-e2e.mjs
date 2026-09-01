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

async function mutation(candidateBody = body, candidateHeaders = headers) {
  return fetch(origin + '/api/admin/extensions/registry-connections/opensphere-ghcr', {
    method: 'PUT',
    headers: candidateHeaders,
    body: candidateBody,
  });
}

try {
  await waitForReady();
  const accepted = await mutation();
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get('x-idempotent-replay'), 'false');
  const receipt = await accepted.json();
  assert.equal(receipt.actionId, 'console.registry.connection.replace');
  assert.equal(receipt.state, 'Planned');
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

  await admin.query(
    [
      'UPDATE console_identity.browser_session',
      'SET revoked_at = statement_timestamp(), revoke_reason = $1',
      'WHERE session_id = $2',
    ].join(' '),
    ['integration revoke', '22222222-2222-4222-8222-222222222222'],
  );
  const revoked = await mutation(body, { ...headers, 'idempotency-key': 'integration-registry-operation-0002' });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).code, 'AuthenticationRequired');

  process.stdout.write(JSON.stringify({
    status: 'passed',
    operationId: receipt.operationId,
    durableCounts: evidence.rows[0],
    replay: true,
    idempotencyMismatch: true,
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
  await admin.end().catch(() => {});
  if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}
