#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const runtimeInputPaths = Object.freeze([
  'apps/os-shell-control/Dockerfile.runtime',
  'cmd/os-cli/go.mod',
  'cmd/os-cli/go.sum',
  'cmd/os-cli/index.json',
  'cmd/os-cli/manifest.test.mjs',
]);

export const backendOverridePaths = Object.freeze([
  'apps/os-shell-control/authority/os-shell-admission.js',
  'apps/os-shell-control/authority/os-shell-admission.test.js',
  'apps/console-api/runtime/Dockerfile',
  'apps/console-api/runtime/local-edge-automation-token.test.js',
  'apps/console-api/runtime/server.js',
]);

export const consoleOverridePaths = Object.freeze([
  'apps/console-web/nginx/default.conf.template',
  'apps/console-web/public/os-shell-frame/index.html',
  'scripts/os-shell-frontend-contract.test.mjs',
  'apps/console-web/src/app/app.config.ts',
  'apps/console-web/src/app/core/system-plugin-registry.service.ts',
  'apps/console-web/src/app/pages/admin-plugins-state.spec.ts',
  'apps/console-web/src/app/pages/admin-plugins.ts',
  'apps/console-web/src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts',
  'apps/console-web/src/app/system-plugins/os-shell/os-shell-launcher.ts',
  'apps/console-web/src/app/system-plugins/os-shell/os-shell-page.scss',
  'apps/console-web/src/app/system-plugins/os-shell/os-shell-page.ts',
  'apps/console-web/src/app/system-plugins/os-shell/os-shell-terminal-surface.ts',
]);

export const controlOverridePaths = Object.freeze([
  'apps/os-shell-control/runtime-template.js',
  'apps/os-shell-control/runtime-template.test.js',
  'apps/os-shell-control/server.js',
  'apps/os-shell-control/server.test.js',
]);

export const canonicalConsoleOrigin = 'https://github.com/opensphere-platform/OpenSphere-console.git';

export const deploymentToolingPaths = Object.freeze([
  'apps/extension-controller/runtime/release-channel-workflow.test.js',
  'apps/os-shell-control/deploy.test.js',
  'apps/os-shell-control/deploy.yaml',
  'scripts/Deploy-LocalEdgeOsShell.ps1',
  'scripts/backend-bridge-publisher.test.mjs',
  'scripts/Invoke-LocalEdgePlatformRelease.ps1',
  'scripts/Invoke-OsShellFeatureOperation.ps1',
  'scripts/Publish-LocalEdge.ps1',
  'scripts/Publish-LocalEdgeConsole.ps1',
  'scripts/Publish-LocalEdgeOsShell.ps1',
  'scripts/Publish-LocalEdgeOsShellConsole.ps1',
  'scripts/os-shell-component-publisher.test.mjs',
  'scripts/os-shell-console-publisher.test.mjs',
  'scripts/Test-OsShellEdgeSigning.ps1',
  'scripts/Test-OsShellRuntimeAdmission.ps1',
  'scripts/os-shell-edge-signing.ps1',
  'scripts/os-shell-runtime-override-boundary.mjs',
  'scripts/os-shell-runtime-override-boundary.test.mjs',
  'apps/console-api/runtime/platform-release.test.js',
]);

export function isRuntimeInputPath(path) {
  return path.startsWith('apps/os-shell-control/runtime/')
    || runtimeInputPaths.includes(path);
}

export function assertRuntimeOverridePaths(paths) {
  if (!paths.length) throw new Error('runtime override has no changed runtime input');
  const rejected = paths.filter((path) => !isRuntimeInputPath(path));
  if (rejected.length) throw new Error(`runtime override changes non-runtime authority: ${rejected.join(', ')}`);
}

export function assertCanonicalRepositoryPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || /^[a-z]:/i.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`override path escapes the canonical repository: ${String(value)}`);
  }
}

export function assertBackendOverridePaths(paths) {
  for (const value of paths) assertCanonicalRepositoryPath(value);
  const actual = [...paths].sort();
  const expected = [...backendOverridePaths].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`backend override changed paths are not the exact closed set: ${actual.join(', ')}`);
  }
}

export function assertConsoleOverridePaths(paths) {
  for (const value of paths) assertCanonicalRepositoryPath(value);
  const actual = [...paths].sort();
  const expected = [...consoleOverridePaths].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`console override changed paths are not the exact closed set: ${actual.join(', ')}`);
  }
}

export function assertControlOverridePaths(paths) {
  for (const value of paths) assertCanonicalRepositoryPath(value);
  const actual = [...paths].sort();
  const expected = [...controlOverridePaths].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`control override changed paths are not the exact closed set: ${actual.join(', ')}`);
  }
}

