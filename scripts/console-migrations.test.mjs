import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { migrationTransactionSql, verifyMigrationManifest } from './console-migrations.mjs';

const root = resolve(import.meta.dirname, '..');

test('fresh migration manifest binds the exact source revision and ordered SQL inventory', () => {
  const manifest = verifyMigrationManifest({ root });
  assert.equal(manifest.migrationCount, 1);
  assert.equal(manifest.latestGlobalId, 'opensphere-console/20260902/0001');
  assert.equal(manifest.migrations[0].sourceRevision, '8e4da5924ec54f09ad137ee67a8bf093342cbf0e');
  const transaction = migrationTransactionSql(root, manifest.migrations[0]);
  assert.match(transaction, /CREATE SCHEMA console_migration;/);
  assert.match(transaction, /INSERT INTO console_migration\.applied_migration\(/);
  assert.match(transaction, /opensphere-console\/20260902\/0001/);
});

test('migration verification rejects SQL content drift before database access', (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'opensphere-console-migration-test-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  cpSync(join(root, 'migrations'), join(temporaryRoot, 'migrations'), { recursive: true });
  const migration = join(temporaryRoot, 'migrations', 'baseline', '0001_console_authority.sql');
  writeFileSync(migration, readFileSync(migration, 'utf8') + '\nSELECT 1;\n');
  assert.throws(() => verifyMigrationManifest({ root: temporaryRoot, manifestPath: join(temporaryRoot, 'migrations', 'manifest.json'), verifySourceRevision: false }), /file digest mismatch/);
});

test('migration verification rejects predecessor and set lineage substitution', (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'opensphere-console-migration-test-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  cpSync(join(root, 'migrations'), join(temporaryRoot, 'migrations'), { recursive: true });
  const manifestPath = join(temporaryRoot, 'migrations', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.migrations[0].predecessorGlobalId = 'opensphere-console/20260901/9999';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  assert.throws(() => verifyMigrationManifest({ root: temporaryRoot, manifestPath, verifySourceRevision: false }), /predecessor is not the prior globalId/);
});
