import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

test('recovery executor is encrypted, operator-gated and writes only bounded evidence', () => {
  const image = read('Dockerfile');
  const executor = read('entrypoint.mjs');
  const manifest = read('recovery-jobs.yaml');
  assert.match(image, /postgres@sha256:[a-f0-9]{64}/);
  assert.match(image, /aws-cli/);
  assert.match(executor, /aes-256-gcm/);
  assert.match(executor, /ciphertextSha256/);
  assert.match(executor, /plaintextSha256/);
  assert.match(executor, /setAuthTag/);
  assert.match(executor, /assertQuiescedWriter/);
  assert.match(executor, /RECOVERY_QUIESCE_DEPLOYMENT is required/);
  assert.match(executor, /captureRoleNames/);
  assert.match(executor, /ensureRoles/);
  assert.match(executor, /opensphere-platform-recovery-evidence/);
  assert.match(executor, /No S3 credential, encryption key or archive content/);
  assert.equal((manifest.match(/suspend: true/g) ?? []).length, 2);
  assert.match(manifest, /resourceNames: \["opensphere-platform-recovery-evidence"\]/);
  assert.match(manifest, /opensphere-console-recovery/);
  assert.match(manifest, /opensphere-supabase-storage/);
  assert.match(manifest, /opensphere-gitea/);
  assert.match(manifest, /opensphere-platform-recovery-quiesce-reader/);
  assert.match(manifest, /__OPENSPHERE_RECOVERY_IMAGE__/);
  assert.doesNotMatch(manifest, /opensphere-cbs|opensphere-backbone|kanidm/i);
});

test('recovery source evidence begins fail-closed and never claims a completed drill', () => {
  const compatibility = read('opensphere-platform-recovery-evidence.yaml');
  assert.match(compatibility, /"schemaVersion": "v3"/);
  assert.match(compatibility, /"verified": false/);
  assert.match(compatibility, /"state": "AttentionRequired"/);
  assert.doesNotMatch(compatibility, /"state": "Verified"/);
});