export function assertHeadPaths(headPaths, componentPaths) {
  for (const value of headPaths) assertCanonicalRepositoryPath(value);
  const componentSet = new Set(componentPaths);
  const rejected = headPaths.filter((path) => !componentSet.has(path) && !deploymentToolingPaths.includes(path));
  if (rejected.length) throw new Error(`deployment HEAD changes unbound source: ${rejected.join(', ')}`);
}

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function requireAncestor(repository, ancestor, descendant, label) {
  if (!isAncestor(repository, ancestor, descendant)) {
    throw new Error(`${label} is not a descendant of the required source authority`);
  }
}

function isAncestor(repository, ancestor, descendant) {
  return spawnSync('git', ['-C', repository, 'merge-base', '--is-ancestor', ancestor, descendant], {
    windowsHide: true,
  }).status === 0;
}

function changedPaths(repository, from, to) {
  const output = execFileSync('git', ['-C', repository, 'diff', '--no-renames', '--name-only', '-z', from, to],
    { encoding: 'buffer', windowsHide: true });
  return output.length ? output.toString('utf8').split('\0').filter(Boolean) : [];
}

function runtimePathsAtRevision(repository, revision) {
  const output = execFileSync('git', ['-C', repository, 'ls-tree', '-r', '--name-only', '-z', revision, '--',
    'apps/os-shell-control/runtime', 'cmd/os-cli/cmd/os', ...runtimeInputPaths], { encoding: 'buffer', windowsHide: true });
  return output.length ? output.toString('utf8').split('\0').filter(Boolean).sort() : [];
}

function nearestHeadAncestor(repository, revisions, headRevision) {
  const candidates = [...new Set(revisions.filter(Boolean))].filter((revision) => isAncestor(repository, revision, headRevision));
  if (!candidates.length) throw new Error('deployment HEAD has no canonical component source ancestor');
  return candidates.sort((left, right) => {
    const leftDistance = Number(git(repository, ['rev-list', '--count', `${left}..${headRevision}`]));
    const rightDistance = Number(git(repository, ['rev-list', '--count', `${right}..${headRevision}`]));
    return leftDistance - rightDistance;
  })[0];
}

function requireCanonicalOrigin(repository) {
  const origin = git(repository, ['remote', 'get-url', 'origin']);
  if (origin !== canonicalConsoleOrigin) throw new Error(`origin is not the canonical GitHub Console repository: ${origin}`);
}

function requireCanonicalOriginRevision(repository, revision, label) {
  const refs = git(repository, ['for-each-ref', '--contains', revision, '--format=%(refname)', 'refs/remotes/origin']);
  if (!refs.split(/\r?\n/).some((value) => value.startsWith('refs/remotes/origin/'))) {
    throw new Error(`${label} is not reachable from a fetched canonical GitHub origin ref`);
  }
}

