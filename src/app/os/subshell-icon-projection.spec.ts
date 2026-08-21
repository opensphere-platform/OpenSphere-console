import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(path.join(here, 'os-shell.ts'), 'utf8');
const navNodeSource = readFileSync(path.join(here, 'os-nav-node.ts'), 'utf8');
const navIconSource = readFileSync(path.join(here, 'os-nav-icon.ts'), 'utf8');
const globalStyles = readFileSync(path.join(here, '..', '..', 'styles.scss'), 'utf8');

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

test('first-level navigation keeps a readable gap between the projected icon and menu label', () => {
  assert.match(globalStyles, /\.os-nav \.nav-link > os-nav-icon,/);
  assert.match(navIconSource, /@Input\(\) size = 15;/);
  assert.match(globalStyles, /flex: 0 0 15px !important; width: 15px !important; height: 15px !important; min-width: 15px !important;/);
  assert.match(globalStyles, /\.os-nav os-nav-icon os-cicon svg \{ width: 15px !important; height: 15px !important; \}/);
  assert.match(globalStyles, /margin-inline-end: 0\.65rem !important;/);
  assert.doesNotMatch(navIconSource, /:host-context\(\.os-nav\).*margin-inline-end/);
});
