import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateManifest } from './generate-manifest.mjs';

test('release manifest is hydrated from the exact compiled CLI artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opensphere-cli-manifest-'));
  try {
    const artifacts = join(dir, 'artifacts');
    await mkdir(artifacts);
    const bytes = Buffer.from('compiled-cli-artifact');
    await writeFile(join(artifacts, 'os-test'), bytes);
    const input = join(dir, 'index.json');
    const output = join(artifacts, 'index.json');
    await writeFile(input, JSON.stringify({ version: '0.4.0', links: [{ href: '/api/cli/os-test', size: 1, sha256: '0'.repeat(64) }] }));

    const manifest = await generateManifest(input, artifacts, output);
    assert.equal(manifest.links[0].size, bytes.byteLength);
    assert.equal(manifest.links[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Console and diagnostic CLI images compile the manifest version', async () => {
  const rootDockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const diagnosticDockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
  assert.match(rootDockerfile, /main\.version=0\.4\.0/g);
  assert.match(diagnosticDockerfile, /main\.version=0\.4\.0/g);
});

test('release manifest generation fails when a declared artifact is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opensphere-cli-manifest-'));
  try {
    const input = join(dir, 'index.json');
    await writeFile(input, JSON.stringify({ links: [{ href: '/api/cli/missing' }] }));
    await assert.rejects(() => generateManifest(input, dir, join(dir, 'output.json')), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
