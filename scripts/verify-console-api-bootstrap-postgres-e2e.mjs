import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/console-api/package.json', import.meta.url));
const { Pool } = requireFromApi('pg');

const runtimeUrl = process.env.CONSOLE_DATABASE_URL;
const adminUrl = process.env.CONSOLE_TEST_ADMIN_DATABASE_URL;
if (!runtimeUrl || !adminUrl) throw new Error('Console API runtime and test-admin database URLs are required');

const port = Number(process.env.CONSOLE_BOOTSTRAP_TEST_PORT || 58082);
const origin = 'http://127.0.0.1:' + port;
const publicOrigin = 'https://console-bootstrap.integration.test';
const serviceRoleKey = 'bootstrap-service-role-' + 's'.repeat(64);
const subjects = new Map([
  ['first@example.test', '31313131-3131-4313-8313-313131313131'],
  ['second@example.test', '32323232-3232-4323-8323-323232323232'],
  ['third@example.test', '33333333-3333-4333-8333-333333333333'],
]);
const created = [];
const deleted = [];
const admin = new Pool({ connectionString: adminUrl, max: 2 });

const authorityServer = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    assert.equal(request.headers.apikey, serviceRoleKey);
    assert.equal(request.headers.authorization, 'Bearer ' + serviceRoleKey);
    if (request.url === '/admin/users' && request.method === 'POST') {
      const email = String(body?.email || '');
      const subjectId = subjects.get(email);
      assert.ok(subjectId);
      assert.equal(body.email_confirm, true);
      assert.equal(body.user_metadata?.preferred_username, email.split('@')[0]);
      assert.ok(String(body.password || '').length >= 12);
      await admin.query('INSERT INTO auth.users(id) VALUES ($1::uuid)', [subjectId]);
      created.push(subjectId);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: subjectId }));
      return;
    }
    const deletion = String(request.url || '').match(/^\/admin\/users\/([0-9a-f-]+)$/u);
    if (deletion && request.method === 'DELETE') {
      await admin.query('DELETE FROM auth.users WHERE id = $1::uuid', [deletion[1]]);
      deleted.push(deletion[1]);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: deletion[1] }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reason: 'NotFound' }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reason: String(error?.message || error) }));
  }
});
await new Promise((resolve) => authorityServer.listen(0, '127.0.0.1', resolve));
const authorityOrigin = 'http://127.0.0.1:' + authorityServer.address().port;

const child = spawn(process.execPath, ['apps/console-api/src/server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    CONSOLE_DATABASE_URL: runtimeUrl,
    CONSOLE_PUBLIC_ORIGIN: publicOrigin,
    CONSOLE_SUPABASE_AUTH_URL: authorityOrigin,
    CONSOLE_SUPABASE_REST_URL: authorityOrigin,
    CONSOLE_SUPABASE_STORAGE_URL: authorityOrigin,
    CONSOLE_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    CONSOLE_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => { childOutput = (childOutput + chunk.toString('utf8')).slice(-4000); });
}

async function waitForReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error('Console API exited before readiness: ' + childOutput);
    try {
      const response = await fetch(origin + '/healthz');
      if (response.ok) return;
    } catch {
      // Bounded startup retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Console API readiness timed out: ' + childOutput);
}

function bootstrap(email) {
  const username = email.split('@')[0];
  return fetch(origin + '/api/identity/bootstrap', {
    method: 'POST',
    headers: { origin: publicOrigin, 'content-type': 'application/json', 'x-os-correlation-id': `bootstrap-${username}-0001` },
    body: JSON.stringify({
      username,
      displayName: `${username} administrator`,
      email,
      password: `initial-${username}-password`,
      passwordConfirm: `initial-${username}-password`,
    }),
  });
}

try {
  await waitForReady();
  const initialStatus = await fetch(origin + '/api/identity/bootstrap/status');
  assert.equal(initialStatus.status, 200);
  assert.deepEqual(await initialStatus.json(), { state: 'required' });

  const denied = await fetch(origin + '/api/identity/bootstrap', {
    method: 'POST',
    headers: { origin: 'https://attacker.example.test', 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'attacker', displayName: 'Attacker', email: 'third@example.test',
      password: 'attacker-password-value', passwordConfirm: 'attacker-password-value',
    }),
  });
  assert.equal(denied.status, 403);
  assert.equal(created.length, 0);

  const responses = await Promise.all([bootstrap('first@example.test'), bootstrap('second@example.test')]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const conflict = responses.find((response) => response.status === 409);
  assert.equal((await conflict.json()).code, 'BootstrapComplete');
  assert.equal(created.length, 2);
  assert.equal(deleted.length, 1);

  const evidence = await admin.query([
    'SELECT',
    '(SELECT count(*)::int FROM auth.users) AS auth_users,',
    '(SELECT count(*)::int FROM console_identity.subject_authority) AS authorities,',
    '(SELECT count(*)::int FROM console_identity.permission_grant) AS permissions,',
    '(SELECT count(*)::int FROM console_audit.event',
    "WHERE action = 'console.identity.bootstrap.initial_administrator') AS audit_events,",
    '(SELECT COALESCE(string_agg(evidence::text, \'\'), \'\') FROM console_audit.event',
    "WHERE action = 'console.identity.bootstrap.initial_administrator') AS audit_evidence,",
    '(SELECT subject_id::text FROM console_identity.subject_authority LIMIT 1) AS subject_id',
  ].join(' '));
  assert.deepEqual({
    authUsers: evidence.rows[0].auth_users,
    authorities: evidence.rows[0].authorities,
    permissions: evidence.rows[0].permissions,
    auditEvents: evidence.rows[0].audit_events,
  }, { authUsers: 1, authorities: 1, permissions: 8, auditEvents: 1 });
  assert.equal(created.includes(evidence.rows[0].subject_id), true);
  assert.equal(deleted.includes(evidence.rows[0].subject_id), false);
  assert.doesNotMatch(evidence.rows[0].audit_evidence, /example[.]test|password|service-role|preferred_username/i);

  const completedStatus = await fetch(origin + '/api/identity/bootstrap/status');
  assert.deepEqual(await completedStatus.json(), { state: 'complete' });
  const third = await bootstrap('third@example.test');
  assert.equal(third.status, 409);
  assert.equal(deleted.includes(subjects.get('third@example.test')), true);
  const finalCounts = await admin.query(
    'SELECT (SELECT count(*)::int FROM auth.users) AS auth_users, '
      + '(SELECT count(*)::int FROM console_identity.subject_authority) AS authorities, '
      + '(SELECT count(*)::int FROM console_identity.permission_grant) AS permissions',
  );
  assert.deepEqual(finalCounts.rows[0], { auth_users: 1, authorities: 1, permissions: 8 });

  process.stdout.write(JSON.stringify({
    status: 'passed',
    initialAdministratorSingleWinner: true,
    losingAuthUserCleaned: true,
    exactOriginDeniedBeforeAuthWrite: true,
    permissionCount: 8,
  }) + '\n');
} finally {
  await admin.end().catch(() => {});
  if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
  await new Promise((resolve) => authorityServer.close(resolve));
}
