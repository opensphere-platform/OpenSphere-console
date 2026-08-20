import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const publisher = path.join(root, 'scripts', 'Publish-LocalEdgeOsShellArtifacts.ps1');
const integratedPublisher = path.join(root, 'scripts', 'Publish-LocalEdge.ps1');
const sha = (seed) => `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
const revision = 'a'.repeat(40);
const baseRevision = 'b'.repeat(40);
const digest = sha('mock-image');
const releaseTag = '197001010900';
const canonical = 'https://github.com/opensphere-platform/OpenSphere-console';

function image(repository, value = digest) { return `ghcr.io/opensphere-platform/${repository}@${value}`; }
function baseEvidence({ extra = false, repository = 'opensphere-console', sessionPolicyRevision = 'operator-interactive-v1' } = {}) {
  const components = {
    console: { repository, image: image('opensphere-console'), sourceRevision: baseRevision, inputs: { sdk: { repository: 'https://github.com/opensphere-platform/OpenSphere-SDK.git', sourceRevision: 'c'.repeat(40) } } },
    backend: { repository: 'opensphere-console-backend', image: image('opensphere-console-backend'), sourceRevision: baseRevision },
    cliArtifacts: { repository: 'opensphere-os-cli', image: image('opensphere-os-cli'), sourceRevision: baseRevision },
    osShellControl: { repository: 'opensphere-console-os-shell-control', image: image('opensphere-console-os-shell-control'), sourceRevision: baseRevision },
    osShellRuntime: { repository: 'opensphere-os-shell-runtime', image: image('opensphere-os-shell-runtime'), sourceRevision: baseRevision },
  };
  if (extra) components.unapproved = { repository: 'opensphere-unapproved', image: image('opensphere-unapproved'), sourceRevision: baseRevision };
  return {
    apiVersion: 'release.opensphere.io/v1alpha1', kind: 'OpenSphereEdgeComponentPublication', publicationScope: 'ComponentSet',
    channel: 'edge', status: 'Active', source: canonical, sourceRevision: baseRevision, releaseTag: '196912312359', immutableTag: `local-${baseRevision.slice(0, 12)}`,
    buildAuthority: 'localhost', releaseClass: 'pre-ga', gaEligible: false, supportedPlatforms: ['linux/amd64'],
    components, artifacts: {
      sdkSource: { repository: 'https://github.com/opensphere-platform/OpenSphere-SDK.git', sourceRevision: 'c'.repeat(40) },
      supabaseMigrationManifest: { path: 'backend/supabase/migrations/manifest.json', sha256: sha('migration'), setDigest: sha('migration-set'), latestMigrationId: '0062', migrationCount: 62 },
      osShellRelease: {
        cliManifest: { image: image('opensphere-os-cli'), imagePath: '/srv/index.json', sha256: sha('base-manifest'), signatureAlgorithm: 'Ed25519', keyId: 'opensphere-cli-local-dev-v1' },
        runtimeBinary: { image: image('opensphere-os-shell-runtime'), path: '/usr/local/bin/os', sha256: sha('base-runtime') },
        runtimeTemplate: { path: 'backend/os-shell-control/runtime-template.js', sha256: sha('runtime-template') },
        sessionPolicyRevision, runtimeProcessPolicy: { maxProcesses: 256, globalPodLimit: 8, userNamespacePolicy: 'required-hostUsers-false', enforcement: 'linux-userns+rlimit-nproc+namespace-resourcequota' },
      },
      osShellControlRelease: { runtimeTemplate: { path: 'backend/os-shell-control/runtime-template.js', sha256: sha('runtime-template') }, runtimeProcessPolicy: { maxProcesses: 256, globalPodLimit: 8, userNamespacePolicy: 'required-hostUsers-false', enforcement: 'linux-userns+rlimit-nproc+namespace-resourcequota' } },
    },
  };
}

function writeHarness(temp, binaryContent = 'mock os binary') {
  const binary = path.join(temp, 'os');
  fs.writeFileSync(binary, binaryContent);
  const manifest = path.join(temp, 'index.json');
  fs.writeFileSync(manifest, JSON.stringify({
    signature: { algorithm: 'Ed25519', keyId: 'opensphere-cli-local-dev-v1', value: 'x'.repeat(86) },
    links: [{ os: 'linux', arch: 'amd64', sha256: sha('mock os binary').slice(7), size: 14 }],
  }));
  const harness = path.join(temp, 'mock-publisher.ps1');
  fs.writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'
$global:MockTags = @{}
$global:MockDigest = $env:MOCK_DIGEST
function Add-MockLog([string]$line) { Add-Content -LiteralPath $env:MOCK_LOG -Value $line }
function git {
  $Arguments = @($args)
  $line = $Arguments -join ' '; Add-MockLog "git $line"; $global:LASTEXITCODE = 0
  if ($line -match 'remote get-url origin') { if ($env:MOCK_MODE -eq 'origin') { 'https://evil.invalid/repo.git' } else { 'https://github.com/opensphere-platform/OpenSphere-console.git' }; return }
  if ($line -match 'branch --show-current') { if ($env:MOCK_MODE -eq 'nonmain') { 'feature' } else { 'main' }; return }
  if ($line -match 'rev-parse') { $env:MOCK_REVISION; return }
  if ($line -match 'status --short') { if ($env:MOCK_MODE -eq 'dirty') { ' M forbidden.txt' }; return }
  if ($line -match 'show -s --format=%ct') { '0'; return }
  if ($line -match 'diff --name-only') { if ($env:MOCK_MODE -eq 'changed') { 'backend/supabase/migrations/forbidden.sql' } else { 'backend/os-cli/Dockerfile'; 'backend/os-cli/Dockerfile.runtime' }; return }
  if ($line -match 'merge-base --is-ancestor') { if ($env:MOCK_MODE -eq 'base-drift') { $global:LASTEXITCODE = 1 }; return }
}
function docker {
  $Arguments = @($args)
  $line = $Arguments -join ' '; Add-MockLog "docker $line"; $global:LASTEXITCODE = 0
  if ($line -match '^info ') { if ($line -match 'OSType') { 'linux' } else { 'amd64' }; return }
  if ($line -match '^buildx build ') {
    if ($env:MOCK_MODE -eq 'build-fail') { $global:LASTEXITCODE = 1; return }
    $tagIndex = [array]::IndexOf($Arguments, '--tag'); if ($tagIndex -ge 0) { $global:MockTags[$Arguments[$tagIndex + 1]] = $global:MockDigest }; return
  }
  if ($line -match '^buildx imagetools create ') {
    $tagIndex = [array]::IndexOf($Arguments, '--tag'); if ($tagIndex -ge 0) { $global:MockTags[$Arguments[$tagIndex + 1]] = $global:MockDigest }; return
  }
  if ($line -match '^buildx imagetools inspect ') {
    $reference = $Arguments[-1]
    if ($env:MOCK_MODE -eq 'tag-collision' -and $reference -match ':197001010900$') { "Digest: sha256:$('c' * 64)"; return }
    if ($line -match '--format') {
      $isReused = $reference -match 'opensphere-console@|opensphere-console-backend@|opensphere-console-os-shell-control@'
      $sourceRevision = if ($isReused) { $env:MOCK_BASE_REVISION } else { $env:MOCK_REVISION }
      $imageReleaseTag = if ($isReused) { '196912312359' } else { '197001010900' }
      $labels = [ordered]@{
        'io.opensphere.channel' = 'edge'; 'io.opensphere.source-revision' = $sourceRevision
        'io.opensphere.release-tag' = $imageReleaseTag; 'org.opencontainers.image.version' = $imageReleaseTag
        'opensphere.io/build-authority' = 'localhost'; 'opensphere.io/release-class' = 'pre-ga'; 'opensphere.io/ga-eligible' = 'false'
      }
      if ($env:MOCK_MODE -eq 'oci-label') { $labels['opensphere.io/ga-eligible'] = 'true' }
      ([ordered]@{ os='linux'; architecture='amd64'; config=[ordered]@{ Labels=$labels } } | ConvertTo-Json -Compress); return
    }
    if ($reference -match '@sha256:') { "Digest: $global:MockDigest"; return }
    if ($global:MockTags.ContainsKey($reference)) { "Digest: $($global:MockTags[$reference])"; return }
    $global:LASTEXITCODE = 1; return
  }
  if ($line -match '^create ') { 'mock-container'; return }
  if ($line -match '^cp ') { if ($Arguments[1] -match 'index.json') { Copy-Item -LiteralPath $env:MOCK_MANIFEST -Destination $Arguments[2] } else { Copy-Item -LiteralPath $env:MOCK_BINARY -Destination $Arguments[2] }; return }
  if ($line -match '^(container )?rm ') { return }
}
& $env:MOCK_PUBLISHER -BasePublicationEvidence $env:MOCK_BASE -UseExistingRegistryLogin
exit $LASTEXITCODE
`, 'utf8');
  return { harness, binary, manifest };
}

