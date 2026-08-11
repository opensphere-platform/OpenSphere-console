import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('./admin-plugins.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../core/plugin-control-client.service.ts', import.meta.url), 'utf8');

test('Console exposes the official exact-digest Extension install contract', () => {
  assert.match(page, /<h2 id="oci-install-title">Extension 설치<\/h2>/);
  assert.match(page, /extensionImage\.value\.includes\('@sha256:'\)/);
  assert.match(page, /extensionInstallReason\.value\.trim\(\)\.length < 8/);
  assert.match(page, /installModule\(extensionImage\.value, extensionInstallReason\.value\)/);
  assert.match(client, /this\.http\.request\('\/api\/admin\/extensions\/install'/);
  assert.match(client, /client: 'cli:os' \| 'console:web' = 'console:web'/);
});
