import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'Publish-LocalEdgeBackendBridge.ps1'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'apps', 'console-api', 'runtime', 'server.js'), 'utf8');
const featureOperation = fs.readFileSync(path.join(root, 'scripts', 'Invoke-OsShellFeatureOperation.ps1'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'backend', 'supabase', 'migrations',
  '0064_shell_feature_release_ledger_contract.sql'), 'utf8');

test('backend bridge publisher is component-only and emits governed evidence', () => {
  assert.match(source, /Publish the Console Backend component required by the current local-edge release control contracts/);
  assert.match(source, /affectedImages = @\(\$repository\)/);
  assert.match(source, /releaseScope = 'component'/);
  assert.match(source, /fullReleaseJustification = \$null/);
  assert.match(source, /components = \[ordered\]@\{\s*backend =/s);
  assert.doesNotMatch(source, /Publish-LocalEdge[.]ps1/);
  assert.doesNotMatch(source, /opensphere-console-(?:dupa-controller|osaa-gateway|recovery)/);
});

test('backend, release owner, and database use the append-only migration ledger contract', () => {
  assert.match(backend, /latestMigrationId \|\| ''\)\)/);
  assert.doesNotMatch(backend, /latestMigrationId !== '006[234]'/);
  assert.match(featureOperation, /latestMigrationId -notmatch '\^\\d\{4\}\$'/);
  assert.match(migration, /FROM console[.]schema_migration[\s\S]*ORDER BY migration_id DESC/);
  assert.match(migration, /latestMigrationId' IS DISTINCT FROM v_latest_migration_id/);
  assert.match(migration, /sourceRevision' IS DISTINCT FROM v_latest_source_revision/);
});

test('OS Shell enable delegates named deployment evidence without positional parameter drift', () => {
  assert.match(featureOperation, /\$arguments = @\{[\s\S]*PublicationEvidence = \$PublicationEvidence/);
  assert.match(featureOperation, /\$arguments[.]ConsolePublicationEvidence = \$ConsolePublicationEvidence/);
  assert.match(featureOperation, /Deploy-LocalEdgeOsShell[.]ps1'\) @arguments/);
  assert.doesNotMatch(featureOperation, /\$arguments = @\('-PublicationEvidence'/);
});

test('backend bridge publisher binds canonical main, setup lock and exact digest', () => {
  assert.match(source, /branch --show-current/);
  assert.match(source, /refs\/remotes\/origin\/main/);
  assert.match(source, /setup-source[.]lock/);
  assert.match(source, /SETUP_SOURCE_REVISION=\$setupRevision/);
  assert.match(source, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(source, /Set-RemoteTag -Repository \$repository -Digest \$digest -Tag \$releaseTag -Immutable/);
  assert.match(source, /Set-RemoteTag -Repository \$repository -Digest \$digest -Tag edge/);
});
