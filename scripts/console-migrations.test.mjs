import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { migrationTransactionSql, renderMigration, verifyMigrationManifest } from './console-migrations.mjs';

const root = resolve(import.meta.dirname, '..');

test('fresh migration manifest binds the exact source revision and ordered SQL inventory', () => {
  const manifest = verifyMigrationManifest({ root });
  assert.equal(manifest.migrationCount, 10);
  assert.equal(manifest.latestGlobalId, 'opensphere-console/20260902/0010');
  assert.equal(manifest.migrations[0].sourceRevision, '8e4da5924ec54f09ad137ee67a8bf093342cbf0e');
  assert.equal(manifest.migrations[1].sourceRevision, 'e6f3f2dc54012a9d655e4ec292da182f6b9ae5dd');
  assert.equal(manifest.migrations[2].sourceRevision, 'd7c5d09ecdcfbeed01b32fd13a447c15b5692116');
  assert.equal(manifest.migrations[3].sourceRevision, 'be81b21351e7a4d2d89ce08f988eb1c115ae85c3');
  assert.equal(manifest.migrations[4].sourceRevision, '188d23ae76ebdddea467efd0b7e5926f0dcd20e2');
  assert.equal(manifest.migrations[5].sourceRevision, 'c74661efdcb9ebf31f8b997a70954704168d989d');
  assert.equal(manifest.migrations[6].sourceRevision, 'd94f8e039d3a11bb7cd014f37ae260078f802a91');
  assert.equal(manifest.migrations[7].sourceRevision, '8634da0f007e9e5b6e715e3fde921058f199d073');
  assert.equal(manifest.migrations[8].sourceRevision, 'b5b9815a6a0826bb7c356a63ba39d8f03f8a9940');
  assert.equal(manifest.migrations[9].sourceRevision, 'bd00f005de88e63cdae8573fa35b4e6e502c570a');
  const transaction = migrationTransactionSql(root, manifest.migrations[0]);
  assert.match(transaction, /CREATE SCHEMA console_migration;/);
  assert.match(transaction, /INSERT INTO console_migration\.applied_migration\(/);
  assert.match(transaction, /opensphere-console\/20260902\/0001/);
});

test('browser-session credential successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0002' });
  assert.match(sql, /ADD COLUMN access_token_ciphertext text/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]issue_browser_session/);
  assert.match(sql, /opensphere-console\/20260902\/0002/);
  assert.doesNotMatch(sql, /CREATE SCHEMA console_identity/);
});

test('browser-session MFA successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0003' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]get_pending_browser_session_mfa/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]activate_browser_session_mfa/);
  assert.match(sql, /opensphere-console\/20260902\/0003/);
  assert.doesNotMatch(sql, /CREATE TABLE console_identity[.]browser_session/);
});

test('browser-session refresh successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0004' });
  assert.match(sql, /ADD COLUMN access_token_expires_at/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]rotate_browser_session_credentials/);
  assert.match(sql, /opensphere-console\/20260902\/0004/);
});

test('browser-session activity successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0005' });
  assert.match(sql, /ADD COLUMN absolute_expires_at/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]touch_browser_session_activity/);
  assert.match(sql, /opensphere-console\/20260902\/0005/);
});

test('owned browser-session management successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0006' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]list_owned_browser_sessions/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]revoke_all_owned_browser_sessions/);
  assert.match(sql, /opensphere-console\/20260902\/0006/);
});

test('browser-session TOTP enrollment successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0007' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]get_browser_session_totp_enrollment_credentials/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]complete_browser_session_totp_enrollment/);
  assert.match(sql, /opensphere-console\/20260902\/0007/);
  assert.doesNotMatch(sql, /CREATE TABLE console_identity[.]browser_session/);
});

test('browser-session step-up successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0008' });
  assert.match(sql, /ADD COLUMN last_reauthenticated_at/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]complete_browser_session_step_up/);
});

test('recent AAL2 enforcement successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0009' });
  assert.match(sql, /interval '5 minutes'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]resolve_browser_session/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation[.]accept_operation/);
  assert.match(sql, /opensphere-console\/20260902\/0009/);
});

test('password recovery session revocation successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0010' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]revoke_browser_sessions_after_password_recovery/);
  assert.match(sql, /console[.]identity[.]password[.]recovery[.]sessions_revoked/);
  assert.match(sql, /opensphere-console\/20260902\/0010/);
});

test('migration renderer emits only a manifest-bound transaction body', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0001' });
  assert.match(sql, /CREATE SCHEMA console_migration;/);
  assert.match(sql, /INSERT INTO console_migration[.]applied_migration/);
  assert.match(sql, /opensphere-console\/20260902\/0001/);
  assert.doesNotMatch(sql, /^BEGIN;|^COMMIT;/m);
  assert.throws(
    () => renderMigration({ root, globalId: 'opensphere-console/20260902/9999' }),
    /absent from the verified manifest/,
  );
  assert.throws(() => renderMigration({ root, globalId: '../untrusted.sql' }), /globalId is invalid/);
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
