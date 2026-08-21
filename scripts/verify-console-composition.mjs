import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(repo, ...parts), 'utf8');

export function verifyConsoleCompositionSource() {
  const manifest = read('src', 'app', 'core', 'console-composition.manifest.ts');
  const registry = read('src', 'app', 'core', 'system-plugin-registry.service.ts');
  const routes = read('src', 'app', 'app.routes.ts');
  const r2d2Route = read('src', 'app', 'system-plugins', 'r2d2', 'r2d2.route.ts');

  assert.match(manifest, /MANUAL_CORE_SURFACE/);
  assert.match(manifest, /kind:\s*'coreSurface'/);
  assert.match(manifest, /route:\s*'\/manual'/);
  assert.match(manifest, /coreSurfaces:\s*Object\.freeze\(\[MANUAL_CORE_SURFACE\]\)/);
  assert.match(manifest, /systemPlugins:\s*Object\.freeze\(\[OS_SHELL_SYSTEM_PLUGIN, R2D2_SYSTEM_PLUGIN\]\)/);
  assert.match(manifest, /ConsoleCompositionCollision/);
  assert.match(registry, /validateConsoleComposition\(CONSOLE_COMPOSITION_MANIFEST\)/);
  assert.doesNotMatch(registry, /\[OS_SHELL_SYSTEM_PLUGIN, R2D2_SYSTEM_PLUGIN\]/);

  assert.match(routes, /R2D2_ADMIN_ROUTE/);
  assert.doesNotMatch(routes, /import\s*\{\s*AdminOsaa\s*\}/);
  assert.match(r2d2Route, /R2D2_SYSTEM_PLUGIN\.route/);
  assert.match(r2d2Route, /import\('\.\.\/\.\.\/pages\/admin-osaa'\)/);
  assert.match(r2d2Route, /catch\(\(error:\s*unknown\)\s*=>/);
  assert.match(r2d2Route, /return SystemPluginUnavailable/);

  const featureRoots = fs.readdirSync(path.join(repo, 'src', 'app', 'system-plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(featureRoots, ['os-shell', 'r2d2']);
  return { coreSurfaces: 1, systemPlugins: featureRoots.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = verifyConsoleCompositionSource();
  console.log(`Console composition verified: ${result.coreSurfaces} core surface, ${result.systemPlugins} system plugins.`);
}
