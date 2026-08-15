#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const runtimeInputPaths = Object.freeze([
  'backend/os-cli/Dockerfile.runtime',
]);

export const deploymentToolingPaths = Object.freeze([
  'backend/os-shell-control/deploy.test.js',
  'backend/os-shell-control/deploy.yaml',
  'scripts/Deploy-LocalEdgeOsShell.ps1',
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

export function assertHeadPaths(headPaths, runtimePaths) {
  const runtimeSet = new Set(runtimePaths);
  const rejected = headPaths.filter((path) => !runtimeSet.has(path) && !deploymentToolingPaths.includes(path));
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
  const output = git(repository, ['diff', '--name-only', from, to]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

export function verifyRepositoryBoundary({ repository, baseRevision, runtimeRevision, headRevision }) {
  for (const [name, revision] of Object.entries({ baseRevision, runtimeRevision, headRevision })) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`${name} is not an exact Git revision`);
  }
  requireAncestor(repository, baseRevision, runtimeRevision, 'runtime override');
  requireAncestor(repository, baseRevision, headRevision, 'deployment HEAD');
  const runtimePaths = changedPaths(repository, baseRevision, runtimeRevision);
  assertRuntimeOverridePaths(runtimePaths);
  const headPaths = changedPaths(repository, baseRevision, headRevision);
  assertHeadPaths(headPaths, runtimePaths);
  for (const path of runtimePaths) {
    const runtimeBlob = git(repository, ['rev-parse', `${runtimeRevision}:${path}`]);
    const headBlob = git(repository, ['rev-parse', `${headRevision}:${path}`]);
    if (runtimeBlob !== headBlob) throw new Error(`deployment HEAD runtime input differs from override evidence: ${path}`);
  }
  const upstream = git(repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstreamRevision = git(repository, ['rev-parse', upstream]);
  if (headRevision !== upstreamRevision) throw new Error(`deployment HEAD is not the exact pushed upstream revision ${upstream}`);
  return {
    baseRevision, runtimeRevision, headRevision, upstream,
    runtimePaths, toolingPaths: headPaths.filter((path) => deploymentToolingPaths.includes(path)),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = verifyRepositoryBoundary({
      repository: argument('--repository'), baseRevision: argument('--base'),
      runtimeRevision: argument('--runtime'), headRevision: argument('--head'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
