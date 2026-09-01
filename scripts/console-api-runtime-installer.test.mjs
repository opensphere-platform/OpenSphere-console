import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Install-ConsoleApiRuntime.ps1', import.meta.url), 'utf8');

test('C_API runtime installer is a one-role one-secret fresh-lineage boundary', () => {
  assert.match(source, /\[Parameter\(Mandatory = \$true\)\][\s\S]*\[string\]\$ConsoleApiImage/);
  assert.match(source, /opensphere-console-api@sha256:\[a-f0-9\]\{64\}/);
  assert.match(source, /migrations\\manifest[.]json/);
  assert.match(source, /migrationCount -ne 1/);
  assert.match(source, /requires the exact fresh migration prefix/);
  assert.match(source, /\$roleName = 'opensphere_console_api_runtime'/);
  assert.match(source, /CREATE ROLE \$roleName LOGIN PASSWORD/);
  assert.match(source, /NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20/);
  assert.match(source, /\$authorityRole = 'console_api'/);
  assert.match(source, /GRANT \$authorityRole TO \$roleName/);
  assert.match(source, /\$secretName = 'opensphere-console-api-runtime'/);
  assert.match(source, /\$secretKey = 'database-url'/);
  assert.match(source, /'opensphere[.]io\/secret-scope' = 'console-api-only'/);
  assert.doesNotMatch(source, /service-role-key|jwt-secret|postgres-password[^\n]*stringData/);
  assert.doesNotMatch(source, /kind\s*=\s*'?(?:Deployment|StatefulSet|Role|ClusterRole)'?/);
});

test('C_API runtime installer refuses implicit repair and keeps credentials off argv', () => {
  assert.match(source, /split provisioning state; no implicit repair or rotation was attempted/);
  assert.match(source, /IFS= read -r PGPASSWORD/);
  assert.match(source, /Credentials are sent|create', '-f', '-'/);
  assert.doesNotMatch(source, /kubectl[^\n]*(?:databaseUrl|runtimePassword)/i);
  assert.match(source, /delete', 'secret', \$secretName, '--wait=true'/);
  assert.match(source, /DROP ROLE IF EXISTS \$roleName/);
});

test('C_API runtime installer reuses the verified runner and mutates only after target preflight', () => {
  for (const artifact of [
    'opensphere-console-supabase-postgres',
    'opensphere-console-supabase-auth',
    'opensphere-console-supabase-rest',
    'opensphere-console-supabase-storage',
  ]) assert.match(source, new RegExp(artifact));
  assert.match(source, /console-migrations[.]mjs/);
  assert.match(source, /render \(\[string\]\$migrationManifest[.]latestGlobalId\)/);
  assert.match(source, /--single-transaction/);
  assert.match(source, /deployment\/opensphere-console-api/);
  assert.match(source, /Installed C_API image differs from the requested exact digest/);
  assert.doesNotMatch(source, /backend\\supabase\\install[.]ps1|backend\\supabase\\migrations/);
  assert.doesNotMatch(source, /create', 'namespace|kind\s*=\s*'Namespace'/);

  const preflight = source.indexOf('$dataWorkloads = @(');
  const migration = source.indexOf('Invoke-OwnerMigrationSql $migrationSql');
  const role = source.indexOf('Invoke-OwnerSql $createRoleSql');
  const deployment = source.indexOf("Invoke-Kubectl @('apply', '-f', '-') $renderedDeployment");
  assert.ok(preflight >= 0 && migration > preflight && role > migration && deployment > role);
});
