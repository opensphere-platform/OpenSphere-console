import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(path.join(here, 'os-shell.ts'), 'utf8');

test('first-level subShell navigation preloads the Carbon icon library', () => {
  assert.match(
    shellSource,
    /constructor\(\)\s*\{[\s\S]*?void this\.iconLib\.ensure\(\);[\s\S]*?\}/,
    'selected non-curated Carbon icons must be ready without opening the admin icon picker first',
  );
});

test('first-level subShell navigation renders selected raw icons before fallback icons', () => {
  assert.match(shellSource, /@if \(pluginSvg\(item\); as svg\)[\s\S]*?<os-rawicon/);
  assert.match(shellSource, /const tok = this\.ext\.pluginIcons\(\)\[id\]/);
  assert.match(shellSource, /return this\.iconLib\.getSvg\(tok\)/);
});
