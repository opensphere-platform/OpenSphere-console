import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptFile, encryptFile, safeManifestKey, drillEvidence } from './entrypoint.mjs';

test('empty or failed restore checks never write Verified owner evidence', () => {
  const previous=process.env.RECOVERY_OPERATION_ID;
  process.env.RECOVERY_OPERATION_ID='11111111-1111-4111-8111-111111111111';
  try {
    assert.equal(drillEvidence('supabase',[] )({}).restore.supabase.state,'AttentionRequired');
    assert.equal(drillEvidence('supabase',[{assertion:'a',verdict:'Failed'}])({}).restore.supabase.state,'AttentionRequired');
    assert.equal(drillEvidence('supabase',[{assertion:'a',verdict:'Verified'}])({}).restore.supabase.state,'Verified');
  } finally { if(previous===undefined)delete process.env.RECOVERY_OPERATION_ID;else process.env.RECOVERY_OPERATION_ID=previous; }
});

test('recovery archive encryption is authenticated and rejects ciphertext tampering', async () => {
  const previous = process.env.RECOVERY_ENCRYPTION_KEY;
  process.env.RECOVERY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
  const root = await mkdtemp(join(tmpdir(), 'opensphere-recovery-test-'));
  try {
    const input = join(root, 'input.bin');
    const encrypted = join(root, 'input.bin.enc');
    const restored = join(root, 'restored.bin');
    await writeFile(input, Buffer.from('OpenSphere recovery archive assertion\u0000bytes'));
    const descriptor = await encryptFile(input, encrypted);
    await decryptFile(encrypted, restored, descriptor.cipher);
    assert.deepEqual(await readFile(restored), await readFile(input));
    const altered = await readFile(encrypted);
    altered[0] ^= 0xff;
    await writeFile(encrypted, altered);
    await assert.rejects(() => decryptFile(encrypted, join(root, 'tampered.bin'), descriptor.cipher));
  } finally {
    if (previous === undefined) delete process.env.RECOVERY_ENCRYPTION_KEY;
    else process.env.RECOVERY_ENCRYPTION_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery drill accepts only an owner-staged relative manifest key', () => {
  assert.equal(safeManifestKey('opensphere-recovery/v1/run-1/supabase/manifest.json'),
    'opensphere-recovery/v1/run-1/supabase/manifest.json');
  assert.throws(() => safeManifestKey('https://example.test/archive/manifest.json'), /outside the owner-staged/);
  assert.throws(() => safeManifestKey('../private/manifest.json'), /outside the owner-staged/);
});