function runPublisher(mode = '', base = baseEvidence()) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opensphere-os-shell-publisher-test-'));
  const basePath = path.join(temp, 'base.json'); const log = path.join(temp, 'calls.log');
  fs.writeFileSync(basePath, JSON.stringify(base)); fs.writeFileSync(log, '');
  const fixture = writeHarness(temp, mode === 'binary-mismatch' ? 'different binary' : 'mock os binary');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture.harness], {
    encoding: 'utf8', env: { ...process.env, OS: 'Windows_NT', MOCK_MODE: mode, MOCK_REVISION: revision, MOCK_BASE_REVISION: baseRevision, MOCK_DIGEST: digest, MOCK_LOG: log, MOCK_BASE: basePath, MOCK_PUBLISHER: publisher, MOCK_MANIFEST: fixture.manifest, MOCK_BINARY: fixture.binary },
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const outputPath = result.status === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) : null;
  const output = outputPath && fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')) : null;
  return { temp, result, calls, output, outputPath };
}

function noWrite(calls) { assert.equal(calls.some((line) => /^docker (buildx build|buildx imagetools create)/.test(line)), false, calls.join('\n')); }
function dispose(run) { fs.rmSync(run.temp, { recursive: true, force: true }); if (run.outputPath) fs.rmSync(path.dirname(run.outputPath), { recursive: true, force: true }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('core import has no Docker, Git, registry, or write side effect', () => {
  const command = `Import-Module '${path.join(root, 'scripts', 'local-edge-publication-core.psm1').replaceAll("'", "''")}' -Force; 'imported'`;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /imported/);
});

function writeIntegratedHarness(temp) {
  const binary = path.join(temp, 'integrated-os');
  fs.writeFileSync(binary, 'mock integrated os binary');
  const manifest = path.join(temp, 'integrated-index.json');
  fs.writeFileSync(manifest, JSON.stringify({
    signature: { algorithm: 'Ed25519', keyId: 'opensphere-cli-local-dev-v1', value: 'x'.repeat(86) },
    links: [{ os: 'linux', arch: 'amd64', sha256: sha('mock integrated os binary').slice(7), size: 25 }],
  }));
  const harness = path.join(temp, 'mock-integrated-publisher.ps1');
  fs.writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'; $global:MockTags = @{}; $global:MockDigest = $env:MOCK_DIGEST
function Add-MockLog([string]$line) { Add-Content -LiteralPath $env:MOCK_LOG -Value $line }
function git {
  $Arguments = @($args)
  $line = $Arguments -join ' '; Add-MockLog "git $line"; $global:LASTEXITCODE = 0
  if ($line -match 'rev-parse HEAD') { if ($line -match 'OpenSphere-SDK') { $env:MOCK_SDK_REVISION } elseif ($line -match 'OpenSphere-Setup-CLI') { $env:MOCK_SETUP_REVISION } else { $env:MOCK_REVISION }; return }
  if ($line -match 'show -s --format=%ct') { '0'; return }
  if ($line -match 'status --short') { return }
  if ($line -match 'worktree add') { $target = $Arguments[[array]::IndexOf($Arguments, 'add') + 2]; New-Item -ItemType Junction -Path $target -Target $env:MOCK_REPO | Out-Null; return }
  if ($line -match '^clone ') { New-Item -ItemType Directory -Path $Arguments[-1] -Force | Out-Null; return }
}
function kubectl {
  $Arguments = @($args)
  Add-MockLog "kubectl $($Arguments -join ' ')"; $global:LASTEXITCODE = 0
  if (($Arguments -join ' ') -match 'config current-context') { 'docker-desktop'; return }
  if (($Arguments -join ' ') -match 'get nodes -o json') { '{"items":[{"status":{"nodeInfo":{"architecture":"amd64"}}}]}' }
}
function docker {
  $Arguments = @($args)
  $line = $Arguments -join ' '; Add-MockLog "docker $line"; $global:LASTEXITCODE = 0
  if ($line -match '^info ') { if ($line -match 'OSType') { 'linux' } else { 'amd64' }; return }
  if ($line -match '^buildx build ') {
    $tag = $Arguments[[array]::IndexOf($Arguments, '--tag') + 1]; $global:MockTags[$tag] = $global:MockDigest
    $metadataIndex = [array]::IndexOf($Arguments, '--metadata-file'); if ($metadataIndex -ge 0) { '{"containerimage.digest":"' + $global:MockDigest + '"}' | Set-Content -LiteralPath $Arguments[$metadataIndex + 1] -Encoding utf8 }
    return
  }
  if ($line -match '^buildx imagetools create ') { $global:MockTags[$Arguments[[array]::IndexOf($Arguments, '--tag') + 1]] = $global:MockDigest; return }
  if ($line -match '^buildx imagetools inspect ') {
    $reference = $Arguments[-1]
    if ($line -match '--format') {
      $labels = [ordered]@{ 'io.opensphere.channel'='edge'; 'io.opensphere.source-revision'=$env:MOCK_REVISION; 'io.opensphere.release-tag'='197001010900'; 'org.opencontainers.image.version'='197001010900'; 'opensphere.io/build-authority'='localhost'; 'opensphere.io/release-class'='pre-ga'; 'opensphere.io/ga-eligible'='false' }
      if ($reference -match 'opensphere-console@') { $labels['io.opensphere.sdk-source-revision'] = $env:MOCK_SDK_REVISION }
      ([ordered]@{ os='linux'; architecture='amd64'; config=[ordered]@{ Labels=$labels } } | ConvertTo-Json -Compress); return
    }
    if ($reference -match '@sha256:' -or $global:MockTags.ContainsKey($reference)) { "Digest: $global:MockDigest"; return }
    $global:LASTEXITCODE = 1; return
  }
  if ($line -match '^create ') { 'mock-container'; return }
  if ($line -match '^cp ') { if ($Arguments[1] -match 'index.json') { Copy-Item -LiteralPath $env:MOCK_INTEGRATED_MANIFEST -Destination $Arguments[2] } else { Copy-Item -LiteralPath $env:MOCK_INTEGRATED_BINARY -Destination $Arguments[2] }; return }
  if ($line -match '^(container )?rm ') { return }
}
if ($env:MOCK_COMPONENTS) { & $env:MOCK_INTEGRATED -UseExistingRegistryLogin -Components ($env:MOCK_COMPONENTS -split ',') } else { & $env:MOCK_INTEGRATED -UseExistingRegistryLogin }
exit $LASTEXITCODE
`, 'utf8');
  return { harness, binary, manifest };
}

function runIntegrated(components = '') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opensphere-integrated-publisher-test-')); const log = path.join(temp, 'calls.log'); fs.writeFileSync(log, '');
  const mockRevision = crypto.createHash('sha256').update(temp).digest('hex').slice(0, 40);
  const sdkRevision = fs.readFileSync(path.join(root, 'sdk-source.lock'), 'utf8').trim();
  const setupRevision = fs.readFileSync(path.join(root, 'backend', 'opensphere-console-backend', 'setup-source.lock'), 'utf8').trim();
  const fixture = writeIntegratedHarness(temp);
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture.harness], {
    encoding: 'utf8', env: { ...process.env, OS: 'Windows_NT', MOCK_LOG: log, MOCK_DIGEST: digest, MOCK_REPO: root, MOCK_REVISION: mockRevision, MOCK_SDK_REVISION: sdkRevision, MOCK_SETUP_REVISION: setupRevision, MOCK_INTEGRATED: integratedPublisher, MOCK_COMPONENTS: components, MOCK_INTEGRATED_BINARY: fixture.binary, MOCK_INTEGRATED_MANIFEST: fixture.manifest },
  });
  const bomPath = result.stdout.match(/^\[bom\]\s+(.+)$/m)?.[1]?.trim();
  const bom = bomPath && fs.existsSync(bomPath) ? JSON.parse(fs.readFileSync(bomPath, 'utf8').replace(/^\uFEFF/, '')) : null;
  return { temp, result, calls: fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean), bomPath, bom, binarySha256: sha('mock integrated os binary'), manifestSha256: sha(fs.readFileSync(fixture.manifest)) };
}

function disposeIntegrated(run) {
  fs.rmSync(run.temp, { recursive: true, force: true });
  if (run.bomPath) {
    const workspace = path.dirname(run.bomPath);
    assert.match(workspace.replaceAll('\\', '/'), /\/\.codex-tmp\/local-edge-[a-f0-9]{12}$/);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('integrated publisher subprocess mock preserves default 13-component and explicit component behavior', () => {
  const defaultRun = runIntegrated(); const cliRun = runIntegrated('cliArtifacts');
  try {
    assert.equal(defaultRun.result.status, 0, `${defaultRun.result.stdout}\n${defaultRun.result.stderr}`);
    assert.equal(defaultRun.calls.filter((line) => line.startsWith('docker buildx build ')).length, 13);
    assert.equal(cliRun.result.status, 0, `${cliRun.result.stdout}\n${cliRun.result.stderr}`);
    const cliBuilds = cliRun.calls.filter((line) => line.startsWith('docker buildx build ')); assert.equal(cliBuilds.length, 1); assert.match(cliBuilds[0], /opensphere-os-cli/);
  } finally { disposeIntegrated(defaultRun); disposeIntegrated(cliRun); }
});

test('integrated publisher subprocess mock emits a closed exact five-component OS Shell base publication', () => {
  const run = runIntegrated('console,backend,osShellControl,cliArtifacts,osShellRuntime');
  try {
    assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`); assert.ok(run.bom);
    assert.deepEqual(Object.keys(run.bom.components).sort(), ['backend', 'cliArtifacts', 'console', 'osShellControl', 'osShellRuntime']);
    assert.equal(Object.keys(run.bom.components).length, 5); assert.equal(run.bom.kind, 'OpenSphereEdgeComponentPublication'); assert.equal(run.bom.publicationScope, 'ComponentSet');
    assert.equal('affectedImages' in run.bom, false); assert.equal('reusedImages' in run.bom, false); assert.equal('releaseScope' in run.bom, false);
    const release = run.bom.artifacts.osShellRelease; assert.equal(release.sessionPolicyRevision, 'operator-interactive-v1');
    assert.deepEqual(release.runtimeProcessPolicy, { maxProcesses: 256, globalPodLimit: 8, userNamespacePolicy: 'required-hostUsers-false', enforcement: 'linux-userns+rlimit-nproc+namespace-resourcequota' });
    assert.equal(release.cliManifest.image, run.bom.components.cliArtifacts.image); assert.equal(release.cliManifest.imagePath, '/srv/index.json'); assert.equal(release.cliManifest.sha256, run.manifestSha256);
    assert.equal(release.runtimeBinary.image, run.bom.components.osShellRuntime.image); assert.equal(release.runtimeBinary.path, '/usr/local/bin/os'); assert.equal(release.runtimeBinary.sha256, run.binarySha256);
    const extractedManifest = JSON.parse(fs.readFileSync(path.join(run.temp, 'integrated-index.json'), 'utf8'));
    const linux = extractedManifest.links.filter((link) => link.os === 'linux' && link.arch === 'amd64'); assert.equal(linux.length, 1); assert.equal(`sha256:${linux[0].sha256}`, release.runtimeBinary.sha256);
  } finally { disposeIntegrated(run); }
});

