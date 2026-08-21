import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'Publish-LocalEdgeBackendBridge.ps1'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'backend', 'opensphere-console-backend', 'server.js'), 'utf8');
const featureOperation = fs.readFileSync(path.join(root, 'scripts', 'Invoke-OsShellFeatureOperation.ps1'), 'utf8');

test('backend bridge publisher is component-only and emits governed evidence', () => {
  assert.match(source, /Publish the Console Backend component required by the current local-edge release control contracts/);
  assert.match(source, /affectedImages = @\(\$repository\)/);
  assert.match(source, /releaseScope = 'component'/);
  assert.match(source, /fullReleaseJustification = \$null/);
  assert.match(source, /components = \[ordered\]@\{\s*backend =/s);
  assert.doesNotMatch(source, /Publish-LocalEdge[.]ps1/);
  assert.doesNotMatch(source, /opensphere-console-(?:dupa-controller|osaa-gateway|recovery)/);
});

test('backend and release owner enforce the current 0063 OS Shell feature contract', () => {
  assert.match(backend, /body[.]evidence[.]latestMigrationId !== '0063'/);
  assert.doesNotMatch(backend, /body[.]evidence[.]latestMigrationId !== '0062'/);
  assert.match(featureOperation, /profile[.]migration[.]latestMigrationId -ne '0063'/);
  assert.doesNotMatch(featureOperation, /active 0062 edge contract/);
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
