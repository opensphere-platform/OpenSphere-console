import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(path.join(here, 'os-shell.ts'), 'utf8');
const navNodeSource = readFileSync(path.join(here, 'os-nav-node.ts'), 'utf8');
const navIconSource = readFileSync(path.join(here, 'os-nav-icon.ts'), 'utf8');

test('first-level subShell navigation never preloads the full Carbon icon library', () => {
  assert.doesNotMatch(shellSource, /IconLibraryService|iconLib\.ensure\(\)/);
  assert.doesNotMatch(navIconSource, /IconLibraryService|metadata\.json/);
  assert.match(navIconSource, /assets\/carbon-icons/);
});

test('flat first-level navigation delegates selected and fallback icons to one projector', () => {
  assert.match(shellSource, /<os-nav-icon clrVerticalNavIcon \[token\]="iconTokenFor\(item\)" \[fallback\]="fallbackIconFor\(item\)"/);
  assert.match(shellSource, /return this\.pluginIconToken\(pluginIdFromRoute\(path\)\)/);
  assert.doesNotMatch(shellSource, /os-plugin-badge|>plugin<\/span>/);
});

test('contributed nav-tree roots receive the owning subShell selected icon', () => {
  assert.match(shellSource, /<os-nav-node \[node\]="tree\.node" \[iconToken\]="pluginIconToken\(tree\.ownerId\)"/);
  assert.match(shellSource, /ownerId: p\.id, node/);

  assert.match(navNodeSource, /@Input\(\) iconToken = ''/);
  assert.match(navNodeSource, /<os-nav-icon clrVerticalNavIcon \[token\]="iconToken"/);
});

test('the shared navigation icon projector owns curated, static asset and fallback resolution', () => {
  assert.match(navIconSource, /return iconByToken\(this\.currentToken\)/);
  assert.match(navIconSource, /CARBON_ICON_TOKEN\.test\(this\.currentToken\)/);
  assert.match(navIconSource, /this\.failedToken\.set\(this\.currentToken\)/);
});