export function verifyCompositeRepositoryBoundary({ repository, baseRevision, runtimeRevision = null,
  platformRevision = null, backendRevision = null, consoleRevision = null, controlRevision = null, headRevision }) {
  if (platformRevision && (backendRevision || consoleRevision)) {
    throw new Error('platform bridge cannot be combined with legacy Backend or Console overrides');
  }
  const revisions = { baseRevision, headRevision };
  if (runtimeRevision) revisions.runtimeRevision = runtimeRevision;
  if (platformRevision) revisions.platformRevision = platformRevision;
  if (backendRevision) revisions.backendRevision = backendRevision;
  if (consoleRevision) revisions.consoleRevision = consoleRevision;
  if (controlRevision) revisions.controlRevision = controlRevision;
  for (const [name, revision] of Object.entries(revisions)) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`${name} is not an exact Git revision`);
  }
  requireCanonicalOrigin(repository);
  for (const [name, revision] of Object.entries(revisions)) requireCanonicalOriginRevision(repository, revision, name);
  const baseIsHeadAncestor = isAncestor(repository, baseRevision, headRevision);
  const headAnchorRevision = platformRevision || (baseIsHeadAncestor ? baseRevision : nearestHeadAncestor(repository,
    [runtimeRevision, backendRevision, consoleRevision, controlRevision], headRevision));
  requireAncestor(repository, headAnchorRevision, headRevision, 'deployment HEAD');

  const evidenceChangedPaths = {};
  const independentComponentAuthorities = [];
  let runtimePaths = [];
  if (runtimeRevision) {
    if (isAncestor(repository, baseRevision, runtimeRevision)) {
      evidenceChangedPaths.runtime = changedPaths(repository, baseRevision, runtimeRevision);
      runtimePaths = evidenceChangedPaths.runtime.filter(isRuntimeInputPath);
    } else {
      requireAncestor(repository, runtimeRevision, headRevision, 'runtime override');
      runtimePaths = runtimePathsAtRevision(repository, runtimeRevision);
      evidenceChangedPaths.runtime = [...runtimePaths];
      independentComponentAuthorities.push('runtime');
    }
    assertRuntimeOverridePaths(runtimePaths);
  }
  let backendPaths = [];
  if (backendRevision) {
    if (isAncestor(repository, baseRevision, backendRevision)) {
      evidenceChangedPaths.backend = changedPaths(repository, baseRevision, backendRevision);
      backendPaths = evidenceChangedPaths.backend.filter((path) => backendOverridePaths.includes(path));
    } else {
      requireAncestor(repository, backendRevision, headRevision, 'backend override');
      backendPaths = [...backendOverridePaths];
      evidenceChangedPaths.backend = [...backendPaths];
      independentComponentAuthorities.push('backend');
    }
    assertBackendOverridePaths(backendPaths);
  }
  let consolePaths = [];
  if (consoleRevision) {
    if (isAncestor(repository, baseRevision, consoleRevision)) {
      evidenceChangedPaths.console = changedPaths(repository, baseRevision, consoleRevision);
      consolePaths = evidenceChangedPaths.console.filter((path) => consoleOverridePaths.includes(path));
    } else {
      requireAncestor(repository, consoleRevision, headRevision, 'console override');
      consolePaths = [...consoleOverridePaths];
      evidenceChangedPaths.console = [...consolePaths];
      independentComponentAuthorities.push('console');
    }
    assertConsoleOverridePaths(consolePaths);
  }
  let controlPaths = [];
  if (controlRevision) {
    if (isAncestor(repository, baseRevision, controlRevision)) {
      evidenceChangedPaths.control = changedPaths(repository, baseRevision, controlRevision);
      controlPaths = evidenceChangedPaths.control.filter((path) => controlOverridePaths.includes(path));
    } else {
      requireAncestor(repository, controlRevision, headRevision, 'control override');
      controlPaths = [...controlOverridePaths];
      evidenceChangedPaths.control = [...controlPaths];
      independentComponentAuthorities.push('control');
    }
    assertControlOverridePaths(controlPaths);
  }
  const componentPaths = [...runtimePaths, ...backendPaths, ...consolePaths, ...controlPaths];
  if (new Set(componentPaths).size !== componentPaths.length) throw new Error('component override path authorities overlap');
  // A component publication owns only its closed build-input projection. A
  // monorepo source revision may contain unrelated reviewed changes, but they
  // are neither packaged by that component nor evidence for another one.
  for (const paths of Object.values(evidenceChangedPaths)) {
    for (const path of paths) assertCanonicalRepositoryPath(path);
  }
  const authorityForPath = new Map([
    ...runtimePaths.map((path) => [path, runtimeRevision]),
    ...backendPaths.map((path) => [path, backendRevision]),
    ...consolePaths.map((path) => [path, consoleRevision]),
    ...controlPaths.map((path) => [path, controlRevision]),
  ]);
  const headPaths = changedPaths(repository, headAnchorRevision, headRevision);
  assertHeadPaths(headPaths, componentPaths);
  for (const path of componentPaths) {
    const sourceRevision = authorityForPath.get(path);
    const sourceBlob = git(repository, ['rev-parse', `${sourceRevision}:${path}`]);
    const headBlob = git(repository, ['rev-parse', `${headRevision}:${path}`]);
    if (sourceBlob !== headBlob) throw new Error(`deployment HEAD component input differs from override evidence: ${path}`);
  }
  const upstream = git(repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstreamRevision = git(repository, ['rev-parse', upstream]);
  if (headRevision !== upstreamRevision) throw new Error(`deployment HEAD is not the exact pushed upstream revision ${upstream}`);
  return {
    baseRevision, runtimeRevision, platformRevision, backendRevision, consoleRevision, controlRevision, headRevision,
    headAnchorRevision, independentComponentAuthorities, upstream,
    runtimePaths, backendPaths, consolePaths, controlPaths,
    evidenceChangedPaths,
    toolingPaths: headPaths.filter((path) => deploymentToolingPaths.includes(path)),
    canonicalOrigin: canonicalConsoleOrigin,
  };
}

export function verifyRepositoryBoundary({ repository, baseRevision, runtimeRevision, headRevision }) {
  return verifyCompositeRepositoryBoundary({ repository, baseRevision, runtimeRevision, headRevision });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = verifyCompositeRepositoryBoundary({
      repository: argument('--repository'), baseRevision: argument('--base'),
      runtimeRevision: optionalArgument('--runtime'), platformRevision: optionalArgument('--platform'),
      backendRevision: optionalArgument('--backend'),
      consoleRevision: optionalArgument('--console'),
      controlRevision: optionalArgument('--control'),
      headRevision: argument('--head'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
