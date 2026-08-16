#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const runtimeInputPaths = Object.freeze([
  'backend/os-cli/Dockerfile.runtime',
]);

export const backendOverridePaths = Object.freeze([
  'backend/opensphere-console-backend/Dockerfile',
  'backend/opensphere-console-backend/local-edge-automation-token.test.js',
  'backend/opensphere-console-backend/os-shell-admission.js',
  'backend/opensphere-console-backend/os-shell-admission.test.js',
]);

export const consoleOverridePaths = Object.freeze([
  'nginx/default.conf.template',
  'public/os-shell-frame/index.html',
  'scripts/os-shell-frontend-contract.test.mjs',
  'src/app/app.config.ts',
  'src/app/system-plugins/os-shell/os-shell-launcher.ts',
  'src/app/system-plugins/os-shell/os-shell-page.scss',
  'src/app/system-plugins/os-shell/os-shell-page.ts',
  'src/app/system-plugins/os-shell/os-shell-terminal-surface.ts',
]);

export const controlOverridePaths = Object.freeze([
  'backend/os-shell-control/runtime-template.js',
  'backend/os-shell-control/runtime-template.test.js',
  'backend/os-shell-control/server.js',
  'backend/os-shell-control/server.test.js',
]);

export const canonicalConsoleOrigin = 'https://github.com/opensphere-platform/OpenSphere-console.git';

export const deploymentToolingPaths = Object.freeze([
  'backend/os-shell-control/deploy.test.js',
  'backend/os-shell-control/deploy.yaml',
  'scripts/Deploy-LocalEdgeOsShell.ps1',
  'scripts/Invoke-OsShellFeatureOperation.ps1',
  'scripts/Publish-LocalEdge.ps1',
  'scripts/Publish-LocalEdgeOsShell.ps1',
  'scripts/Publish-LocalEdgeOsShellConsole.ps1',
  'scripts/os-shell-component-publisher.test.mjs',
  'scripts/os-shell-console-publisher.test.mjs',
  'scripts/Test-OsShellEdgeSigning.ps1',
  'scripts/Test-OsShellRuntimeAdmission.ps1',
  'scripts/os-shell-edge-signing.ps1',
  'scripts/os-shell-runtime-override-boundary.mjs',
  'scripts/os-shell-runtime-override-boundary.test.mjs',
]);

export function isRuntimeInputPath(path) {
  return path.startsWith('backend/os-cli/cmd/os-shell-runtime/') || runtimeInputPaths.includes(path);
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
  const result = spawnSync('git', ['-C', repository, 'merge-base', '--is-ancestor', ancestor, descendant], { windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} is not a descendant of the base publication`);
}

function changedPaths(repository, from, to) {
  const output = execFileSync('git', ['-C', repository, 'diff', '--no-renames', '--name-only', '-z', from, to],
    { encoding: 'buffer', windowsHide: true });
  return output.length ? output.toString('utf8').split('\0').filter(Boolean) : [];
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
  backendRevision = null, consoleRevision = null, controlRevision = null, headRevision }) {
  const revisions = { baseRevision, headRevision };
  if (runtimeRevision) revisions.runtimeRevision = runtimeRevision;
  if (backendRevision) revisions.backendRevision = backendRevision;
  if (consoleRevision) revisions.consoleRevision = consoleRevision;
  if (controlRevision) revisions.controlRevision = controlRevision;
  for (const [name, revision] of Object.entries(revisions)) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`${name} is not an exact Git revision`);
  }
  requireCanonicalOrigin(repository);
  for (const [name, revision] of Object.entries(revisions)) requireCanonicalOriginRevision(repository, revision, name);
  requireAncestor(repository, baseRevision, headRevision, 'deployment HEAD');

  const evidenceChangedPaths = {};
  let runtimePaths = [];
  if (runtimeRevision) {
    requireAncestor(repository, baseRevision, runtimeRevision, 'runtime override');
    evidenceChangedPaths.runtime = changedPaths(repository, baseRevision, runtimeRevision);
    runtimePaths = evidenceChangedPaths.runtime.filter(isRuntimeInputPath);
    assertRuntimeOverridePaths(runtimePaths);
  }
  let backendPaths = [];
  if (backendRevision) {
    requireAncestor(repository, baseRevision, backendRevision, 'backend override');
    evidenceChangedPaths.backend = changedPaths(repository, baseRevision, backendRevision);
    backendPaths = evidenceChangedPaths.backend.filter((path) => backendOverridePaths.includes(path));
    assertBackendOverridePaths(backendPaths);
  }
  let consolePaths = [];
  if (consoleRevision) {
    requireAncestor(repository, baseRevision, consoleRevision, 'console override');
    evidenceChangedPaths.console = changedPaths(repository, baseRevision, consoleRevision);
    consolePaths = evidenceChangedPaths.console.filter((path) => consoleOverridePaths.includes(path));
    assertConsoleOverridePaths(consolePaths);
  }
  let controlPaths = [];
  if (controlRevision) {
    requireAncestor(repository, baseRevision, controlRevision, 'control override');
    evidenceChangedPaths.control = changedPaths(repository, baseRevision, controlRevision);
    controlPaths = evidenceChangedPaths.control.filter((path) => controlOverridePaths.includes(path));
    assertControlOverridePaths(controlPaths);
  }
  const componentPaths = [...runtimePaths, ...backendPaths, ...consolePaths, ...controlPaths];
  if (new Set(componentPaths).size !== componentPaths.length) throw new Error('component override path authorities overlap');
  const componentPathSet = new Set(componentPaths);
  for (const [authority, paths] of Object.entries(evidenceChangedPaths)) {
    for (const path of paths) assertCanonicalRepositoryPath(path);
    const rejected = paths.filter((path) => !componentPathSet.has(path) && !deploymentToolingPaths.includes(path));
    if (rejected.length) {
      throw new Error(`${authority} evidence changes source outside the composite component attribution: ${rejected.join(', ')}`);
    }
  }
  const authorityForPath = new Map([
    ...runtimePaths.map((path) => [path, runtimeRevision]),
    ...backendPaths.map((path) => [path, backendRevision]),
    ...consolePaths.map((path) => [path, consoleRevision]),
    ...controlPaths.map((path) => [path, controlRevision]),
  ]);
  for (const [authority, revision] of Object.entries({ runtime: runtimeRevision, backend: backendRevision,
    console: consoleRevision, control: controlRevision })) {
    if (!revision) continue;
    for (const path of evidenceChangedPaths[authority]) {
      if (deploymentToolingPaths.includes(path)) continue;
      const authoritativeRevision = authorityForPath.get(path);
      const evidenceBlob = git(repository, ['rev-parse', `${revision}:${path}`]);
      const authoritativeBlob = git(repository, ['rev-parse', `${authoritativeRevision}:${path}`]);
      if (evidenceBlob !== authoritativeBlob) {
        throw new Error(`${authority} evidence tampers with independently attributed component source: ${path}`);
      }
    }
  }
  const headPaths = changedPaths(repository, baseRevision, headRevision);
  assertHeadPaths(headPaths, componentPaths);
  const missingHeadPaths = componentPaths.filter((path) => !headPaths.includes(path));
  if (missingHeadPaths.length) throw new Error(`deployment HEAD is missing attributed component source: ${missingHeadPaths.join(', ')}`);
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
    baseRevision, runtimeRevision, backendRevision, consoleRevision, controlRevision, headRevision, upstream,
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
      runtimeRevision: optionalArgument('--runtime'), backendRevision: optionalArgument('--backend'),
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
