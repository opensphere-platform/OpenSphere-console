import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateCarbonIconAssets } from './generate-carbon-icon-assets.mjs';

test('Carbon navigation assets are emitted as isolated SVG files for every selectable token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opensphere-carbon-icons-'));
  const metadataPath = path.resolve('node_modules/@carbon/icons/metadata.json');
  const outputDirectory = path.join(root, 'carbon-icons');
  try {
    const result = await generateCarbonIconAssets({ metadataPath, outputDirectory });
    assert.ok(result.count >= 2500);
    const catalog = JSON.parse(await readFile(path.join(outputDirectory, 'catalog.json'), 'utf8'));
    assert.equal(catalog.version, 1);
    assert.equal(catalog.tokens.length, result.count);
    for (const token of [
      'web-services--cluster',
      'development',
      'ibm-z-os--ai-control-interface',
      'logo--gitlab',
      'accumulation--snow',
      'ai--observability',
    ]) {
      const svg = await readFile(path.join(outputDirectory, `${token}.svg`), 'utf8');
      assert.ok(catalog.tokens.includes(token));
      assert.match(svg, /^<svg\b/);
      assert.doesNotMatch(svg, /<(?:script|foreignObject)\b/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generator rejects an unsafe Carbon SVG before replacing the output directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opensphere-carbon-icons-negative-'));
  const metadataPath = path.join(root, 'metadata.json');
  const outputDirectory = path.join(root, 'carbon-icons');
  try {
    await writeFile(metadataPath, JSON.stringify({ icons: Array.from({ length: 2500 }, (_, index) => ({
      name: `safe-${index}`,
      assets: [{ size: 16, source: index === 2499 ? '<svg viewBox="0 0 16 16"><script/></svg>' : '<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>' }],
    })) }));
    await assert.rejects(() => generateCarbonIconAssets({ metadataPath, outputDirectory }), /unexpectedly small/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
