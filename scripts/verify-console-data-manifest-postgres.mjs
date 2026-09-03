import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Run after the fresh migration set, using the same manifest the installer applies.
const { Client } = createRequire(new URL('../apps/console-api/package.json', import.meta.url))('pg');
const url = process.env.CONSOLE_TEST_ADMIN_DATABASE_URL;
if (!url) throw new Error('CONSOLE_TEST_ADMIN_DATABASE_URL is required');
const manifest = await readFile(new URL('../backend/supabase/target/deploy.yaml', import.meta.url), 'utf8');
const declarations = [...manifest.matchAll(/name: PGRST_DB_SCHEMAS, value: "([^"]+)"/g)];
assert.equal(declarations.length, 1, 'one target PostgREST schema declaration');
const schemas = declarations[0][1].split(',');
assert.deepEqual(schemas, ['storage'], 'Console authority schemas remain behind C_API, outside PostgREST');
const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const { rows } = await client.query(
    'SELECT name, to_regnamespace(name) IS NOT NULL AS present FROM unnest($1::text[]) AS name',
    [schemas]
  );
  assert.ok(rows.every(row => row.present), 'every exposed PostgREST schema must exist after fresh migrations');
  const { rows: authority } = await client.query(
    "SELECT to_regclass('console_migration.applied_migration') IS NOT NULL AS fresh"
  );
  assert.equal(authority[0].fresh, true, 'fresh migration lineage must be installed');
  const { rows: legacy } = await client.query(
    "SELECT name FROM unnest(ARRAY['console','audit','osaa']) AS name WHERE to_regnamespace(name) IS NOT NULL"
  );
  assert.deepEqual(legacy, [], 'fresh installation must not recreate legacy schemas to satisfy REST');
  console.log(JSON.stringify({ status: 'passed', exposedSchemas: schemas, schemasExist: true, freshLineage: true, legacySchemasAbsent: true, committedMutations: false }));
} finally {
  try { await client.query('ROLLBACK'); } finally { await client.end(); }
}
