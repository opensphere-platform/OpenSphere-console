import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptFile, encryptFile } from './entrypoint.mjs';

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
