import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertBackendOverridePaths, assertCanonicalRepositoryPath, assertConsoleOverridePaths, assertControlOverridePaths,
  assertHeadPaths, assertRuntimeOverridePaths, backendOverridePaths, canonicalConsoleOrigin, consoleOverridePaths,
  controlOverridePaths, deploymentToolingPaths, verifyCompositeRepositoryBoundary,
} from './os-shell-runtime-override-boundary.mjs';

const validRuntime = [
  'backend/os-cli/cmd/os-shell-runtime/agent.go',
  'backend/os-cli/cmd/os-shell-runtime/runtime_directory.go',
  'backend/os-cli/Dockerfile.runtime',
  'backend/os-cli/manifest.test.mjs',
];

test('runtime override is closed over runtime source and its dedicated build overlay only', () => {
  assert.doesNotThrow(() => assertRuntimeOverridePaths(validRuntime));
  for (const path of [
    'backend/supabase/migrate-only.ps1',
    'backend/os-shell-control/deploy.yaml',
    'backend/os-cli/cmd/os/operator.go',
    'backend/os-cli/cmd/os/web_shell_agent.go',
    'backend/os-cli/go.mod',
  ]) {
    assert.throws(() => assertRuntimeOverridePaths([...validRuntime, path]), /non-runtime authority/);
  }
  assert.throws(() => assertRuntimeOverridePaths([]), /no changed runtime input/);
});

test('deployment HEAD is limited to exact runtime evidence plus closed deployment tooling', () => {
  assert.doesNotThrow(() => assertHeadPaths([...validRuntime, ...deploymentToolingPaths], validRuntime));
  assert.throws(
    () => assertHeadPaths([...validRuntime, 'backend/supabase/migrate-only.ps1'], validRuntime),
    /unbound source/,
  );
  assert.throws(
    () => assertHeadPaths([...validRuntime, 'backend/os-cli/cmd/os/operator.go'], validRuntime),
    /unbound source/,
  );
});

test('backend override accepts the shared admission source used by Backend and Control', () => {
  assert.doesNotThrow(() => assertBackendOverridePaths(backendOverridePaths));
  assert.throws(() => assertBackendOverridePaths([backendOverridePaths[0]]), /exact closed set/);
  assert.throws(() => assertBackendOverridePaths([...backendOverridePaths, 'backend/opensphere-console-backend/server.js']), /exact closed set/);
  assert.throws(() => assertBackendOverridePaths([...backendOverridePaths].reverse().concat(backendOverridePaths[0])), /exact closed set/);
});

test('console override accepts exactly the OS Shell UI, isolated frame and Nginx inputs', () => {
  assert.doesNotThrow(() => assertConsoleOverridePaths(consoleOverridePaths));
  assert.throws(() => assertConsoleOverridePaths([consoleOverridePaths[0]]), /exact closed set/);
  assert.throws(() => assertConsoleOverridePaths([...consoleOverridePaths, 'nginx/nginx.conf']), /exact closed set/);
  assert.throws(() => assertHeadPaths([...backendOverridePaths, ...consoleOverridePaths], backendOverridePaths),
    /unbound source/);
});

test('control override accepts exactly runtime projection/readiness source and their tests', () => {
  assert.doesNotThrow(() => assertControlOverridePaths(controlOverridePaths));
  assert.throws(() => assertControlOverridePaths(controlOverridePaths.slice(0, -1)), /exact closed set/);
  assert.throws(() => assertControlOverridePaths([...controlOverridePaths, 'backend/os-shell-control/config.js']), /exact closed set/);
});

test('backend override rejects path escape and non-canonical separators before allowlist comparison', () => {
  for (const value of ['../backend/Dockerfile', '/backend/Dockerfile', 'C:/backend/Dockerfile',
    'backend\\opensphere-console-backend\\Dockerfile', 'backend/../Dockerfile', './backend/Dockerfile', 'backend//Dockerfile']) {
    assert.throws(() => assertCanonicalRepositoryPath(value), /escapes the canonical repository/);
  }
});

