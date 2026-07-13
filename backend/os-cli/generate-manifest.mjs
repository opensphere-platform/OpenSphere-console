import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

export async function generateManifest(manifestPath, artifactsDir, outputPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.links) || manifest.links.length === 0) {
    throw new Error('CLI manifest must declare at least one download link');
  }

  for (const link of manifest.links) {
    if (typeof link.href !== 'string' || !link.href.startsWith('/api/cli/')) {
      throw new Error(`invalid CLI artifact href: ${String(link.href)}`);
    }
    const filename = basename(link.href);
    const bytes = await readFile(resolve(artifactsDir, filename));
    link.size = bytes.byteLength;
    link.sha256 = createHash('sha256').update(bytes).digest('hex');
  }

  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , manifestPath, artifactsDir, outputPath] = process.argv;
  if (!manifestPath || !artifactsDir || !outputPath) {
    throw new Error('usage: generate-manifest.mjs <manifest> <artifacts-dir> <output>');
  }
  await generateManifest(resolve(manifestPath), resolve(artifactsDir), resolve(outputPath));
}
