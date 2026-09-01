import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const publisher = readFileSync(new URL('./Publish-LocalEdgeOsShell.ps1', import.meta.url), 'utf8');
const generalPublisher = readFileSync(new URL('./Publish-LocalEdge.ps1', import.meta.url), 'utf8');
const consolePublisher = readFileSync(new URL('./Publish-LocalEdgeConsole.ps1', import.meta.url), 'utf8');
const consoleSessionPublisher = readFileSync(new URL('./Publish-LocalEdgeConsoleSession.ps1', import.meta.url), 'utf8');
const osShellConsolePublisher = readFileSync(new URL('./Publish-LocalEdgeOsShellConsole.ps1', import.meta.url), 'utf8');
const deployer = readFileSync(new URL('./Deploy-LocalEdgeOsShell.ps1', import.meta.url), 'utf8');

test('dedicated OS Shell publisher selects only Backend and Control', () => {
  assert.match(publisher, /Components = @\('backend', 'osShellControl'\)/);
  assert.match(publisher, /affectedImages = @\("\$registry\/opensphere-console-backend", "\$registry\/opensphere-console-os-shell-control"\)/);
  assert.match(publisher, /releaseScope = 'component'/);
  assert.match(publisher, /fullReleaseJustification = \$null/);
  assert.doesNotMatch(publisher, /'-Components', 'console'/);
  assert.doesNotMatch(publisher, /'-Components', 'osShellRuntime'/);
});

test('publisher verifies live exact digests, source attribution, ancestry and migration lineage before split evidence', () => {
  assert.match(publisher, /merge-base --is-ancestor/);
  assert.match(publisher, /os-shell-runtime-override-boundary\.mjs/);
  assert.match(publisher, /Get-RemoteDigest -Reference "\$\{backendRepository\}:edge"/);
  assert.match(publisher, /Get-RemoteDigest -Reference "\$\{controlRepository\}:edge"/);
  assert.match(publisher, /Get-LiveDeploymentDigest -Deployment 'opensphere-console-backend'/);
  assert.match(publisher, /'opensphere-shell-api', 'opensphere-shell-gateway', 'opensphere-shell-reconciler'/);
  assert.match(publisher, /targetMigration\.setDigest -ne \[string\]\$baseMigration\.setDigest/);
  assert.match(publisher, /components\.PSObject\.Properties\.Remove\('osShellControl'\)/);
  assert.match(publisher, /components\.PSObject\.Properties\.Remove\('backend'\)/);
});

test('general publisher treats OS Shell images as auxiliary component-only images', () => {
  assert.match(generalPublisher, /Key = 'osShellControl'; Image = 'opensphere-console-os-shell-control'/);
  assert.match(generalPublisher, /\$auxiliaryComponentKeys = @\('cliArtifacts', 'osShellControl', 'osShellRuntime'\)/);
  assert.match(generalPublisher, /\$releaseArtifacts\['osShellControlRelease'\]/);
});

test('fresh publication producers verify and emit the global migration authority', () => {
  for (const source of [generalPublisher, consolePublisher, consoleSessionPublisher, osShellConsolePublisher]) {
    assert.match(source, /migrations\\manifest[.]json/);
    assert.match(source, /console-migrations[.]mjs'\) verify/);
    assert.match(source, /latestGlobalId/);
  }
  for (const source of [generalPublisher, consolePublisher, consoleSessionPublisher]) {
    assert.doesNotMatch(source, /backend\\supabase\\migrations\\manifest[.]json/);
    assert.doesNotMatch(source, /latestMigrationId/);
  }
  assert.match(generalPublisher, /path = 'migrations\/manifest[.]json'/);
  assert.match(consolePublisher, /Installed release does not use the exact fresh Console migration lineage/);
  assert.match(consoleSessionPublisher, /requires the exact fresh Console migration lineage/);
  assert.match(osShellConsolePublisher, /deployed Backend still uses the legacy numeric migration lineage/);
});

test('legacy Backend publication stops before any registry write under the fresh authority', () => {
  const block = generalPublisher.indexOf("if ($Components -contains 'backend')");
  const auth = generalPublisher.indexOf("[step 03/06] Confirm GHCR authentication mode");
  const build = generalPublisher.indexOf("[step 04/06] Reuse verified immutable images or build missing host-native images");
  assert.ok(block >= 0 && block < auth && block < build);
  assert.match(generalPublisher, /Publishing that image under the fresh global[\s\S]*stop before workspace setup,[\s\S]*registry login, build, push, or tag movement/);
  assert.match(publisher, /backend\\supabase\\migrations\\manifest[.]json/);
  assert.match(deployer, /backend\/supabase\/migrations\/manifest[.]json/);
});

test('deployer records the dedicated publisher and its contract as privileged tooling', () => {
  assert.match(deployer, /'scripts\/Publish-LocalEdgeOsShell\.ps1'/);
  assert.match(deployer, /'scripts\/os-shell-component-publisher\.test\.mjs'/);
});

test('deployer follows the exact live Backend migration authority across component overrides', () => {
  assert.match(deployer, /function Get-SourceMigrationEvidence/);
  assert.match(deployer, /\$migrationAuthority = Get-SourceMigrationEvidence -Revision \(\[string\]\$backendEvidence[.]sourceRevision\)/);
  assert.match(deployer, /rev-parse "\$\(\$backendEvidence[.]sourceRevision\):backend\/supabase\/migrations\/manifest[.]json"/);
  assert.match(deployer, /-SourceRevision \(\[string\]\$backendEvidence[.]sourceRevision\)/);
  assert.match(deployer, /Assert-MigrationAuthorityCompatible -Authority \$migrationAuthority -Candidate \$sourceMigration/);
  assert.match(deployer, /\$candidateEntries[.]Count -gt \$authorityEntries[.]Count/);
  assert.match(deployer, /candidateEntry[.]sha256 -ne \[string\]\$authorityEntry[.]sha256/);
  assert.match(deployer, /Assert-MigrationAuthorityMatch -Authority \$sourceMigration/);
  assert.match(deployer, /featureOperationEvidence = \[ordered\]@\{[\s\S]*sourceRevision = \$migrationLedgerSourceRevision/);
  assert.doesNotMatch(deployer, /featureOperationEvidence = \[ordered\]@\{[\s\S]*sourceRevision = \[string\]\$consoleEvidence[.]sourceRevision/);
  assert.doesNotMatch(deployer, /latestMigrationId -ne '0062'/);
  assert.match(deployer, /Runtime override source/);
  assert.match(deployer, /Console override source/);
  assert.match(deployer, /AllowPlatformReleaseTag/);
  assert.match(deployer, /backendEvidence[.]PSObject[.]Properties\['artifacts'\]/);
  assert.doesNotMatch(deployer, /backendEvidence[.]artifacts/);
  assert.doesNotMatch(deployer, /override changes the base Supabase migration lineage/);
  assert.doesNotMatch(deployer, /Runtime override SourceRevision is not a descendant of the base OS Shell publication/);
});
