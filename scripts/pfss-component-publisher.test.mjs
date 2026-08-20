import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const publisher = readFileSync(resolve(root, 'scripts', 'Publish-LocalEdgeBackendComponent.ps1'), 'utf8');

test('PFSS publisher is a closed Backend and OAA Gateway two-image authority', () => {
  assert.match(publisher, /\$componentKeys = @\('backend', 'oaaGateway'\)/);
  assert.match(publisher, /opensphere-console-backend\/Dockerfile/);
  assert.match(publisher, /opensphere-console-oaa-gateway\/Dockerfile/);
  assert.match(publisher, /r2d2-durable-operation\.js/);
  assert.match(publisher, /r2d2-operation-api\.js/);
  assert.match(publisher, /opensphere-console-oaa-gateway\/server\.js/);
  assert.match(publisher, /changed-path closure affects a source outside the PFSS two-image authority/);
  assert.doesNotMatch(publisher, /Publish-LocalEdge\.ps1['"]\s*$/m);
  assert.doesNotMatch(publisher, /kubectl\s+(?:apply|patch|set|replace|delete)/i);
});

test('PFSS publisher requires canonical clean main, pinned Setup, immutable digests, and P-256 evidence', () => {
  for (const required of [
    'fetch --quiet origin main', 'branch --show-current', 'rev-parse origin/main',
    'worktree must be clean', 'setup-source.lock', 'Set-RemoteTag',
    'New-OsShellEdgeSignedDocument', 'signatureSha256', 'component-publication-binding/v1',
  ]) assert.match(publisher, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(publisher, /\$publisherPath = 'scripts\/Publish-LocalEdgeBackendComponent\.ps1'/);
  assert.match(publisher, /affectedImages=\$componentKeys/);
});
