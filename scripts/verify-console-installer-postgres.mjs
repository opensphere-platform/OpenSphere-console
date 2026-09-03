import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

// Run only against an isolated test PostgreSQL as an administrator.
// The installer SQL is extracted verbatim; all role changes are rolled back.
const { Client } = createRequire(new URL('../apps/console-api/package.json', import.meta.url))('pg');
const url = process.env.CONSOLE_TEST_ADMIN_DATABASE_URL;
if (!url) throw new Error('Isolated CONSOLE_TEST_ADMIN_DATABASE_URL is required');
const source = await readFile(new URL('./Install-ConsoleApiRuntime.ps1', import.meta.url), 'utf8');
const blocks = [...source.matchAll(/^\$serviceRoleSql = @"\r?\n([\s\S]*?)^"@\r?$/gm)];
assert.equal(blocks.length, 1, 'exactly one production service-role SQL block');
const password = randomBytes(24).toString('hex') + "';--";
const sql = blocks[0][1].replaceAll('`$', '$').replaceAll('$escapedPostgresPassword', password.replaceAll("'", "''"));
assert.doesNotMatch(sql, /\$escapedPostgresPassword|`\$/);
const roles = ['authenticator', 'supabase_auth_admin', 'supabase_storage_admin'];
const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '10s'");
  for (const role of roles) {
    const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!found.rowCount) await client.query('CREATE ROLE ' + role + ' NOLOGIN');
  }
  const attributes = async () => (await client.query(
    'SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',
    [roles]
  )).rows;
  const before = await attributes();
  await client.query('SAVEPOINT bad_alias');
  await assert.rejects(client.query(sql.replaceAll('existing_role', 'current_role')), { code: '42601' });
  await client.query('ROLLBACK TO SAVEPOINT bad_alias');
  await client.query(sql);
  await client.query(sql);
  assert.deepEqual(await attributes(), before, 'service-role privilege attributes must not change');
  const configured = await client.query(
    'SELECT rolname,rolcanlogin,rolpassword IS NOT NULL AS password_set FROM pg_authid WHERE rolname=ANY($1::text[]) ORDER BY rolname',
    [roles]
  );
  assert.equal(configured.rowCount, 3);
  assert.ok(configured.rows.every(row => row.rolcanlogin && row.password_set));
  for (const role of roles) {
    await client.query('SAVEPOINT missing_role');
    await client.query('ALTER ROLE ' + role + ' RENAME TO installer_missing_' + randomBytes(8).toString('hex'));
    await assert.rejects(client.query(sql), error =>
      error.code === 'P0001' && error.message === 'required Supabase service role is absent');
    await client.query('ROLLBACK TO SAVEPOINT missing_role');
  }
  console.log(JSON.stringify({
    status: 'passed', productionSqlParsedAndExecuted: true,
    reservedAliasRegressionDetected: true, idempotentReplay: true,
    missingRoleRejections: roles.length, privilegeAttributesPreserved: true,
    passwordQuoteEscaping: true, committedMutations: false
  }));
} finally {
  try { await client.query('ROLLBACK'); } finally { await client.end(); }
}
