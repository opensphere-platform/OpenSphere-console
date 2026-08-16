import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

test('dedicated OS Shell Console publisher selects only the Console image', () => {
  const source = read('scripts/Publish-LocalEdgeOsShellConsole.ps1');
  assert.match(source, /Components = @\('console'\)/);
  assert.match(source, /affectedImages = @\(\$consoleRepository\)/);
  assert.match(source, /releaseScope = 'component'/);
  assert.match(source, /fullReleaseJustification = \$null/);
  assert.equal((source.match(/\bComponents =/g) ?? []).length, 1);
});

test('Console publisher closes source attribution and deployed prerequisite digests before mutation', () => {
  const source = read('scripts/Publish-LocalEdgeOsShellConsole.ps1');
  const publish = source.indexOf('& $publisher @publisherParameters');
  for (const gate of [
    'status --short',
    'fetch --quiet --prune origin',
    'OS Shell Console source boundary verification failed',
    'deployed Console publication',
    "Get-LiveDeploymentDigest -Deployment 'opensphere-console'",
    "Get-LiveDeploymentDigest -Deployment 'opensphere-console-backend'",
    "Get-LiveDeploymentDigest -Deployment $deployment",
    'Target source changes the deployed OS Shell migration lineage',
  ]) {
    const index = source.indexOf(gate);
    assert.ok(index >= 0 && index < publish, `${gate} must precede publication`);
  }
  assert.match(source, /--backend[\s\S]*--console[\s\S]*--control[\s\S]*--head/);
  assert.match(source, /opensphere-local-os-shell-console-publication[.]json/);
});

test('dedicated publisher alone advances and verifies the Console edge pointer', () => {
  const source = read('scripts/Publish-LocalEdgeOsShellConsole.ps1');
  const publication = source.indexOf("Read-Publication -Path $combinedPath");
  const advance = source.indexOf('imagetools create --tag "${consoleRepository}:edge"');
  const verify = source.indexOf("$consoleEdgeAfter -ne $publishedDigest");
  assert.ok(publication > 0 && advance > publication && verify > advance);
  assert.match(source, /edgePointerBefore = \$consoleEdgeBefore/);
  assert.match(source, /\['edgePointerAfter'\] = \$consoleEdgeAfter/);
  assert.doesNotMatch(source, /backendRepository}:edge|controlRepository}:edge/);
});

test('Console component paths stay separate from privileged deployment tooling', () => {
  const boundary = read('scripts/os-shell-runtime-override-boundary.mjs');
  for (const relative of [
    'nginx/default.conf.template',
    'public/os-shell-frame/index.html',
    'src/app/app.config.ts',
    'src/app/system-plugins/os-shell/os-shell-launcher.ts',
    'src/app/system-plugins/os-shell/os-shell-page.scss',
    'src/app/system-plugins/os-shell/os-shell-page.ts',
    'src/app/system-plugins/os-shell/os-shell-terminal-surface.ts',
  ]) assert.match(boundary, new RegExp(relative.replaceAll('.', '[.]').replaceAll('/', '\\/')));
  assert.match(boundary, /deploymentToolingPaths[\s\S]*scripts\/Publish-LocalEdgeOsShellConsole[.]ps1/);
  assert.match(boundary, /deploymentToolingPaths[\s\S]*scripts\/os-shell-console-publisher[.]test[.]mjs/);
});
