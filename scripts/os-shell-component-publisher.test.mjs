import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const publisher = readFileSync(new URL('./Publish-LocalEdgeOsShell.ps1', import.meta.url), 'utf8');
const generalPublisher = readFileSync(new URL('./Publish-LocalEdge.ps1', import.meta.url), 'utf8');
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

test('deployer records the dedicated publisher and its contract as privileged tooling', () => {
  assert.match(deployer, /'scripts\/Publish-LocalEdgeOsShell\.ps1'/);
  assert.match(deployer, /'scripts\/os-shell-component-publisher\.test\.mjs'/);
});
