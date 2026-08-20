import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CARBON_ICON_TOKEN = /^[a-z0-9][a-z0-9-]{0,95}$/;

function cleanSvg(value, token) {
  const svg = String(value || '')
    .replace(/^<\?xml[^>]*>\s*/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/\s+id="icon"/g, '')
    .trim();
  if (!/^<svg\b/.test(svg) || !svg.endsWith('</svg>')) throw new Error(`invalid Carbon SVG source: ${token}`);
  if (/<(?:script|foreignObject|iframe|object|embed)\b/i.test(svg)
    || /\son[a-z]+\s*=/i.test(svg)
    || /(?:javascript:|data:text\/html)/i.test(svg)) {
    throw new Error(`unsafe Carbon SVG source: ${token}`);
  }
  return svg;
}

export async function generateCarbonIconAssets({ metadataPath, outputDirectory }) {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const icons = Array.isArray(metadata.icons) ? metadata.icons : [];
  const generated = new Map();
  for (const icon of icons) {
    const token = String(icon?.name || '');
    if (!CARBON_ICON_TOKEN.test(token)) continue;
    const asset = (Array.isArray(icon.assets) ? icon.assets : [])
      .filter((candidate) => candidate && candidate.source)
      .sort((left, right) => Number(left.size || 99) - Number(right.size || 99))[0];
    if (!asset) continue;
    try {
      generated.set(token, cleanSvg(asset.source, token));
    } catch {
      // A small number of upstream metadata assets contain XML DTD or Adobe
      // editor payloads. They are not selectable runtime assets; the picker
      // falls back when a token has no generated file.
    }
  }
  if (generated.size < 2500) throw new Error(`Carbon icon inventory unexpectedly small: ${generated.size}`);

  const resolvedOutput = path.resolve(outputDirectory);
  if (path.basename(resolvedOutput) !== 'carbon-icons') throw new Error('refusing to replace a non carbon-icons directory');
  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(resolvedOutput, { recursive: true });
  await Promise.all([...generated].map(([token, svg]) => writeFile(path.join(resolvedOutput, `${token}.svg`), svg, 'utf8')));
  await writeFile(path.join(resolvedOutput, 'catalog.json'), JSON.stringify({
    version: 1,
    tokens: [...generated.keys()].sort(),
  }), 'utf8');
  return { count: generated.size, outputDirectory: resolvedOutput };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const repositoryRoot = path.resolve(path.dirname(self), '..');
  const result = await generateCarbonIconAssets({
    metadataPath: path.join(repositoryRoot, 'node_modules', '@carbon', 'icons', 'metadata.json'),
    outputDirectory: path.join(repositoryRoot, 'public', 'assets', 'carbon-icons'),
  });
  process.stdout.write(`generated ${result.count} Carbon navigation icon assets\n`);
}
