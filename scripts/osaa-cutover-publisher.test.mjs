import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'Publish-LocalEdgeOsaaCutover.ps1'), 'utf8');

test('OSAA publisher has one exact six-component cutover profile', () => {
  for (const key of ['console','dupaController','osaaGateway','osaaGovernedAdapter','recovery','supabasePostgres']) {
    assert.match(source, new RegExp(`Key='${key}'`));
  }
  assert.equal((source.match(/\[ordered\]@\{ Key='/g) || []).length, 6);
  assert.doesNotMatch(source, /notificationDispatcher|supabaseAuth|supabaseRest|supabaseStorage|giteaPostgres/);
  assert.doesNotMatch(source, /Publish-LocalEdge[.]ps1/);
});

test('OSAA publisher requires the installed bridge and emits component evidence', () => {
  assert.match(source, /minimumBridgeRevision = '125922f96634572763c040924c8c4f3fe72af167'/);
  assert.match(source, /merge-base --is-ancestor \$minimumBridgeRevision \$bridgeRevision/);
  assert.match(source, /merge-base --is-ancestor \$bridgeRevision \$sourceRevision/);
  assert.match(source, /legacyGateway/);
  assert.match(source, /osaaGateway/);
  assert.match(source, /requestIntent='Publish only the six components required/);
  assert.match(source, /releaseScope='component'/);
  assert.match(source, /fullReleaseJustification=\$null/);
  assert.match(source, /unchangedComponentBuildCount=0/);
});