test('artifact publisher subprocess mock produces pair-only override after KST tags then edge', () => {
  const run = runPublisher();
  try {
    assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`); assert.ok(run.output);
    assert.deepEqual(Object.keys(run.output.components).sort(), ['cliArtifacts', 'osShellRuntime']);
    assert.deepEqual(run.output.affectedImages, ['cliArtifacts', 'osShellRuntime']); assert.deepEqual(run.output.reusedImages, ['console', 'backend', 'osShellControl']);
    assert.equal(run.output.artifacts.osShellRelease.sessionPolicyRevision, 'operator-interactive-v1');
    assert.equal(run.output.artifacts.osShellRelease.baseSessionPolicyRevision, 'operator-interactive-v1');
    assert.equal(run.output.basePublication.sourceRevision, baseRevision);
    const builds = run.calls.filter((line) => line.startsWith('docker buildx build ')); assert.equal(builds.length, 2);
    for (const build of builds) for (const label of ['io.opensphere.channel=edge', `io.opensphere.source-revision=${revision}`, `io.opensphere.release-tag=${releaseTag}`, `org.opencontainers.image.version=${releaseTag}`, 'opensphere.io/build-authority=localhost', 'opensphere.io/release-class=pre-ga', 'opensphere.io/ga-eligible=false', 'CLI_UPDATE_SIGNING_PROFILE=local']) assert.match(build, new RegExp(label.replace(/[.+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(builds[1], /OPENSPHERE_VERSION=197001010900/);
    const writes = run.calls.filter((line) => line.startsWith('docker buildx imagetools create'));
    assert.equal(writes.length, 4); assert.match(writes[0], /:197001010900/); assert.match(writes[1], /:197001010900/); assert.match(writes[2], /:edge/); assert.match(writes[3], /:edge/);
    assert.equal(run.calls.some((line) => /buildx build .*opensphere-console(?: |$)/.test(line)), false);
  } finally { dispose(run); }
});

function writeDeployOverrideHarness(temp) {
  const harness = path.join(temp, 'mock-deploy-override.ps1');
  fs.writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = 0
function git {
  $line = $args -join ' '; $global:LASTEXITCODE = 0
  if ($line -match 'rev-parse HEAD') { $env:MOCK_BASE_REVISION; return }
  if ($line -match 'status --short') { ' M intentional-test-dirty'; return }
  if ($line -match 'remote get-url origin') { 'https://github.com/opensphere-platform/OpenSphere-console.git'; return }
  if ($line -match 'show -s --format=%ct') { '0'; return }
  if ($line -match 'merge-base --is-ancestor') { return }
}
function kubectl {
  $line = $args -join ' '; $global:LASTEXITCODE = 0
  if ($line -match 'config current-context') { 'docker-desktop'; return }
  if ($line -match 'get nodes -o json') { '{"items":[{"status":{"nodeInfo":{"architecture":"amd64"}}}]}' }
}
function docker {
  $line = $args -join ' '; $global:LASTEXITCODE = 0
  if ($line -match '^info ') { if ($line -match 'OSType') { 'linux' } else { 'amd64' }; return }
  if ($line -match '^buildx imagetools inspect ') {
    if ($line -match '--format') {
      $reference = $args[-1]; $isBase = $reference -match 'opensphere-console@|opensphere-console-backend@|opensphere-console-os-shell-control@'
      $sourceRevision = if ($isBase) { $env:MOCK_BASE_REVISION } else { $env:MOCK_REVISION }; $releaseTag = if ($isBase) { '196912312359' } else { '197001010900' }
      ([ordered]@{ os='linux'; architecture='amd64'; config=[ordered]@{ Labels=[ordered]@{ 'io.opensphere.channel'='edge'; 'io.opensphere.source-revision'=$sourceRevision; 'io.opensphere.release-tag'=$releaseTag; 'org.opencontainers.image.version'=$releaseTag; 'opensphere.io/build-authority'='localhost'; 'opensphere.io/release-class'='pre-ga'; 'opensphere.io/ga-eligible'='false' } } } | ConvertTo-Json -Compress); return
    }
    "Digest: $env:MOCK_DIGEST"; return
  }
}
& $env:MOCK_DEPLOY -PublicationEvidence $env:MOCK_BASE -CliRuntimePublicationEvidence $env:MOCK_OVERRIDE
exit $LASTEXITCODE
`, 'utf8');
  return harness;
}

test('publisher output is accepted as the exact CLI/runtime Deploy override before the dirty-source safety gate', () => {
  const publishRun = runPublisher();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opensphere-deploy-override-test-'));
  try {
    assert.equal(publishRun.result.status, 0, publishRun.result.stderr);
    const basePath = path.join(temp, 'base.json'); fs.writeFileSync(basePath, JSON.stringify(baseEvidence()));
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', writeDeployOverrideHarness(temp)], {
      encoding: 'utf8', env: { ...process.env, OS: 'Windows_NT', MOCK_BASE: basePath, MOCK_OVERRIDE: publishRun.outputPath, MOCK_DEPLOY: path.join(root, 'scripts', 'Deploy-LocalEdgeOsShell.ps1'), MOCK_DIGEST: digest, MOCK_BASE_REVISION: baseRevision, MOCK_REVISION: revision },
    });
    assert.notEqual(result.status, 0); assert.match(`${result.stdout}\n${result.stderr}`, /Console source must be clean/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /CLI\/runtime override requires exactly|session policy evidence is absent/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); dispose(publishRun); }
});