test('deployment tooling remains a separate authority from both component overrides', () => {
  assert.doesNotThrow(() => assertHeadPaths([
    ...validRuntime, ...backendOverridePaths, ...consoleOverridePaths, ...controlOverridePaths, ...deploymentToolingPaths,
  ], [...validRuntime, ...backendOverridePaths, ...consoleOverridePaths, ...controlOverridePaths]));
  assert.throws(() => assertBackendOverridePaths([...backendOverridePaths, ...deploymentToolingPaths]), /exact closed set/);
  assert.throws(() => assertConsoleOverridePaths([...consoleOverridePaths, ...deploymentToolingPaths]), /exact closed set/);
  assert.throws(() => assertControlOverridePaths([...controlOverridePaths, ...deploymentToolingPaths]), /exact closed set/);
});

function git(repository, ...args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function writeRepositoryFile(repository, relativePath, value) {
  const target = join(repository, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}

function commit(repository, message, files) {
  for (const [relativePath, value] of Object.entries(files)) writeRepositoryFile(repository, relativePath, value);
  git(repository, 'add', '--', ...Object.keys(files));
  git(repository, 'commit', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

test('composite repository attribution rejects missing owners while ignoring unrelated monorepo source changes', () => {
  const repository = mkdtempSync(join(tmpdir(), 'opensphere-shell-composite-boundary-'));
  try {
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'OpenSphere Test');
    git(repository, 'config', 'user.email', 'test@opensphere.local');
    const baseRevision = commit(repository, 'base', { 'README.md': 'base\n' });
    const backendRevision = commit(repository, 'backend override', {
      [backendOverridePaths[0]]: 'FROM scratch\n',
      [backendOverridePaths[1]]: 'backend token contract\n',
      [backendOverridePaths[2]]: 'export const admission = true;\n',
      [backendOverridePaths[3]]: 'backend admission contract\n',
      [backendOverridePaths[4]]: 'backend server contract\n',
    });
    const consoleRevision = commit(repository, 'console override', Object.fromEntries(
      consoleOverridePaths.map((path) => [path, `console contract ${path}\n`])));
    const controlRevision = commit(repository, 'control override', Object.fromEntries(
      controlOverridePaths.map((path) => [path, `control contract ${path}\n`])));
    const headRevision = commit(repository, 'deployment tooling', {
      'scripts/Deploy-LocalEdgeOsShell.ps1': '# deployment tooling\n',
    });
    git(repository, 'remote', 'add', 'origin', canonicalConsoleOrigin);
    git(repository, 'update-ref', 'refs/remotes/origin/main', headRevision);
    git(repository, 'branch', '--set-upstream-to=origin/main', 'main');

    const valid = verifyCompositeRepositoryBoundary({
      repository, baseRevision, backendRevision, consoleRevision, controlRevision, headRevision,
    });
    assert.deepEqual(valid.backendPaths, backendOverridePaths);
    assert.deepEqual(valid.consolePaths, consoleOverridePaths);
    assert.deepEqual(valid.controlPaths, controlOverridePaths);
    assert.deepEqual(valid.toolingPaths, ['scripts/Deploy-LocalEdgeOsShell.ps1']);
    const cumulativeConsoleEvidence = verifyCompositeRepositoryBoundary({
      repository, baseRevision, backendRevision, consoleRevision: headRevision, controlRevision, headRevision,
    });
    assert.deepEqual(cumulativeConsoleEvidence.consolePaths, consoleOverridePaths);
    assert.deepEqual(cumulativeConsoleEvidence.toolingPaths, ['scripts/Deploy-LocalEdgeOsShell.ps1']);
    assert.throws(() => verifyCompositeRepositoryBoundary({
      repository, baseRevision, backendRevision, controlRevision, headRevision,
    }), /unbound source|component input differs/);

    const laterConsoleRevision = commit(repository, 'later Console-only override', Object.fromEntries(
      consoleOverridePaths.map((path) => [path, `later Console contract ${path}\n`])));
    git(repository, 'update-ref', 'refs/remotes/origin/main', laterConsoleRevision);
    const laterConsole = verifyCompositeRepositoryBoundary({
      repository, baseRevision, backendRevision, consoleRevision: laterConsoleRevision,
      controlRevision, headRevision: laterConsoleRevision,
    });
    assert.deepEqual(laterConsole.consolePaths, consoleOverridePaths);

    git(repository, 'switch', '-c', 'extra-console-evidence', laterConsoleRevision);
    const extraRevision = commit(repository, 'extra Console evidence path', {
      'backend/opensphere-console-backend/server.js': 'not a Console runtime input\n',
    });
    git(repository, 'update-ref', 'refs/remotes/origin/extra-console-evidence', extraRevision);
    git(repository, 'switch', 'main');
    git(repository, 'update-ref', 'refs/remotes/origin/main', laterConsoleRevision);
    assert.doesNotThrow(() => verifyCompositeRepositoryBoundary({
      repository, baseRevision, backendRevision, consoleRevision: extraRevision,
      controlRevision, headRevision: laterConsoleRevision,
    }));

    git(repository, 'switch', '-c', 'tampered-console-evidence', laterConsoleRevision);
    const tamperedRevision = commit(repository, 'tamper independently published Backend input', {
      [backendOverridePaths[0]]: 'FROM tampered\n',
    });
    git(repository, 'update-ref', 'refs/remotes/origin/tampered-console-evidence', tamperedRevision);
    git(repository, 'switch', 'main');
    assert.doesNotThrow(() => verifyCompositeRepositoryBoundary({
      repository, baseRevision, backendRevision, consoleRevision: tamperedRevision,
      controlRevision, headRevision: laterConsoleRevision,
    }));

    git(repository, 'switch', '-c', 'tampered-console-input', laterConsoleRevision);
    const tamperedConsoleRevision = commit(repository, 'tamper owned Console input', {
      [consoleOverridePaths[0]]: 'tampered Console input\n',
    });
    git(repository, 'update-ref', 'refs/remotes/origin/tampered-console-input', tamperedConsoleRevision);
    git(repository, 'switch', 'main');
    assert.throws(() => verifyCompositeRepositoryBoundary({
      repository, baseRevision, backendRevision, consoleRevision: tamperedConsoleRevision,
      controlRevision, headRevision: laterConsoleRevision,
    }), /component input differs/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('platform bridge accepts squash-separated main while preserving exact OS Shell component blobs', () => {
  const repository = mkdtempSync(join(tmpdir(), 'opensphere-shell-platform-bridge-'));
  try {
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'OpenSphere Test');
    git(repository, 'config', 'user.email', 'test@opensphere.local');
    const commonRevision = commit(repository, 'common root', { 'README.md': 'common\n' });
    git(repository, 'switch', '-c', 'os-shell');
    const baseRevision = commit(repository, 'OS Shell publication base', { 'OS-SHELL.md': 'base\n' });
    const controlFiles = Object.fromEntries(
      controlOverridePaths.map((path) => [path, `control contract ${path}\n`]));
    const controlRevision = commit(repository, 'OS Shell cumulative control publication', {
      ...controlFiles,
      ...Object.fromEntries(backendOverridePaths.map((path) => [path, `historical backend ${path}\n`])),
      ...Object.fromEntries(consoleOverridePaths.map((path) => [path, `historical console ${path}\n`])),
    });
    git(repository, 'switch', 'main');
    git(repository, 'reset', '--hard', commonRevision);
    const platformRevision = commit(repository, 'squash-equivalent canonical platform main', {
      ...controlFiles,
      'PLATFORM.md': 'canonical main\n',
    });
    const headRevision = commit(repository, 'reviewed deployment tooling', {
      'scripts/Deploy-LocalEdgeOsShell.ps1': '# deployment tooling\n',
    });
    git(repository, 'remote', 'add', 'origin', canonicalConsoleOrigin);
    git(repository, 'update-ref', 'refs/remotes/origin/os-shell', controlRevision);
    git(repository, 'update-ref', 'refs/remotes/origin/main', headRevision);
    git(repository, 'branch', '--set-upstream-to=origin/main', 'main');

    const valid = verifyCompositeRepositoryBoundary({
      repository, baseRevision, platformRevision, controlRevision, headRevision,
    });
    assert.equal(valid.platformRevision, platformRevision);
    assert.deepEqual(valid.controlPaths, controlOverridePaths);
    assert.deepEqual(valid.toolingPaths, ['scripts/Deploy-LocalEdgeOsShell.ps1']);
    assert.throws(() => verifyCompositeRepositoryBoundary({
      repository, baseRevision, platformRevision, backendRevision: platformRevision,
      controlRevision, headRevision,
    }), /cannot be combined/);

    const tamperedHead = commit(repository, 'tamper OS Shell control after platform bridge', {
      [controlOverridePaths[0]]: 'tampered control input\n',
    });
    git(repository, 'update-ref', 'refs/remotes/origin/main', tamperedHead);
    assert.throws(() => verifyCompositeRepositoryBoundary({
      repository, baseRevision, platformRevision, controlRevision, headRevision: tamperedHead,
    }), /unbound source|component input differs/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('independent component publications bridge a squash-separated live base without weakening blob ownership', () => {
  const repository = mkdtempSync(join(tmpdir(), 'opensphere-shell-independent-components-'));
  try {
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'OpenSphere Test');
    git(repository, 'config', 'user.email', 'test@opensphere.local');
    const commonRevision = commit(repository, 'common root', { 'README.md': 'common\n' });
    git(repository, 'switch', '-c', 'os-shell');
    const baseRevision = commit(repository, 'live OS Shell base', { 'OS-SHELL.md': 'live base\n' });
    const controlRevision = commit(repository, 'live Control publication', Object.fromEntries(
      controlOverridePaths.map((path) => [path, `control contract ${path}\n`])));

    git(repository, 'switch', 'main');
    git(repository, 'reset', '--hard', commonRevision);
    commit(repository, 'canonical squash-equivalent Control source', Object.fromEntries(
      controlOverridePaths.map((path) => [path, `control contract ${path}\n`])));
    const backendRevision = commit(repository, 'canonical Backend publication', Object.fromEntries(
      backendOverridePaths.map((path) => [path, `backend contract ${path}\n`])));
    const consoleRevision = commit(repository, 'canonical Console publication', Object.fromEntries(
      consoleOverridePaths.map((path) => [path, `console contract ${path}\n`])));
    const runtimeRevision = commit(repository, 'canonical Runtime publication', Object.fromEntries(
      validRuntime.map((path) => [path, `runtime contract ${path}\n`])));
    const headRevision = commit(repository, 'reviewed deployment tooling', {
      'scripts/Deploy-LocalEdgeOsShell.ps1': '# deployment tooling\n',
    });
    git(repository, 'remote', 'add', 'origin', canonicalConsoleOrigin);
    git(repository, 'update-ref', 'refs/remotes/origin/os-shell', controlRevision);
    git(repository, 'update-ref', 'refs/remotes/origin/main', headRevision);
    git(repository, 'branch', '--set-upstream-to=origin/main', 'main');

    const valid = verifyCompositeRepositoryBoundary({
      repository, baseRevision, runtimeRevision, backendRevision, consoleRevision, controlRevision, headRevision,
    });
    assert.equal(valid.headAnchorRevision, runtimeRevision);
    assert.deepEqual(valid.independentComponentAuthorities, ['runtime', 'backend', 'console']);
    assert.deepEqual(valid.runtimePaths, [...validRuntime].sort());
    assert.deepEqual(valid.backendPaths, backendOverridePaths);
    assert.deepEqual(valid.consolePaths, consoleOverridePaths);
    assert.deepEqual(valid.controlPaths, controlOverridePaths);
    assert.deepEqual(valid.toolingPaths, ['scripts/Deploy-LocalEdgeOsShell.ps1']);

    const tamperedHead = commit(repository, 'tamper Runtime after publication', {
      [validRuntime[0]]: 'tampered runtime contract\n',
    });
    git(repository, 'update-ref', 'refs/remotes/origin/main', tamperedHead);
    assert.throws(() => verifyCompositeRepositoryBoundary({
      repository, baseRevision, runtimeRevision, backendRevision, consoleRevision, controlRevision,
      headRevision: tamperedHead,
    }), /unbound source|component input differs/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
