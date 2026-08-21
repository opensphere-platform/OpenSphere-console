import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'Publish-LocalEdgeBackendBridge.ps1'), 'utf8');

test('backend bridge publisher is component-only and emits governed evidence', () => {
  assert.match(source, /Publish the Console Backend installed-lock bridge required for the one-way legacy agent identity to OSAA cutover/);
  assert.match(source, /affectedImages = @\(\$repository\)/);
  assert.match(source, /releaseScope = 'component'/);
  assert.match(source, /fullReleaseJustification = \$null/);
  assert.match(source, /components = \[ordered\]@\{\s*backend =/s);
  assert.doesNotMatch(source, /Publish-LocalEdge[.]ps1/);
  assert.doesNotMatch(source, /opensphere-console-(?:dupa-controller|osaa-gateway|recovery)/);
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