function runDeployOverrideMutation(mutator, mutateBase = null) {
  const publishRun = runPublisher(); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opensphere-deploy-schema-test-'));
  assert.equal(publishRun.result.status, 0, publishRun.result.stderr);
  const base = baseEvidence(); if (mutateBase) mutateBase(base);
  const basePath = path.join(temp, 'base.json'); const overridePath = path.join(temp, 'override.json');
  fs.writeFileSync(basePath, JSON.stringify(base)); const override = clone(publishRun.output); mutator(override); fs.writeFileSync(overridePath, JSON.stringify(override));
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', writeDeployOverrideHarness(temp)], {
    encoding: 'utf8', env: { ...process.env, OS: 'Windows_NT', MOCK_BASE: basePath, MOCK_OVERRIDE: overridePath, MOCK_DEPLOY: path.join(root, 'scripts', 'Deploy-LocalEdgeOsShell.ps1'), MOCK_DIGEST: digest, MOCK_BASE_REVISION: baseRevision, MOCK_REVISION: revision },
  });
  return { result, temp, publishRun };
}

for (const [name, mutate] of [
  ['unknown top-level field', (value) => { value.unapproved = true; }],
  ['unknown artifacts field', (value) => { value.artifacts.unapproved = true; }],
  ['unknown basePublication field', (value) => { value.basePublication.unapproved = true; }],
  ['unknown component field', (value) => { value.components.cliArtifacts.unapproved = true; }],
  ['unknown osShellRelease field', (value) => { value.artifacts.osShellRelease.unapproved = true; }],
  ['missing runtime component', (value) => { delete value.components.osShellRuntime; }],
  ['typed session policy', (value) => { value.artifacts.osShellRelease.sessionPolicyRevision = 17; }],
]) test(`Deploy rejects pair override ${name} before the dirty-source gate`, () => {
  const run = runDeployOverrideMutation(mutate); try { assert.notEqual(run.result.status, 0); assert.match(`${run.result.stdout}\n${run.result.stderr}`, /CLI\/runtime override/); assert.doesNotMatch(`${run.result.stdout}\n${run.result.stderr}`, /Console source must be clean/); } finally { fs.rmSync(run.temp, { recursive: true, force: true }); dispose(run.publishRun); }
});

