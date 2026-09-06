import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Disposable real PostgreSQL, no port, no network, no persistent volume and no
// production credential. Exercise actual historical SQL, not a mocked ledger.
const name = 'os-shell-ledger-test-' + randomUUID();
const password = randomBytes(32).toString('hex');
const image = 'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const root = new URL('../', import.meta.url);
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, POSTGRES_PASSWORD: password }, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw Error(String(r.stderr || r.error).split(password).join('[REDACTED]'));
  return r.stdout;
}
const sql = input => docker(['exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '--single-transaction'], input);
const file = p => readFileSync(new URL(p, root), 'utf8');
let created = false;
try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--memory', '512m', '--env', 'POSTGRES_PASSWORD', '--env', 'PGDATA=/tmp/pg', '--tmpfs', '/tmp:rw,size=384m', image]);
  created = true;
  let ready = false;
  for (let i = 0; i < 80; i++) { try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; } catch { await delay(250); } }
  assert.ok(ready, 'isolated database readiness');
  sql('CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE authenticator NOLOGIN;');
  sql(file('migrations/baseline/verify/supabase-test-prerequisites.sql'));
  const manifest = JSON.parse(file('migrations/manifest.json'));
  // Session/CLI/Shell/installation-environment are the exact prerequisite owners.
  for (const m of manifest.migrations.filter(m => m.setSize <= 9 || [18, 29, 36, 43].includes(m.setSize))) {
    try { sql(file(m.path)); } catch (e) { throw Error(m.path + ': ' + e.message); }
  }
  sql(file('migrations/versions/verify/0044_shell_owner_command_namespace.before.sql'));
  sql(file('migrations/versions/0044_shell_owner_command_namespace.sql'));
  sql(file('migrations/versions/verify/0044_shell_owner_command_namespace.verify.sql'));
  console.log(JSON.stringify({ status: 'passed', isolatedPostgresql: true, historicalFailureReproduced: true,
    historicalReceiptsPreserved: true, nativeAndOwnerCommands: true, idempotentReplay: true,
    conflictingRetryDenied: true, staleSessionDenied: true, realAalAndMfaPreserved: true,
    ledgerDmlDenied: true, noLiveDatabaseTouched: true }));
} finally { if (created) docker(['rm', '-f', name]); }
