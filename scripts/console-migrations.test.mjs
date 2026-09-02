import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { migrationTransactionSql, renderMigration, verifyMigrationManifest } from './console-migrations.mjs';

const root = resolve(import.meta.dirname, '..');

test('fresh migration manifest binds the exact source revision and ordered SQL inventory', () => {
  const manifest = verifyMigrationManifest({ root });
  assert.equal(manifest.migrationCount, 26);
  assert.equal(manifest.latestGlobalId, 'opensphere-console/20260902/0026');
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
  assert.equal(manifest.migrations[10].sourceRevision, '45bec92bc352c3f0d16fdb5abf01cdaa680db139');
  assert.equal(manifest.migrations[11].sourceRevision, '450fd9305b60572bcce8fcaa19b82479cc293b77');
  assert.equal(manifest.migrations[12].sourceRevision, 'a63368d2765f96840a17028383dd2d666e5ba6f4');
  assert.equal(manifest.migrations[13].sourceRevision, '806b675c3d9e3e107d69d0670645dbf3008c4c57');
  assert.equal(manifest.migrations[14].sourceRevision, 'd29c46e715a1e890b97bfc008fda96e27f2e9bc8');
  assert.equal(manifest.migrations[15].sourceRevision, 'b4fd3db7d00d37506129cd15e9b4c3d026b6a0cc');
  assert.equal(manifest.migrations[16].sourceRevision, '75d6bd2b1a5fe514390ef68f9a105d21aacdff4b');
  assert.equal(manifest.migrations[17].sourceRevision, 'e9d6354b826c9a60ab4d9e30327e08485c4fdac3');
  assert.equal(manifest.migrations[18].sourceRevision, 'adf1af947ee0b0a8882c08e6c197022ae2b426a9');
  assert.equal(manifest.migrations[19].sourceRevision, '4f84bd0b5ef5324d2cb8e6f55bd9ab7a814243f2');
  assert.equal(manifest.migrations[20].sourceRevision, '5968b497331baada94508442192411207bb8296e');
  assert.equal(manifest.migrations[21].sourceRevision, 'ecba08066cd93807f9127fd8f1d6b87cd5764a6c');
  assert.equal(manifest.migrations[22].sourceRevision, 'ad1961615479df63490da5dcc5dba1c65458e196');
  assert.equal(manifest.migrations[23].sourceRevision, 'cfb17795b63d8403125a056ea21ecf28b2d44b21');
  assert.equal(manifest.migrations[24].sourceRevision, '8b77dcbd22bd7770513f6bb96224135c0fd70554');
  assert.equal(manifest.migrations[25].sourceRevision, '5a7b599c936cd4329544a33f8ac2313fc35ee322');
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

test('initial administrator bootstrap successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0011' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]get_initial_administrator_bootstrap_status/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]claim_initial_administrator/);
  assert.match(sql, /opensphere-console\/20260902\/0011/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});

test('browser-session preference successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0012' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]get_browser_session_preference_credentials/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]prepare_browser_session_preference_update/);
  assert.match(sql, /opensphere-console\/20260902\/0012/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});

test('owned browser-session event successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0013' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]list_owned_browser_session_events/);
  assert.match(sql, /opensphere-console\/20260902\/0013/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});

test('owned password recovery-link successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0014' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]prepare_owned_password_recovery_link/);
  assert.match(sql, /opensphere-console\/20260902\/0014/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});

test('owned profile-avatar successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0015' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]prepare_owned_profile_avatar_access/);
  assert.match(sql, /console-uploads/);
  assert.match(sql, /opensphere-console\/20260902\/0015/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});

test('managed identity role successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0016' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]list_managed_identities/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]change_managed_identity_role/);
  assert.match(sql, /opensphere-console\/20260902\/0016/);
});

test('managed identity lifecycle successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0017' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]prepare_managed_identity_lifecycle/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]complete_managed_identity_lifecycle/);
  assert.match(sql, /opensphere-console\/20260902\/0017/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});

test('interactive CLI identity successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0018' });
  assert.match(sql, /CREATE TABLE console_identity[.]cli_device/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]approve_cli_device_enrollment/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]resolve_cli_session/);
  assert.match(sql, /opensphere-console\/20260902\/0018/);
  assert.doesNotMatch(sql, /api_token|automation_token/);
});

test('CLI bearer device management successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0019' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]list_owned_cli_devices_with_cli_session/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]revoke_owned_cli_device_with_cli_session/);
  assert.match(sql, /opensphere-console\/20260902\/0019/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});
test('Supabase CLI RLS status successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0020' });
  assert.match(sql, /v_authority_table_count = 15/);
  assert.match(sql, /opensphere-console\/20260902\/0020/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});
test('platform Git change permission successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0021' });
  assert.match(sql, /console[.]git[.]change/);
  assert.match(sql, /opensphere-console\/20260902\/0021/);
});
test('Gitea merge receipt successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0022' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation[.]record_gitea_merge/);
  assert.match(sql, /opensphere-console\/20260902\/0022/);
});
test('Gitea proposal receipt successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0023' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation[.]record_gitea_proposal/);
  assert.match(sql, /opensphere-console\/20260902\/0023/);
});
test('Gitea change inventory successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0024' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_operation[.]list_gitea_changes/);
  assert.match(sql, /opensphere-console\/20260902\/0024/);
});
test('Owner access credential successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0025' });
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]prepare_owner_access_credential/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_identity[.]resolve_owner_access_authority/);
  assert.match(sql, /opensphere-console\/20260902\/0025/);
  assert.doesNotMatch(sql, /CREATE TABLE/);
});
test('Extension management projection successor is independently renderable', () => {
  const sql = renderMigration({ root, globalId: 'opensphere-console/20260902/0026' });
  assert.match(sql, /CREATE TABLE console_extension[.]presentation_preference/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_extension[.]write_presentation_preferences/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION console_extension[.]record_management_event/);
  assert.match(sql, /opensphere-console\/20260902\/0026/);
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

test('materialized release rendering keeps byte and lineage verification without requiring Git history', (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'opensphere-console-materialized-test-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  cpSync(join(root, 'migrations'), join(temporaryRoot, 'migrations'), { recursive: true });
  const sql = renderMigration({
    root: temporaryRoot,
    manifestPath: join(temporaryRoot, 'migrations', 'manifest.json'),
    globalId: 'opensphere-console/20260902/0001',
    verifySourceRevision: false,
  });
  assert.match(sql, /CREATE SCHEMA console_migration/);
  const migration = join(temporaryRoot, 'migrations', 'baseline', '0001_console_authority.sql');
  writeFileSync(migration, readFileSync(migration, 'utf8') + '\nSELECT 1;\n');
  assert.throws(() => renderMigration({
    root: temporaryRoot,
    manifestPath: join(temporaryRoot, 'migrations', 'manifest.json'),
    globalId: 'opensphere-console/20260902/0001',
    verifySourceRevision: false,
  }), /file digest mismatch/);
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
