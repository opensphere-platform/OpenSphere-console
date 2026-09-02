import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const decision = read('docs/WEB-SHELL-EDGE-MVP.md');
const descriptor = read('src/app/system-plugins/os-shell/os-shell.descriptor.ts');
const registry = read('src/app/core/system-plugin-registry.service.ts');
const composition = read('src/app/core/console-composition.manifest.ts');
const deployer = read('scripts/Deploy-LocalEdgeOsShell.ps1');
const controlSources = [
  'apps/os-shell-control/server.js',
  'apps/os-shell-control/runtime-template.js',
  'src/app/system-plugins/os-shell/os-shell-session.service.ts',
  'src/app/system-plugins/os-shell/os-shell-attach.service.ts',
].map(read).join('\n');

test('edge MVP is a Console-owned system plugin with a closed component scope', () => {
  assert.match(descriptor, /id:\s*'os-shell'/);
  assert.match(descriptor, /kind:\s*'systemPlugin'/);
  assert.match(descriptor, /owner:\s*'cbss-main-shell'/);
  assert.match(descriptor, /route:\s*'\/shell'/);
  assert.match(composition, /systemPlugins:\s*Object\.freeze\(\[OS_SHELL_SYSTEM_PLUGIN,/);
  assert.match(registry, /CONSOLE_COMPOSITION_MANIFEST/);
  assert.match(decision, /\*\*releaseScope\*\*: component/);
  assert.match(decision, /\*\*fullReleaseJustification\*\*: null/);
  assert.match(decision, /GitHub Actions never builds or moves the edge channel/);
});

test('edge MVP has exactly ten browser-path completion gates', () => {
  const ids = [...decision.matchAll(/\*\*EDGE-SHELL-(\d{2})\*\*/g)]
    .map((match) => match[1]);
  assert.deepEqual(ids, ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);
  assert.match(decision, /actual browser\/AAL2 path/);
  assert.match(decision, /cannot\s+replace browser-path evidence/);
});

test('Foundation, R2D2, and generic Platform Release are not runtime dependencies', () => {
  assert.doesNotMatch(controlSources, /foundation|r2d2|platform[- ]release/i);
  assert.doesNotMatch(deployer, /&[^\r\n]*Invoke-LocalEdgePlatformRelease|\/api\/platform\/releases/i);
  assert.match(decision, /Foundation PostgreSQL Owner publication/);
  assert.match(decision, /R2D2 operational runtime/);
  assert.match(decision, /Explicitly deferred/);
});

test('security controls remain in the focused completion boundary', () => {
  for (const required of [
    'AAL2', 'same-origin', 'one-time tickets', 'hostUsers:false',
    'network deny', 'process/core/swap', 'revocation', 'cleanup',
  ]) {
    assert.match(decision, new RegExp(required.replace(/[.*+?^$()|[\]\\]/g, '\\$&'), 'i'));
  }
});