test('Deploy rejects a pair override when the separately supplied base evidence bytes change', () => {
  const run = runDeployOverrideMutation((value) => value, (base) => { base.artifacts.sdkSource.sourceRevision = 'd'.repeat(40); });
  try { assert.notEqual(run.result.status, 0); assert.match(`${run.result.stdout}\n${run.result.stderr}`, /base publication binding differs/); } finally { fs.rmSync(run.temp, { recursive: true, force: true }); dispose(run.publishRun); }
});

for (const [name, mutate] of [
  ['path SHA substitution', (value) => { value.basePublication.pathSha256 = sha('other-base-file'); }],
  ['base source revision substitution', (value) => { value.basePublication.sourceRevision = 'e'.repeat(40); }],
  ['base release tag substitution', (value) => { value.basePublication.releaseTag = '200001010000'; }],
  ['base session policy substitution', (value) => { value.basePublication.sessionPolicyRevision = 'forged-policy'; }],
]) test(`Deploy rejects ${name} in a pair override`, () => {
  const run = runDeployOverrideMutation(mutate); try { assert.notEqual(run.result.status, 0); assert.match(`${run.result.stdout}\n${run.result.stderr}`, /base publication binding differs/); } finally { fs.rmSync(run.temp, { recursive: true, force: true }); dispose(run.publishRun); }
});

