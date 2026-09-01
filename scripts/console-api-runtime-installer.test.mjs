import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Install-ConsoleApiRuntime.ps1', import.meta.url), 'utf8');

test('C_API runtime installer is a one-role one-secret fresh-lineage boundary', () => {
  assert.match(source, /migrations\\manifest[.]json/);
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
