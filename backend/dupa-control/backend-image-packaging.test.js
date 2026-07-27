'use strict';

/**
 * Packaging contract for the Console backend image.
 *
 * A module that `server.js` requires but the Dockerfile never COPYs produces a
 * MODULE_NOT_FOUND crash loop that no unit test can see, because the source
 * tree on a developer machine always has the file. This test walks the real
 * require() graph from the entrypoint and asserts every local file it reaches
 * is packaged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const backendRoot = path.join(repoRoot, 'backend');
const entrypoint = path.join(backendRoot, 'opensphere-console-backend/server.js');
const dockerfilePath = path.join(backendRoot, 'opensphere-console-backend/Dockerfile');
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

/** Local (relative) requires reachable from the entrypoint, as repo-relative paths. */
function localRequireGraph(startFile) {
  const seen = new Set();
  const queue = [startFile];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      let resolved = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
      assert.ok(fs.existsSync(resolved), `${path.relative(repoRoot, file)} requires missing ${match[1]}`);
      queue.push(resolved);
    }
  }
  return [...seen].map((file) => path.relative(backendRoot, file).split(path.sep).join('/'));
}

/** Paths the Dockerfile copies into the image, as build-context-relative paths. */
function copiedPaths() {
  const copied = new Set();
  // Line continuations first, so multi-line COPY directives are seen whole.
  const flattened = dockerfile.replace(/\\\r?\n\s*/g, ' ');
  for (const line of flattened.split('\n')) {
    const match = /^\s*COPY\s+(?!--from)(.+)$/.exec(line);
    if (!match) continue;
    const parts = match[1].trim().split(/\s+/).filter((part) => !part.startsWith('--'));
    if (parts.length < 2) continue;
    for (const source of parts.slice(0, -1)) copied.add(source);
  }
  return copied;
}

const required = localRequireGraph(entrypoint);
const copied = copiedPaths();

test('every module the backend requires at runtime is copied into the image', () => {
  const missing = required.filter((rel) => !copied.has(rel));
  assert.deepEqual(
    missing,
    [],
    `these modules are required by server.js but never COPYd into the backend image:\n  ${missing.join('\n  ')}`,
  );
});

test('the require graph actually reaches the Stage 1 host modules', () => {
  // Guards the guard: if the graph walker silently returned nothing, the test
  // above would pass vacuously.
  for (const expected of [
    'opensphere-console-backend/server.js',
    'opensphere-console-backend/agent-signature.js',
    'opensphere-console-backend/host-api.js',
    'opensphere-console-backend/beszel-metrics-api.js',
    'opensphere-console-backend/bbss-status.js',
    'opensphere-console-backend/manual-api.js',
    'opensphere-console-backend/kubernetes-read-proxy.js',
  ]) {
    assert.ok(required.includes(expected), `${expected} should be reachable from server.js`);
  }
  assert.ok(required.length >= 8, `require graph looks too small: ${required.length} files`);
});

test('the manual seed consumed at runtime is packaged', () => {
  const seedRelative = 'opensphere-console-oaa-gateway/manual-seeds/opensphere-core-manuals.json';
  assert.ok(fs.existsSync(path.join(backendRoot, seedRelative)), 'manual seed must exist in the build context');
  assert.ok(
    [...copied].some((entry) => entry.includes('manual-seeds/opensphere-core-manuals.json')),
    'the manual seed must be COPYd or /api/manual returns 503 in the image',
  );
});

test('the image entrypoint points at a packaged file', () => {
  const cmd = /CMD\s+\[([^\]]+)\]/.exec(dockerfile);
  assert.ok(cmd, 'Dockerfile must declare a CMD');
  const target = cmd[1].split(',').map((part) => part.trim().replace(/^"|"$/g, '')).at(-1);
  assert.equal(target, '/app/opensphere-console-backend/server.js');
  assert.ok(copied.has('opensphere-console-backend/server.js'), 'the entrypoint itself must be copied');
});

test('no node_modules dependency is introduced into the backend runtime', () => {
  // The image ships no package.json and deletes npm, so a bare require would
  // only fail once deployed.
  const bare = new Set();
  for (const rel of required) {
    const source = fs.readFileSync(path.join(backendRoot, rel), 'utf8');
    for (const match of source.matchAll(/require\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g)) {
      const name = match[1];
      if (name.startsWith('node:')) continue;
      if (['fs', 'path', 'crypto', 'http', 'https', 'url', 'zlib', 'events', 'stream', 'util', 'os', 'net', 'tls', 'buffer', 'timers', 'child_process', 'worker_threads'].includes(name)) continue;
      bare.add(`${rel} -> ${name}`);
    }
  }
  assert.deepEqual([...bare], [], 'backend runtime must depend only on Node built-ins');
});