test('Deploy rejects a pair override with a substituted reused projection', () => {
  const run = runDeployOverrideMutation((value) => { value.basePublication.reused.console.digest = sha('substituted-console'); });
  try { assert.notEqual(run.result.status, 0); assert.match(`${run.result.stdout}\n${run.result.stderr}`, /reused console projection differs/); } finally { fs.rmSync(run.temp, { recursive: true, force: true }); dispose(run.publishRun); }
});

const digestDriftEvidence = baseEvidence();
digestDriftEvidence.components.console.image = image('opensphere-console', sha('drifted-reused-console'));
const unknownTopLevelBaseEvidence = clone(baseEvidence()); unknownTopLevelBaseEvidence.unapproved = true;
const unknownArtifactsBaseEvidence = clone(baseEvidence()); unknownArtifactsBaseEvidence.artifacts.unapproved = true;
const unknownComponentBaseEvidence = clone(baseEvidence()); unknownComponentBaseEvidence.components.backend.unapproved = true;
const unknownReleaseBaseEvidence = clone(baseEvidence()); unknownReleaseBaseEvidence.artifacts.osShellRelease.unapproved = true;
const missingBaseComponentEvidence = clone(baseEvidence()); delete missingBaseComponentEvidence.components.osShellRuntime;
const typedMigrationBaseEvidence = clone(baseEvidence()); typedMigrationBaseEvidence.artifacts.supabaseMigrationManifest.migrationCount = '62';
for (const [name, mode, evidence] of [
  ['origin', 'origin', baseEvidence()], ['non-main', 'nonmain', baseEvidence()], ['dirty', 'dirty', baseEvidence()],
  ['changed path', 'changed', baseEvidence()], ['extra component', '', baseEvidence({ extra: true })],
  ['base ancestor drift', 'base-drift', baseEvidence()], ['reused repository drift', '', baseEvidence({ repository: 'opensphere-forged' })], ['reused digest drift', '', digestDriftEvidence],
  ['OCI label drift', 'oci-label', baseEvidence()], ['KST tag collision', 'tag-collision', baseEvidence()],
  ['session policy absence', '', baseEvidence({ sessionPolicyRevision: '' })], ['base unknown top-level', '', unknownTopLevelBaseEvidence], ['base unknown artifacts', '', unknownArtifactsBaseEvidence], ['base unknown component', '', unknownComponentBaseEvidence], ['base unknown osShellRelease', '', unknownReleaseBaseEvidence], ['base missing component', '', missingBaseComponentEvidence], ['base typed migration count', '', typedMigrationBaseEvidence],
]) test(`artifact publisher rejects ${name} before a write-side Docker operation`, () => {
  const run = runPublisher(mode, evidence); try { assert.notEqual(run.result.status, 0); noWrite(run.calls); } finally { dispose(run); }
});

test('artifact publisher rejects binary mismatch after stopped-container extraction', () => {
  const run = runPublisher('binary-mismatch');
  try { assert.notEqual(run.result.status, 0); assert.match(`${run.result.stdout}\n${run.result.stderr}`, /signed manifest linux binary SHA differs/); } finally { dispose(run); }
});
